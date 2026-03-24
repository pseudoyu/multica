package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

const (
	defaultServerURL         = "ws://localhost:8080/ws"
	defaultDaemonConfigPath  = ".multica/daemon.json"
	defaultPollInterval      = 3 * time.Second
	defaultHeartbeatInterval = 15 * time.Second
	defaultCodexTimeout      = 20 * time.Minute
	defaultRuntimeName       = "Local Codex"
	defaultCodexPath         = "codex"
)

type config struct {
	ServerBaseURL     string
	ConfigPath        string
	WorkspaceID       string
	WorkspaceFromDisk bool
	DaemonID          string
	DeviceName        string
	RuntimeName       string
	CodexPath         string
	CodexModel        string
	DefaultWorkdir    string
	PollInterval      time.Duration
	HeartbeatInterval time.Duration
	CodexTimeout      time.Duration
}

type daemon struct {
	cfg    config
	client *daemonClient
	logger *log.Logger
}

type daemonClient struct {
	baseURL string
	client  *http.Client
}

type requestError struct {
	Method     string
	Path       string
	StatusCode int
	Body       string
}

func (e *requestError) Error() string {
	return fmt.Sprintf("%s %s returned %d: %s", e.Method, e.Path, e.StatusCode, e.Body)
}

type daemonRuntime struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Provider string `json:"provider"`
	Status   string `json:"status"`
}

type daemonPairingSession struct {
	Token          string  `json:"token"`
	DaemonID       string  `json:"daemon_id"`
	DeviceName     string  `json:"device_name"`
	RuntimeName    string  `json:"runtime_name"`
	RuntimeType    string  `json:"runtime_type"`
	RuntimeVersion string  `json:"runtime_version"`
	WorkspaceID    *string `json:"workspace_id"`
	Status         string  `json:"status"`
	ApprovedAt     *string `json:"approved_at"`
	ClaimedAt      *string `json:"claimed_at"`
	ExpiresAt      string  `json:"expires_at"`
	LinkURL        *string `json:"link_url"`
}

type daemonPersistedConfig struct {
	WorkspaceID string `json:"workspace_id"`
}

type daemonTask struct {
	ID      string            `json:"id"`
	AgentID string            `json:"agent_id"`
	IssueID string            `json:"issue_id"`
	Context daemonTaskContext `json:"context"`
}

type daemonTaskContext struct {
	Issue   daemonIssueContext   `json:"issue"`
	Agent   daemonAgentContext   `json:"agent"`
	Runtime daemonRuntimeContext `json:"runtime"`
}

type daemonIssueContext struct {
	ID                 string         `json:"id"`
	Title              string         `json:"title"`
	Description        string         `json:"description"`
	AcceptanceCriteria []string       `json:"acceptance_criteria"`
	ContextRefs        []string       `json:"context_refs"`
	Repository         *daemonRepoRef `json:"repository"`
}

type daemonAgentContext struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Skills string `json:"skills"`
}

type daemonRuntimeContext struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	Provider   string `json:"provider"`
	DeviceInfo string `json:"device_info"`
}

type daemonRepoRef struct {
	URL    string `json:"url"`
	Branch string `json:"branch"`
	Path   string `json:"path"`
}

type codexTaskResult struct {
	Status  string `json:"status"`
	Comment string `json:"comment"`
}

