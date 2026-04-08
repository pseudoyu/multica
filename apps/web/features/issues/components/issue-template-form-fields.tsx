"use client";

import { useMemo, useState } from "react";
import { ChevronDown, Plus, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Input } from "@/components/ui/input";
import {
  ISSUE_TEMPLATE_TYPE_OPTIONS,
  type IssueTemplateDraft,
  type IssueTemplateValidationErrors,
  getIssueTemplateTypeClassName,
  getIssueTemplateTypeOption,
  getIssueTemplateLabelClassName,
} from "@/features/issues/utils/template";

function FieldShell({
  label,
  error,
  required = false,
  className,
  children,
}: {
  label: string;
  error?: string;
  required?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <div className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
        <span>{label}</span>
        {required ? <span className="text-destructive">*</span> : null}
      </div>
      {children}
      {error ? (
        <p className="text-xs text-destructive">{error}</p>
      ) : null}
    </div>
  );
}

export function IssueTemplateFormFields({
  value,
  onChange,
  errors,
  typeOptions = [],
  moduleOptions = [],
  disabled = false,
}: {
  value: IssueTemplateDraft;
  onChange: (patch: Partial<IssueTemplateDraft>) => void;
  errors?: IssueTemplateValidationErrors;
  typeOptions?: string[];
  moduleOptions?: string[];
  disabled?: boolean;
}) {
  const [pendingLabel, setPendingLabel] = useState("");
  const [typeOpen, setTypeOpen] = useState(false);
  const [typeQuery, setTypeQuery] = useState("");
  const [moduleOpen, setModuleOpen] = useState(false);
  const [moduleQuery, setModuleQuery] = useState("");

  const selectedType = useMemo(() => {
    if (!value.type) return null;
    const preset = getIssueTemplateTypeOption(value.type);
    if (preset) return preset;
    return {
      value: value.type,
      label: value.type,
      description: "Custom workspace type",
      className: getIssueTemplateTypeClassName(value.type),
    };
  }, [value.type]);
  const defaultTypeOptions = new Set<string>(
    ISSUE_TEMPLATE_TYPE_OPTIONS.map((option) => option.value),
  );
  const workspaceTypeOptions = typeOptions.filter(
    (option) => !defaultTypeOptions.has(option),
  );
  const filteredDefaultTypeOptions = useMemo(() => {
    const query = typeQuery.trim().toLowerCase();
    if (!query) return ISSUE_TEMPLATE_TYPE_OPTIONS;
    return ISSUE_TEMPLATE_TYPE_OPTIONS.filter((option) =>
      option.label.toLowerCase().includes(query) ||
      option.value.toLowerCase().includes(query),
    );
  }, [typeQuery]);
  const filteredWorkspaceTypeOptions = useMemo(() => {
    const query = typeQuery.trim().toLowerCase();
    if (!query) return workspaceTypeOptions;
    return workspaceTypeOptions.filter((option) =>
      option.toLowerCase().includes(query),
    );
  }, [typeQuery, workspaceTypeOptions]);
  const normalizedTypeQuery = typeQuery.trim().replace(/\s+/g, " ");
  const hasExactTypeMatch = typeOptions.some(
    (option) => option.toLowerCase() === normalizedTypeQuery.toLowerCase(),
  );
  const filteredModuleOptions = useMemo(() => {
    const query = moduleQuery.trim().toLowerCase();
    if (!query) return moduleOptions;
    return moduleOptions.filter((option) =>
      option.toLowerCase().includes(query),
    );
  }, [moduleOptions, moduleQuery]);
  const normalizedModuleQuery = moduleQuery.trim().replace(/\s+/g, " ");
  const hasExactModuleMatch = moduleOptions.some(
    (option) => option.toLowerCase() === normalizedModuleQuery.toLowerCase(),
  );

  const addLabel = (rawLabel: string) => {
    const nextLabel = rawLabel.trim().replace(/\s+/g, " ");
    if (!nextLabel) return;
    if (value.labels.some((label) => label.toLowerCase() === nextLabel.toLowerCase())) {
      setPendingLabel("");
      return;
    }
    if (value.labels.length >= 3) {
      setPendingLabel("");
      return;
    }
    onChange({ labels: [...value.labels, nextLabel] });
    setPendingLabel("");
  };

  const removeLabel = (labelToRemove: string) => {
    onChange({
      labels: value.labels.filter((label) => label !== labelToRemove),
    });
  };

  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
      <FieldShell label="Type" required error={errors?.type}>
        <Popover
          open={typeOpen}
          onOpenChange={(open) => {
            setTypeOpen(open);
            if (!open) setTypeQuery("");
          }}
        >
          <PopoverTrigger
            render={
              <Button
                variant="outline"
                className={cn(
                  "h-9 w-full justify-between",
                  errors?.type && "border-destructive/40 focus-visible:ring-destructive/20",
                )}
                disabled={disabled}
              >
                {selectedType ? (
                  <Badge variant="outline" className={selectedType.className}>
                    {selectedType.label}
                  </Badge>
                ) : (
                  <span className="text-muted-foreground">Select or create type</span>
                )}
                <ChevronDown className="size-4 text-muted-foreground" />
              </Button>
            }
          />
          <PopoverContent align="start" className="w-72 p-0">
            <Command>
              <CommandInput
                placeholder="Search or create type..."
                value={typeQuery}
                onValueChange={setTypeQuery}
              />
              <CommandList className="max-h-56">
                <CommandEmpty>No types found</CommandEmpty>
                {normalizedTypeQuery && !hasExactTypeMatch ? (
                  <CommandGroup heading="Create">
                    <CommandItem
                      onSelect={() => {
                        onChange({ type: normalizedTypeQuery });
                        setTypeOpen(false);
                      }}
                    >
                      <Plus className="size-4" />
                      Create "{normalizedTypeQuery}"
                    </CommandItem>
                  </CommandGroup>
                ) : null}
                {filteredDefaultTypeOptions.length > 0 ? (
                  <CommandGroup heading="Recommended">
                    {filteredDefaultTypeOptions.map((option) => (
                      <CommandItem
                        key={option.value}
                        onSelect={() => {
                          onChange({ type: option.value });
                          setTypeOpen(false);
                        }}
                      >
                        <div className="flex min-w-0 flex-col gap-0.5">
                          <Badge variant="outline" className={cn("w-fit", option.className)}>
                            {option.label}
                          </Badge>
                          <span className="text-xs text-muted-foreground">
                            {option.description}
                          </span>
                        </div>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                ) : null}
                {filteredWorkspaceTypeOptions.length > 0 ? (
                  <CommandGroup heading="Workspace types">
                    {filteredWorkspaceTypeOptions.map((option) => (
                      <CommandItem
                        key={option}
                        onSelect={() => {
                          onChange({ type: option });
                          setTypeOpen(false);
                        }}
                      >
                        <Badge
                          variant="outline"
                          className={getIssueTemplateTypeClassName(option)}
                        >
                          {option}
                        </Badge>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                ) : null}
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
      </FieldShell>

      <FieldShell label="Version" error={errors?.version}>
        <Input
          value={value.version}
          onChange={(event) => onChange({ version: event.target.value })}
          placeholder="Optional, e.g. v1.3.1"
          className={cn(errors?.version && "border-destructive/40 focus-visible:ring-destructive/20")}
          disabled={disabled}
        />
      </FieldShell>

      <FieldShell label="Module" required error={errors?.module}>
        <Popover
          open={moduleOpen}
          onOpenChange={(open) => {
            setModuleOpen(open);
            if (!open) setModuleQuery("");
          }}
        >
          <PopoverTrigger
            render={
              <Button
                variant="outline"
                className={cn(
                  "h-9 w-full justify-between",
                  errors?.module && "border-destructive/40 focus-visible:ring-destructive/20",
                )}
                disabled={disabled}
              >
                <span className={cn("truncate", !value.module && "text-muted-foreground")}>
                  {value.module || "Select or create module"}
                </span>
                <ChevronDown className="size-4 text-muted-foreground" />
              </Button>
            }
          />
          <PopoverContent align="start" className="w-72 p-0">
            <Command>
              <CommandInput
                placeholder="Search or create module..."
                value={moduleQuery}
                onValueChange={setModuleQuery}
              />
              <CommandList className="max-h-56">
                <CommandEmpty>No modules found</CommandEmpty>
                {normalizedModuleQuery && !hasExactModuleMatch ? (
                  <CommandGroup heading="Create">
                    <CommandItem
                      onSelect={() => {
                        onChange({ module: normalizedModuleQuery });
                        setModuleOpen(false);
                      }}
                    >
                      <Plus className="size-4" />
                      Create "{normalizedModuleQuery}"
                    </CommandItem>
                  </CommandGroup>
                ) : null}
                {filteredModuleOptions.length > 0 ? (
                  <CommandGroup heading="Workspace modules">
                    {filteredModuleOptions.map((option) => (
                      <CommandItem
                        key={option}
                        onSelect={() => {
                          onChange({ module: option });
                          setModuleOpen(false);
                        }}
                      >
                        {option}
                      </CommandItem>
                    ))}
                  </CommandGroup>
                ) : null}
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
      </FieldShell>

      <FieldShell label="Labels" error={errors?.labels} className="md:col-span-2">
        <div
          className={cn(
            "flex min-h-9 flex-wrap items-center gap-1 rounded-lg border bg-background px-2 py-1.5 transition-colors focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50",
            errors?.labels && "border-destructive/40 focus-within:ring-destructive/20",
          )}
        >
          {value.labels.map((label) => (
            <Badge
              key={label}
              variant="outline"
              className={cn("gap-1 pl-2", getIssueTemplateLabelClassName(label))}
            >
              {label}
              <button
                type="button"
                className="rounded-full p-0.5 hover:bg-black/5"
                onClick={() => removeLabel(label)}
                disabled={disabled}
              >
                <X className="size-3" />
              </button>
            </Badge>
          ))}
          <input
            value={pendingLabel}
            onChange={(event) => setPendingLabel(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === "," || event.key === "Tab") {
                if (!pendingLabel.trim()) return;
                event.preventDefault();
                addLabel(pendingLabel);
              }
              if (
                event.key === "Backspace" &&
                !pendingLabel &&
                value.labels.length > 0
              ) {
                removeLabel(value.labels[value.labels.length - 1]!);
              }
            }}
            onBlur={() => addLabel(pendingLabel)}
            placeholder={
              value.labels.length >= 3
                ? "Up to 3 labels"
                : value.labels.length === 0
                  ? "Optional labels, press Enter to add"
                  : "Add label"
            }
            className="min-w-32 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            disabled={disabled}
          />
          {!pendingLabel && value.labels.length === 0 ? (
            <Plus className="size-3.5 text-muted-foreground" />
          ) : null}
        </div>
      </FieldShell>
    </div>
  );
}
