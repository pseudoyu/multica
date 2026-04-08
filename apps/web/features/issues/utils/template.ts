import { cn } from "@/lib/utils";

export type IssueTemplateType = string;
export type IssueTemplatePresetType = "bug" | "feature" | "improvement" | "task";

export interface IssueTemplateMetadata {
  type: IssueTemplateType;
  version: string;
  module: string;
  labels: string[];
}

export interface IssueTemplateDraft {
  type: IssueTemplateType | null;
  version: string;
  module: string;
  labels: string[];
}

export interface IssueTemplateValidationErrors {
  type?: string;
  version?: string;
  module?: string;
  labels?: string;
}

export interface ParsedIssueTemplateDescription {
  metadata: IssueTemplateMetadata | null;
  body: string;
  raw: string;
}

const ISSUE_TEMPLATE_MARKER = "multica:issue-template";
const ISSUE_TEMPLATE_REGEX = new RegExp(
  `^<!--\\s*${ISSUE_TEMPLATE_MARKER}\\s*([\\s\\S]*?)\\s*-->\\s*`,
);

const LABEL_CLASS_PALETTES = [
  "border-info/20 bg-info/10 text-info",
  "border-success/20 bg-success/10 text-success",
  "border-warning/20 bg-warning/10 text-warning",
  "border-brand/20 bg-brand/10 text-brand",
  "border-border bg-muted text-muted-foreground",
];

export const ISSUE_TEMPLATE_TYPE_OPTIONS: {
  value: IssueTemplatePresetType;
  label: string;
  description: string;
  className: string;
}[] = [
  {
    value: "bug",
    label: "Bug",
    description: "Something is broken and needs a fix.",
    className: "border-destructive/20 bg-destructive/10 text-destructive",
  },
  {
    value: "feature",
    label: "Feature",
    description: "A new user-facing capability or workflow.",
    className: "border-brand/20 bg-brand/10 text-brand",
  },
  {
    value: "improvement",
    label: "Improvement",
    description: "An enhancement to an existing behavior or flow.",
    className: "border-info/20 bg-info/10 text-info",
  },
  {
    value: "task",
    label: "Task",
    description: "Operational, maintenance, or support work.",
    className: "border-success/20 bg-success/10 text-success",
  },
];

const ISSUE_TEMPLATE_TYPE_LOOKUP = Object.fromEntries(
  ISSUE_TEMPLATE_TYPE_OPTIONS.map((option) => [option.value, option]),
) as Record<IssueTemplatePresetType, (typeof ISSUE_TEMPLATE_TYPE_OPTIONS)[number]>;

export function createEmptyIssueTemplateDraft(): IssueTemplateDraft {
  return {
    type: null,
    version: "",
    module: "",
    labels: [],
  };
}

export function createIssueTemplateDraft(
  metadata?: Partial<IssueTemplateMetadata> | IssueTemplateDraft | null,
): IssueTemplateDraft {
  if (!metadata) return createEmptyIssueTemplateDraft();
  return {
    type: metadata.type ?? null,
    version: metadata.version ?? "",
    module: metadata.module ?? "",
    labels: Array.isArray(metadata.labels) ? [...metadata.labels] : [],
  };
}

export function getIssueTemplateTypeOption(type: IssueTemplateType) {
  return ISSUE_TEMPLATE_TYPE_LOOKUP[type as IssueTemplatePresetType] ?? null;
}