func loadConfig() (config, error) {
	serverBaseURL, err := normalizeServerBaseURL(envOrDefault("MULTICA_SERVER_URL", defaultServerURL))
	if err != nil {
		return config{}, err
	}

	configPath, err := resolveDaemonConfigPath(strings.TrimSpace(os.Getenv("MULTICA_DAEMON_CONFIG")))
	if err != nil {
		return config{}, err
	}
	persisted, err := loadPersistedDaemonConfig(configPath)
	if err != nil {
		return config{}, err
	}
	workspaceID := strings.TrimSpace(os.Getenv("MULTICA_WORKSPACE_ID"))
	workspaceFromDisk := false
	if workspaceID == "" {
		workspaceID = persisted.WorkspaceID
		workspaceFromDisk = workspaceID != ""
	}

	codexPath := envOrDefault("MULTICA_CODEX_PATH", defaultCodexPath)
	if _, err := exec.LookPath(codexPath); err != nil {
		return config{}, fmt.Errorf("codex executable not found at %q: %w", codexPath, err)
	}

	host, err := os.Hostname()
	if err != nil || strings.TrimSpace(host) == "" {
		host = "local-machine"
	}

	defaultWorkdir := strings.TrimSpace(os.Getenv("MULTICA_CODEX_WORKDIR"))
	if defaultWorkdir == "" {
		defaultWorkdir, err = os.Getwd()
		if err != nil {
			return config{}, fmt.Errorf("resolve working directory: %w", err)
		}
	}
	defaultWorkdir, err = filepath.Abs(defaultWorkdir)
	if err != nil {
		return config{}, fmt.Errorf("resolve absolute workdir: %w", err)
	}

	pollInterval, err := durationFromEnv("MULTICA_DAEMON_POLL_INTERVAL", defaultPollInterval)
	if err != nil {
		return config{}, err
	}
	heartbeatInterval, err := durationFromEnv("MULTICA_DAEMON_HEARTBEAT_INTERVAL", defaultHeartbeatInterval)
	if err != nil {
		return config{}, err
	}
	codexTimeout, err := durationFromEnv("MULTICA_CODEX_TIMEOUT", defaultCodexTimeout)
	if err != nil {
		return config{}, err
	}

	return config{
		ServerBaseURL:     serverBaseURL,
		ConfigPath:        configPath,
		WorkspaceID:       workspaceID,
		WorkspaceFromDisk: workspaceFromDisk,
		DaemonID:          envOrDefault("MULTICA_DAEMON_ID", host),
		DeviceName:        envOrDefault("MULTICA_DAEMON_DEVICE_NAME", host),
		RuntimeName:       envOrDefault("MULTICA_CODEX_RUNTIME_NAME", defaultRuntimeName),
		CodexPath:         codexPath,
		CodexModel:        strings.TrimSpace(os.Getenv("MULTICA_CODEX_MODEL")),
		DefaultWorkdir:    defaultWorkdir,
		PollInterval:      pollInterval,
		HeartbeatInterval: heartbeatInterval,
		CodexTimeout:      codexTimeout,
	}, nil
}

func newDaemon(cfg config, logger *log.Logger) *daemon {
	return &daemon{
		cfg:    cfg,
		client: &daemonClient{baseURL: cfg.ServerBaseURL, client: &http.Client{Timeout: 30 * time.Second}},
		logger: logger,
	}
}

func (d *daemon) run(ctx context.Context) error {
	d.logger.Printf("starting daemon for workspace=%s server=%s runtime=%s workdir=%s",
		d.cfg.WorkspaceID, d.cfg.ServerBaseURL, d.cfg.RuntimeName, d.cfg.DefaultWorkdir)

	if strings.TrimSpace(d.cfg.WorkspaceID) == "" {
		workspaceID, err := d.ensurePaired(ctx)
		if err != nil {
			return err
		}
		d.cfg.WorkspaceID = workspaceID
		d.logger.Printf("pairing completed for workspace=%s", workspaceID)
	}

	runtime, err := d.registerRuntimeWithRecovery(ctx)
	if err != nil {
		return err
	}
	d.logger.Printf("registered runtime id=%s provider=%s status=%s", runtime.ID, runtime.Provider, runtime.Status)

	go d.heartbeatLoop(ctx, runtime.ID)
	return d.pollLoop(ctx, runtime.ID)
}

