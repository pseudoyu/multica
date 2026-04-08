import { describe, expect, it } from "vitest";
import {
  createIssueTemplateDraft,
  draftToIssueTemplateMetadata,
  parseIssueTemplateDescription,
  serializeIssueTemplateDescription,
  updateIssueTemplateBody,
  updateIssueTemplateMetadata,
  validateIssueTemplateDraft,
} from "./template";

describe("issue template description", () => {
  it("serializes metadata into the description and parses it back", () => {
    const description = serializeIssueTemplateDescription(
      {
        type: "bug",
        version: "v1.3.1",
        module: "Checkout",
        labels: ["ios", "payment"],
      },
      "Body copy",
    );

    const parsed = parseIssueTemplateDescription(description);

    expect(parsed.metadata).toEqual({
      type: "bug",
      version: "v1.3.1",
      module: "Checkout",
      labels: ["ios", "payment"],
    });
    expect(parsed.body).toBe("Body copy");
  });

  it("preserves template metadata when the description body changes", () => {
    const next = updateIssueTemplateBody(
      serializeIssueTemplateDescription(
        {
          type: "feature",
          version: "v2.0.0",
          module: "Inbox",
          labels: ["web"],
        },
        "Old body",
      ),
      "New body",
    );

    const parsed = parseIssueTemplateDescription(next);
    expect(parsed.metadata?.type).toBe("feature");
    expect(parsed.body).toBe("New body");
  });

  it("replaces metadata while preserving the existing body", () => {
    const next = updateIssueTemplateMetadata(
      serializeIssueTemplateDescription(
        {
          type: "task",
          version: "v1.0.0",
          module: "Ops",
          labels: ["maintenance"],
        },
        "Same body",
      ),
      {
        type: "improvement",
        version: "v1.1.0",
        module: "Ops",
        labels: ["performance"],
      },
    );

    const parsed = parseIssueTemplateDescription(next);
    expect(parsed.metadata?.type).toBe("improvement");
    expect(parsed.body).toBe("Same body");
  });
});

describe("issue template validation", () => {
  it("requires type and module, while version and labels stay optional", () => {
    const errors = validateIssueTemplateDraft({
      type: null,
      version: "",
      module: "",
      labels: [],
    });

    expect(errors).toEqual({
      type: "Choose or create a type.",
      module: "Choose or create a module.",
    });
  });

  it("normalizes valid drafts into metadata", () => {
    const metadata = draftToIssueTemplateMetadata(
      createIssueTemplateDraft({
        type: "bug",
        version: "v1.2.3",
        module: " Settings ",
        labels: ["UX", "ux", "web"],
      }),
    );

    expect(metadata).toEqual({
      type: "bug",
      version: "v1.2.3",
      module: "Settings",
      labels: ["UX", "web"],
    });
  });

  it("accepts metadata without version and labels", () => {
    const metadata = draftToIssueTemplateMetadata({
      type: "feature",
      version: "",
      module: "Inbox",
      labels: [],
    });

    expect(metadata).toEqual({
      type: "feature",
      version: "",
      module: "Inbox",
      labels: [],
    });
  });

  it("accepts custom workspace types", () => {
    const metadata = draftToIssueTemplateMetadata({
      type: "Release blocker",
      version: "",
      module: "Checkout",
      labels: [],
    });

    expect(metadata?.type).toBe("Release blocker");
  });

  it("accepts uppercase version prefixes and normalizes them", () => {
    const metadata = draftToIssueTemplateMetadata({
      type: "feature",
      version: "V1.3.1",
      module: "Checkout",
      labels: [],
    });

    expect(metadata).toEqual({
      type: "feature",
      version: "v1.3.1",
      module: "Checkout",
      labels: [],
    });
  });
});
