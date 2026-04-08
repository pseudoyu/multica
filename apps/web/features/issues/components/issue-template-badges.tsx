"use client";

import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import {
  type IssueTemplateMetadata,
  getIssueTemplateBadgeClass,
  getIssueTemplateBadgeText,
} from "@/features/issues/utils/template";

export function IssueTemplateBadges({
  metadata,
  maxLabels,
  className = "",
  singleLine = false,
}: {
  metadata: IssueTemplateMetadata | null;
  maxLabels?: number;
  className?: string;
  singleLine?: boolean;
}) {
  if (!metadata) return null;

  const visibleLabels =
    typeof maxLabels === "number"
      ? metadata.labels.slice(0, maxLabels)
      : metadata.labels;
  const hiddenLabelCount = metadata.labels.length - visibleLabels.length;

  const renderBadge = (
    kind: "type" | "version" | "module" | "label",
    value: string,
  ) => {
    const isFlexible = singleLine && (kind === "module" || kind === "label");
    return (
      <Badge
        key={`${kind}-${value}`}
        variant="outline"
        className={cn(
          getIssueTemplateBadgeClass(kind, value),
          singleLine && "max-w-full",
          isFlexible
            ? "min-w-0 shrink max-w-[40%]"
            : singleLine
              ? "shrink-0"
              : "",
        )}
        title={value}
      >
        <span className={cn(isFlexible && "truncate")}>
          {getIssueTemplateBadgeText(kind, value)}
        </span>
      </Badge>
    );
  };

  return (
    <div
      className={cn(
        "flex items-center gap-1",
        singleLine ? "min-w-0 flex-nowrap overflow-hidden" : "flex-wrap",
        className,
      )}
    >
      {renderBadge("type", metadata.type)}
      {metadata.version ? renderBadge("version", metadata.version) : null}
      {renderBadge("module", metadata.module)}
      {visibleLabels.map((label) => renderBadge("label", label))}
      {hiddenLabelCount > 0 && (
        <Badge
          variant="outline"
          className={cn(
            "border-border bg-muted text-muted-foreground",
            singleLine && "shrink-0",
          )}
        >
          +{hiddenLabelCount}
        </Badge>
      )}
    </div>
  );
}