func (d *daemon) registerRuntime(ctx context.Context) (daemonRuntime, error) {
	version, err := detectCodexVersion(ctx, d.cfg.CodexPath)
	if err != nil {
		return daemonRuntime{}, err
	}

	req := map[string]any{
		"workspace_id": d.cfg.WorkspaceID,
		"daemon_id":    d.cfg.DaemonID,
		"device_name":  d.cfg.DeviceName,
		"runtimes": []map[string]string{
			{
				"name":    d.cfg.RuntimeName,
				"type":    "codex",
				"version": version,
				"status":  "online",
			},
		},
	}

	var resp struct {
		Runtimes []daemonRuntime `json:"runtimes"`
	}
	if err := d.client.postJSON(ctx, "/api/daemon/register", req, &resp); err != nil {
		return daemonRuntime{}, fmt.Errorf("register runtime: %w", err)
	}
	if len(resp.Runtimes) == 0 {
		return daemonRuntime{}, fmt.Errorf("register runtime: empty response")
	}
	return resp.Runtimes[0], nil
}

func (d *daemon) registerRuntimeWithRecovery(ctx context.Context) (daemonRuntime, error) {
	runtime, err := d.registerRuntime(ctx)
	if err == nil {
		return runtime, nil
	}
	if !d.cfg.WorkspaceFromDisk || !isWorkspaceNotFoundError(err) {
		return daemonRuntime{}, err
	}

	d.logger.Printf(
		"persisted workspace=%s is no longer valid; clearing %s and starting a new pairing flow",
		d.cfg.WorkspaceID,
		d.cfg.ConfigPath,
	)
	if err := clearPersistedDaemonConfig(d.cfg.ConfigPath); err != nil {
		return daemonRuntime{}, err
	}

	d.cfg.WorkspaceID = ""
	d.cfg.WorkspaceFromDisk = false

	workspaceID, err := d.ensurePaired(ctx)
	if err != nil {
		return daemonRuntime{}, fmt.Errorf("repair stale workspace binding: %w", err)
	}
	d.cfg.WorkspaceID = workspaceID
	d.logger.Printf("pairing completed for workspace=%s", workspaceID)

	return d.registerRuntime(ctx)
}

func (d *daemon) ensurePaired(ctx context.Context) (string, error) {
	version, err := detectCodexVersion(ctx, d.cfg.CodexPath)
	if err != nil {
		return "", err
	}

	session, err := d.client.createPairingSession(ctx, map[string]string{
		"daemon_id":       d.cfg.DaemonID,
		"device_name":     d.cfg.DeviceName,
		"runtime_name":    d.cfg.RuntimeName,
		"runtime_type":    "codex",
		"runtime_version": version,
	})
	if err != nil {
		return "", fmt.Errorf("create pairing session: %w", err)
	}
	if session.LinkURL != nil {
		d.logger.Printf("open this link to pair the local Codex runtime: %s", *session.LinkURL)
	} else {
		d.logger.Printf("pairing session created: %s", session.Token)
	}

	for {
		select {
		case <-ctx.Done():
			return "", ctx.Err()
		default:
		}

		current, err := d.client.getPairingSession(ctx, session.Token)
		if err != nil {
			return "", fmt.Errorf("poll pairing session: %w", err)
		}

		switch current.Status {
		case "approved", "claimed":
			if current.WorkspaceID == nil || strings.TrimSpace(*current.WorkspaceID) == "" {
				return "", fmt.Errorf("pairing session approved without workspace")
			}
			if err := savePersistedDaemonConfig(d.cfg.ConfigPath, daemonPersistedConfig{
				WorkspaceID: strings.TrimSpace(*current.WorkspaceID),
			}); err != nil {
				return "", err
			}
			if current.Status != "claimed" {
				if _, err := d.client.claimPairingSession(ctx, current.Token); err != nil {
					return "", fmt.Errorf("claim pairing session: %w", err)
				}
			}
			return strings.TrimSpace(*current.WorkspaceID), nil
		case "expired":
			return "", fmt.Errorf("pairing session expired before approval")
		}

		if err := sleepWithContext(ctx, d.cfg.PollInterval); err != nil {
			return "", err
		}
	}
}

