package main

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestNormalizeServerBaseURL(t *testing.T) {
	t.Parallel()

	got, err := normalizeServerBaseURL("ws://localhost:8080/ws")
	if err != nil {
		t.Fatalf("normalizeServerBaseURL returned error: %v", err)
	}
	if got != "http://localhost:8080" {
		t.Fatalf("expected http://localhost:8080, got %s", got)
	}
}

func TestResolveTaskWorkdirUsesRepoPathWhenPresent(t *testing.T) {
	t.Parallel()

	root := t.TempDir()
	repoPath := filepath.Join(root, "repo")
	if err := os.Mkdir(repoPath, 0o755); err != nil {
		t.Fatalf("mkdir repo: %v", err)
	}

	got, err := resolveTaskWorkdir(root, &daemonRepoRef{Path: "repo"})
	if err != nil {
		t.Fatalf("resolveTaskWorkdir returned error: %v", err)
	}
	if got != repoPath {
		t.Fatalf("expected %s, got %s", repoPath, got)
	}
}

func TestBuildCodexPromptIncludesIssueAndSkills(t *testing.T) {
	t.Parallel()

	prompt := buildCodexPrompt(daemonTask{
		Context: daemonTaskContext{
			Issue: daemonIssueContext{
				Title:              "Fix failing test",
				Description:        "Investigate and fix the test failure.",
				AcceptanceCriteria: []string{"tests pass"},
				ContextRefs:        []string{"log snippet"},
			},
			Agent: daemonAgentContext{
				Name:   "Local Codex",
				Skills: "Be concise.",
			},
		},
	}, "/tmp/work")

	for _, want := range []string{"Fix failing test", "Investigate and fix the test failure.", "tests pass", "log snippet", "Be concise."} {
		if !strings.Contains(prompt, want) {
			t.Fatalf("prompt missing %q", want)
		}
	}
}

func TestIsWorkspaceNotFoundError(t *testing.T) {
	t.Parallel()

	err := &requestError{
		Method:     http.MethodPost,
		Path:       "/api/daemon/register",
		StatusCode: http.StatusNotFound,
		Body:       `{"error":"workspace not found"}`,
	}
	if !isWorkspaceNotFoundError(err) {
		t.Fatal("expected workspace not found error to be recognized")
	}

	if isWorkspaceNotFoundError(&requestError{StatusCode: http.StatusInternalServerError, Body: `{"error":"workspace not found"}`}) {
		t.Fatal("did not expect 500 to be treated as workspace not found")
	}
}