export function normalizeIssueTemplateType(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

export function normalizeIssueTemplateVersion(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  return trimmed.replace(/^V(?=\d)/, "v");
}

export function isValidIssueTemplateVersion(value: string): boolean {
  return /^v\d+\.\d+\.\d+$/i.test(normalizeIssueTemplateVersion(value));
}

export function normalizeIssueTemplateModule(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

export function normalizeIssueTemplateLabels(labels: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const label of labels) {
    const value = label.trim().replace(/\s+/g, " ");
    if (!value) continue;

    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(value);
  }

  return normalized;
}

export function validateIssueTemplateDraft(
  draft: IssueTemplateDraft,
): IssueTemplateValidationErrors {
  const errors: IssueTemplateValidationErrors = {};
  const normalizedLabels = normalizeIssueTemplateLabels(draft.labels);

  if (!draft.type) {
    errors.type = "Choose or create a type.";
  }

  if (draft.type && !normalizeIssueTemplateType(draft.type)) {
    errors.type = "Choose or create a type.";
  }

  if (draft.version.trim() && !isValidIssueTemplateVersion(draft.version)) {
    errors.version = `Version "${draft.version.trim()}" is invalid. Use a value like v1.3.1.`;
  }

  if (!normalizeIssueTemplateModule(draft.module)) {
    errors.module = "Choose or create a module.";
  }

  if (normalizedLabels.length > 3) {
    errors.labels = "You can add up to 3 labels.";
  }

  return errors;
}

export function draftToIssueTemplateMetadata(
  draft: IssueTemplateDraft,
): IssueTemplateMetadata | null {
  const errors = validateIssueTemplateDraft(draft);
  if (Object.keys(errors).length > 0 || !draft.type) return null;

  return {
    type: normalizeIssueTemplateType(draft.type),
    version: normalizeIssueTemplateVersion(draft.version),
    module: normalizeIssueTemplateModule(draft.module),
    labels: normalizeIssueTemplateLabels(draft.labels).slice(0, 3),
  };
}

export function getIssueTemplateValidationMessage(
  errors: IssueTemplateValidationErrors,
): string {
  const messages: string[] = [];

  if (errors.type) {
    messages.push(errors.type);
  }

  if (errors.module) {
    messages.push(errors.module);
  }

  if (errors.version) {
    messages.push(errors.version);
  }

  if (errors.labels) {
    messages.push(errors.labels);
  }

  return messages.length > 0
    ? `Can't save metadata. ${messages.join(" ")}`
    : "";
}

function isValidIssueTemplateMetadata(
  value: unknown,
): value is IssueTemplateMetadata {
  if (!value || typeof value !== "object") return false;

  const candidate = value as Partial<IssueTemplateMetadata>;

  if (typeof candidate.type !== "string" || !normalizeIssueTemplateType(candidate.type)) {
    return false;
  }

  if (typeof candidate.version !== "string") {
    return false;
  }

  if (candidate.version && !isValidIssueTemplateVersion(candidate.version)) {
    return false;
  }

  if (typeof candidate.module !== "string" || !normalizeIssueTemplateModule(candidate.module)) {
    return false;
  }

  if (!Array.isArray(candidate.labels)) return false;

  const labels = normalizeIssueTemplateLabels(candidate.labels);
  return labels.length <= 3;
}

export function parseIssueTemplateDescription(
  description?: string | null,
): ParsedIssueTemplateDescription {
  const raw = description ?? "";
  if (!raw) {
    return { metadata: null, body: "", raw };
  }

  const match = raw.match(ISSUE_TEMPLATE_REGEX);
  if (!match) {
    return { metadata: null, body: raw, raw };
  }

  let metadata: IssueTemplateMetadata | null = null;
  try {
    const parsed = JSON.parse(match[1] ?? "null");
    if (isValidIssueTemplateMetadata(parsed)) {
      metadata = {
        ...parsed,
        type: normalizeIssueTemplateType(parsed.type),
        version: normalizeIssueTemplateVersion(parsed.version),
        module: normalizeIssueTemplateModule(parsed.module),
        labels: normalizeIssueTemplateLabels(parsed.labels),
      };
    }
  } catch {
    metadata = null;
  }

  const body = raw.replace(ISSUE_TEMPLATE_REGEX, "").replace(/^\n+/, "");

  if (!metadata) {
    return { metadata: null, body: raw, raw };
  }

  return { metadata, body, raw };
}

export function serializeIssueTemplateDescription(
  metadata: IssueTemplateMetadata | null,
  body?: string | null,
): string {
  const normalizedBody = body?.trim() ?? "";
  if (!metadata) return normalizedBody;

  const payload = JSON.stringify({
    type: normalizeIssueTemplateType(metadata.type),
    version: normalizeIssueTemplateVersion(metadata.version),
    module: normalizeIssueTemplateModule(metadata.module),
    labels: normalizeIssueTemplateLabels(metadata.labels),
  });

  return normalizedBody
    ? `<!-- ${ISSUE_TEMPLATE_MARKER} ${payload} -->\n\n${normalizedBody}`
    : `<!-- ${ISSUE_TEMPLATE_MARKER} ${payload} -->`;
}

export function updateIssueTemplateBody(
  description: string | null | undefined,
  body: string | null | undefined,
): string {
  const parsed = parseIssueTemplateDescription(description);
  return serializeIssueTemplateDescription(parsed.metadata, body);
}

export function updateIssueTemplateMetadata(
  description: string | null | undefined,
  metadata: IssueTemplateMetadata | null,
): string {
  const parsed = parseIssueTemplateDescription(description);
  return serializeIssueTemplateDescription(metadata, parsed.body);
}

export function getIssueTemplateSearchTerms(
  metadata: IssueTemplateMetadata | null,
): string[] {
  if (!metadata) return [];

  return [
    metadata.type,
    getIssueTemplateTypeOption(metadata.type)?.label ?? metadata.type,
    metadata.version,
    metadata.module,
    ...metadata.labels,
  ].filter(Boolean);
}

export function collectIssueTemplateTypes(
  descriptions: Array<string | null | undefined>,
): string[] {
  const types = new Set<string>();

  for (const description of descriptions) {
    const type = normalizeIssueTemplateType(
      parseIssueTemplateDescription(description).metadata?.type ?? "",
    );
    if (type) types.add(type);
  }

  return Array.from(types).sort((a, b) => a.localeCompare(b));
}

export function collectIssueTemplateModules(
  descriptions: Array<string | null | undefined>,
): string[] {
  const modules = new Set<string>();

  for (const description of descriptions) {
    const module = normalizeIssueTemplateModule(
      parseIssueTemplateDescription(description).metadata?.module ?? "",
    );
    if (module) modules.add(module);
  }

  return Array.from(modules).sort((a, b) => a.localeCompare(b));
}

function hashLabel(label: string): number {
  let hash = 0;
  for (const char of label) {
    hash = (hash * 31 + char.charCodeAt(0)) % 2147483647;
  }
  return Math.abs(hash);
}

export function getIssueTemplateLabelClassName(label: string): string {
  return LABEL_CLASS_PALETTES[hashLabel(label) % LABEL_CLASS_PALETTES.length]!;
}

export function getIssueTemplateVersionClassName() {
  return "border-info/20 bg-info/10 text-info";
}

export function getIssueTemplateModuleClassName() {
  return "border-brand/20 bg-brand/10 text-brand";
}

export function getIssueTemplateTypeClassName(type: IssueTemplateType) {
  return getIssueTemplateTypeOption(type)?.className ?? getIssueTemplateLabelClassName(type);
}

export function getIssueTemplateBadgeClassName(
  kind: "type" | "version" | "module" | "label",
  value: string,
) {
  if (kind === "type") {
    return getIssueTemplateTypeClassName(value as IssueTemplateType);
  }
  if (kind === "version") {
    return getIssueTemplateVersionClassName();
  }
  if (kind === "module") {
    return getIssueTemplateModuleClassName();
  }
  return getIssueTemplateLabelClassName(value);
}

export function getIssueTemplateBadgeText(
  kind: "type" | "version" | "module" | "label",
  value: string,
) {
  if (kind === "type") {
    return getIssueTemplateTypeOption(value as IssueTemplateType)?.label ?? value;
  }
  if (kind === "module") {
    return value;
  }
  return value;
}

export function getIssueTemplateBadgeClass(kind: "type" | "version" | "module" | "label", value: string) {
  return cn(
    "border",
    getIssueTemplateBadgeClassName(kind, value),
  );
}