func (d *daemon) heartbeatLoop(ctx context.Context, runtimeID string) {
	ticker := time.NewTicker(d.cfg.HeartbeatInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			err := d.client.postJSON(ctx, "/api/daemon/heartbeat", map[string]string{
				"runtime_id": runtimeID,
			}, nil)
			if err != nil {
				d.logger.Printf("heartbeat failed: %v", err)
			}
		}
	}
}

func (d *daemon) pollLoop(ctx context.Context, runtimeID string) error {
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}

		task, err := d.client.claimTask(ctx, runtimeID)
		if err != nil {
			d.logger.Printf("claim task failed: %v", err)
			if err := sleepWithContext(ctx, d.cfg.PollInterval); err != nil {
				return err
			}
			continue
		}
		if task == nil {
			if err := sleepWithContext(ctx, d.cfg.PollInterval); err != nil {
				return err
			}
			continue
		}

		d.handleTask(ctx, *task)
	}
}

func (d *daemon) handleTask(ctx context.Context, task daemonTask) {
	d.logger.Printf("picked task=%s issue=%s title=%q", task.ID, task.IssueID, task.Context.Issue.Title)

	if err := d.client.startTask(ctx, task.ID); err != nil {
		d.logger.Printf("start task %s failed: %v", task.ID, err)
		return
	}

	_ = d.client.reportProgress(ctx, task.ID, "Launching Codex", 1, 2)

	result, err := d.runTask(ctx, task)
	if err != nil {
		d.logger.Printf("task %s failed: %v", task.ID, err)
		if failErr := d.client.failTask(ctx, task.ID, err.Error()); failErr != nil {
			d.logger.Printf("fail task %s callback failed: %v", task.ID, failErr)
		}
		return
	}

	_ = d.client.reportProgress(ctx, task.ID, "Finishing task", 2, 2)

	switch result.Status {
	case "blocked":
		if err := d.client.failTask(ctx, task.ID, result.Comment); err != nil {
			d.logger.Printf("report blocked task %s failed: %v", task.ID, err)
		}
	default:
		if err := d.client.completeTask(ctx, task.ID, result.Comment); err != nil {
			d.logger.Printf("complete task %s failed: %v", task.ID, err)
		}
	}
}

func (d *daemon) runTask(ctx context.Context, task daemonTask) (codexTaskResult, error) {
	workdir, err := resolveTaskWorkdir(d.cfg.DefaultWorkdir, task.Context.Issue.Repository)
	if err != nil {
		return codexTaskResult{}, err
	}

	prompt := buildCodexPrompt(task, workdir)
	runCtx, cancel := context.WithTimeout(ctx, d.cfg.CodexTimeout)
	defer cancel()

	model := d.cfg.CodexModel
	if model == "" {
		model = "default"
	}

	startedAt := time.Now()
	d.logger.Printf(
		"starting codex exec task=%s workdir=%s model=%s timeout=%s",
		task.ID,
		workdir,
		model,
		d.cfg.CodexTimeout,
	)

	result, err := runCodexExec(runCtx, d.cfg, workdir, prompt)
	if err != nil {
		d.logger.Printf(
			"codex exec failed task=%s duration=%s err=%v",
			task.ID,
			time.Since(startedAt).Round(time.Millisecond),
			err,
		)
		if errors.Is(runCtx.Err(), context.DeadlineExceeded) {
			return codexTaskResult{}, fmt.Errorf("Codex timed out after %s", d.cfg.CodexTimeout)
		}
		return codexTaskResult{}, err
	}

	d.logger.Printf(
		"codex exec finished task=%s duration=%s status=%s",
		task.ID,
		time.Since(startedAt).Round(time.Millisecond),
		result.Status,
	)
	return result, nil
}

func runCodexExec(ctx context.Context, cfg config, workdir, prompt string) (codexTaskResult, error) {
	outputFile, err := os.CreateTemp("", "multica-codex-output-*.json")
	if err != nil {
		return codexTaskResult{}, fmt.Errorf("create codex output file: %w", err)
	}
	outputPath := outputFile.Name()
	outputFile.Close()
	defer os.Remove(outputPath)

	schemaFile, err := os.CreateTemp("", "multica-codex-schema-*.json")
	if err != nil {
		return codexTaskResult{}, fmt.Errorf("create schema file: %w", err)
	}
	schemaPath := schemaFile.Name()
	if _, err := schemaFile.WriteString(codexResultSchema); err != nil {
		schemaFile.Close()
		return codexTaskResult{}, fmt.Errorf("write schema file: %w", err)
	}
	schemaFile.Close()
	defer os.Remove(schemaPath)

	args := []string{
		"-a", "never",
		"exec",
		"--skip-git-repo-check",
		"--sandbox", "workspace-write",
		"-C", workdir,
		"--output-schema", schemaPath,
		"-o", outputPath,
		prompt,
	}
	if cfg.CodexModel != "" {
		args = append([]string{"-m", cfg.CodexModel}, args...)
	}

	cmd := exec.CommandContext(ctx, cfg.CodexPath, args...)
	var output bytes.Buffer
	cmd.Stdout = &output
	cmd.Stderr = &output

	if err := cmd.Run(); err != nil {
		return codexTaskResult{}, fmt.Errorf("codex exec failed: %w\n%s", err, strings.TrimSpace(output.String()))
	}

	data, err := os.ReadFile(outputPath)
	if err != nil {
		return codexTaskResult{}, fmt.Errorf("read codex result: %w", err)
	}

	var result codexTaskResult
	if err := json.Unmarshal(data, &result); err != nil {
		return codexTaskResult{}, fmt.Errorf("parse codex result: %w", err)
	}
	if result.Comment == "" {
		return codexTaskResult{}, fmt.Errorf("codex returned empty comment")
	}
	if result.Status == "" {
		result.Status = "completed"
	}

	return result, nil
}

func buildCodexPrompt(task daemonTask, workdir string) string {
	var b strings.Builder
	b.WriteString("You are running as the local Codex runtime for a Multica agent.\n")
	b.WriteString("Complete the assigned issue using the local environment.\n")
	b.WriteString("Return a concise Markdown comment suitable for posting back to the issue.\n")
	b.WriteString("If you cannot complete the task because context, files, or permissions are missing, return status \"blocked\" and explain the blocker in the comment.\n\n")

	fmt.Fprintf(&b, "Working directory: %s\n", workdir)
	fmt.Fprintf(&b, "Agent: %s\n", task.Context.Agent.Name)
	fmt.Fprintf(&b, "Issue title: %s\n\n", task.Context.Issue.Title)

	if task.Context.Issue.Description != "" {
		b.WriteString("Issue description:\n")
		b.WriteString(task.Context.Issue.Description)
		b.WriteString("\n\n")
	}

	if len(task.Context.Issue.AcceptanceCriteria) > 0 {
		b.WriteString("Acceptance criteria:\n")
		for _, item := range task.Context.Issue.AcceptanceCriteria {
			fmt.Fprintf(&b, "- %s\n", item)
		}
		b.WriteString("\n")
	}

	if len(task.Context.Issue.ContextRefs) > 0 {
		b.WriteString("Context refs:\n")
		for _, item := range task.Context.Issue.ContextRefs {
			fmt.Fprintf(&b, "- %s\n", item)
		}
		b.WriteString("\n")
	}

	if repo := task.Context.Issue.Repository; repo != nil {
		b.WriteString("Repository context:\n")
		if repo.URL != "" {
			fmt.Fprintf(&b, "- url: %s\n", repo.URL)
		}
		if repo.Branch != "" {
			fmt.Fprintf(&b, "- branch: %s\n", repo.Branch)
		}
		if repo.Path != "" {
			fmt.Fprintf(&b, "- path: %s\n", repo.Path)
		}
		b.WriteString("\n")
	}

	if task.Context.Agent.Skills != "" {
		b.WriteString("Agent skills/instructions:\n")
		b.WriteString(task.Context.Agent.Skills)
		b.WriteString("\n\n")
	}

	b.WriteString("Comment requirements:\n")
	b.WriteString("- Lead with the outcome.\n")
	b.WriteString("- Mention concrete files or commands if you changed anything.\n")
	b.WriteString("- Mention blockers or follow-up actions if relevant.\n")

	return b.String()
}

func resolveTaskWorkdir(defaultWorkdir string, repo *daemonRepoRef) (string, error) {
	base := defaultWorkdir
	if repo == nil || strings.TrimSpace(repo.Path) == "" {
		return base, nil
	}

	path := strings.TrimSpace(repo.Path)
	if !filepath.IsAbs(path) {
		path = filepath.Join(base, path)
	}
	path = filepath.Clean(path)

	info, err := os.Stat(path)
	if err != nil {
		return "", fmt.Errorf("repository path not found: %s", path)
	}
	if !info.IsDir() {
		return "", fmt.Errorf("repository path is not a directory: %s", path)
	}
	return path, nil
}

func detectCodexVersion(ctx context.Context, codexPath string) (string, error) {
	cmd := exec.CommandContext(ctx, codexPath, "--version")
	data, err := cmd.Output()
	if err != nil {
		return "", fmt.Errorf("detect codex version: %w", err)
	}
	return strings.TrimSpace(string(data)), nil
}

func resolveDaemonConfigPath(raw string) (string, error) {
	if raw != "" {
		return filepath.Abs(raw)
	}

	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("resolve daemon config path: %w", err)
	}
	return filepath.Join(home, defaultDaemonConfigPath), nil
}

func loadPersistedDaemonConfig(path string) (daemonPersistedConfig, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return daemonPersistedConfig{}, nil
		}
		return daemonPersistedConfig{}, fmt.Errorf("read daemon config: %w", err)
	}

	var cfg daemonPersistedConfig
	if err := json.Unmarshal(data, &cfg); err != nil {
		return daemonPersistedConfig{}, fmt.Errorf("parse daemon config: %w", err)
	}
	return cfg, nil
}

func savePersistedDaemonConfig(path string, cfg daemonPersistedConfig) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return fmt.Errorf("create daemon config directory: %w", err)
	}
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return fmt.Errorf("encode daemon config: %w", err)
	}
	if err := os.WriteFile(path, append(data, '\n'), 0o600); err != nil {
		return fmt.Errorf("write daemon config: %w", err)
	}
	return nil
}

func clearPersistedDaemonConfig(path string) error {
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("remove daemon config: %w", err)
	}
	return nil
}

func isWorkspaceNotFoundError(err error) bool {
	var reqErr *requestError
	if !errors.As(err, &reqErr) {
		return false
	}
	if reqErr.StatusCode != http.StatusNotFound {
		return false
	}
	return strings.Contains(strings.ToLower(reqErr.Body), "workspace not found")
}

func normalizeServerBaseURL(raw string) (string, error) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return "", fmt.Errorf("invalid MULTICA_SERVER_URL: %w", err)
	}
	switch u.Scheme {
	case "ws":
		u.Scheme = "http"
	case "wss":
		u.Scheme = "https"
	case "http", "https":
	default:
		return "", fmt.Errorf("MULTICA_SERVER_URL must use ws, wss, http, or https")
	}
	if u.Path == "/ws" {
		u.Path = ""
	}
	u.RawPath = ""
	u.RawQuery = ""
	u.Fragment = ""
	return strings.TrimRight(u.String(), "/"), nil
}

func durationFromEnv(key string, fallback time.Duration) (time.Duration, error) {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback, nil
	}
	d, err := time.ParseDuration(value)
	if err != nil {
		return 0, fmt.Errorf("%s: invalid duration %q: %w", key, value, err)
	}
	return d, nil
}

func envOrDefault(key, fallback string) string {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback
	}
	return value
}

func sleepWithContext(ctx context.Context, d time.Duration) error {
	timer := time.NewTimer(d)
	defer timer.Stop()

	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func (c *daemonClient) claimTask(ctx context.Context, runtimeID string) (*daemonTask, error) {
	var resp struct {
		Task *daemonTask `json:"task"`
	}
	if err := c.postJSON(ctx, fmt.Sprintf("/api/daemon/runtimes/%s/tasks/claim", runtimeID), map[string]any{}, &resp); err != nil {
		return nil, err
	}
	return resp.Task, nil
}

func (c *daemonClient) createPairingSession(ctx context.Context, req map[string]string) (daemonPairingSession, error) {
	var resp daemonPairingSession
	if err := c.postJSON(ctx, "/api/daemon/pairing-sessions", req, &resp); err != nil {
		return daemonPairingSession{}, err
	}
	return resp, nil
}

func (c *daemonClient) getPairingSession(ctx context.Context, token string) (daemonPairingSession, error) {
	var resp daemonPairingSession
	if err := c.getJSON(ctx, fmt.Sprintf("/api/daemon/pairing-sessions/%s", url.PathEscape(token)), &resp); err != nil {
		return daemonPairingSession{}, err
	}
	return resp, nil
}

func (c *daemonClient) claimPairingSession(ctx context.Context, token string) (daemonPairingSession, error) {
	var resp daemonPairingSession
	if err := c.postJSON(ctx, fmt.Sprintf("/api/daemon/pairing-sessions/%s/claim", url.PathEscape(token)), map[string]any{}, &resp); err != nil {
		return daemonPairingSession{}, err
	}
	return resp, nil
}

func (c *daemonClient) startTask(ctx context.Context, taskID string) error {
	return c.postJSON(ctx, fmt.Sprintf("/api/daemon/tasks/%s/start", taskID), map[string]any{}, nil)
}

func (c *daemonClient) reportProgress(ctx context.Context, taskID, summary string, step, total int) error {
	return c.postJSON(ctx, fmt.Sprintf("/api/daemon/tasks/%s/progress", taskID), map[string]any{
		"summary": summary,
		"step":    step,
		"total":   total,
	}, nil)
}

func (c *daemonClient) completeTask(ctx context.Context, taskID, output string) error {
	return c.postJSON(ctx, fmt.Sprintf("/api/daemon/tasks/%s/complete", taskID), map[string]any{
		"output": output,
	}, nil)
}

func (c *daemonClient) failTask(ctx context.Context, taskID, errMsg string) error {
	return c.postJSON(ctx, fmt.Sprintf("/api/daemon/tasks/%s/fail", taskID), map[string]any{
		"error": errMsg,
	}, nil)
}

func (c *daemonClient) postJSON(ctx context.Context, path string, reqBody any, respBody any) error {
	var body io.Reader
	if reqBody != nil {
		data, err := json.Marshal(reqBody)
		if err != nil {
			return err
		}
		body = bytes.NewReader(data)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+path, body)
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 400 {
		data, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return &requestError{
			Method:     http.MethodPost,
			Path:       path,
			StatusCode: resp.StatusCode,
			Body:       strings.TrimSpace(string(data)),
		}
	}
	if respBody == nil {
		io.Copy(io.Discard, resp.Body)
		return nil
	}
	return json.NewDecoder(resp.Body).Decode(respBody)
}

func (c *daemonClient) getJSON(ctx context.Context, path string, respBody any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.baseURL+path, nil)
	if err != nil {
		return err
	}

	resp, err := c.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 400 {
		data, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return &requestError{
			Method:     http.MethodGet,
			Path:       path,
			StatusCode: resp.StatusCode,
			Body:       strings.TrimSpace(string(data)),
		}
	}
	if respBody == nil {
		io.Copy(io.Discard, resp.Body)
		return nil
	}
	return json.NewDecoder(resp.Body).Decode(respBody)
}

const codexResultSchema = `{
  "type": "object",
  "properties": {
    "status": {
      "type": "string",
      "enum": ["completed", "blocked"]
    },
    "comment": {
      "type": "string"
    }
  },
  "required": ["status", "comment"],
  "additionalProperties": false
}`
