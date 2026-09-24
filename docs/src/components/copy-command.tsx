"use client";

import { cn } from "cn";
import { CheckIcon, CopyIcon } from "lucide-react";
import { useState } from "react";

const PACKAGE_MANAGERS = ["npx", "bunx", "pnpm", "yarn"] as const;

type PackageManager = (typeof PACKAGE_MANAGERS)[number];

function installCommand(manager: PackageManager): string {
  switch (manager) {
    case "npx":
      return "npx recipebook add";
    case "bunx":
      return "bunx recipebook add";
    case "pnpm":
      return "pnpm dlx recipebook add";
    case "yarn":
      return "yarn dlx recipebook add";
    default: {
      const _exhaustive: never = manager;
      return _exhaustive;
    }
  }
}

interface CopyCommandProps {
  readonly className?: string;
}

export function CopyCommand({ className }: CopyCommandProps) {
  const [manager, setManager] = useState<PackageManager>("npx");
  const [copied, setCopied] = useState(false);
  const command = installCommand(manager);
  const panelId = "install-command-panel";

  function selectManager(tab: PackageManager) {
    setManager(tab);
    setCopied(false);
  }

  async function onCopy() {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div
      className={cn(
        "min-w-0 w-full max-w-lg overflow-hidden rounded-lg border border-border bg-background",
        className,
      )}
    >
      <div
        role="tablist"
        aria-label="Package manager"
        className="flex flex-wrap gap-1 border-border border-b p-2"
      >
        {PACKAGE_MANAGERS.map((tab) => {
          const selected = manager === tab;
          return (
            <button
              key={tab}
              type="button"
              role="tab"
              id={`install-tab-${tab}`}
              aria-selected={selected}
              aria-controls={panelId}
              className={cn(
                "rounded-md px-2.5 py-1 text-xs transition-colors",
                selected
                  ? "bg-accent font-medium text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
              onClick={() => selectManager(tab)}
            >
              {tab}
            </button>
          );
        })}
      </div>
      <div
        id={panelId}
        role="tabpanel"
        aria-labelledby={`install-tab-${manager}`}
        className="flex items-center gap-2 px-3 py-2.5"
      >
        <code className="flex min-w-0 flex-1 items-center overflow-x-auto font-mono text-sm">
          <span className="text-destructive">$</span>
          <span className="text-foreground">{` ${command}`}</span>
        </code>
        <button
          type="button"
          className="inline-flex shrink-0 items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
          aria-label={copied ? "Copied" : "Copy command"}
          onClick={onCopy}
        >
          {copied ? (
            <CheckIcon className="size-4" />
          ) : (
            <CopyIcon className="size-4" />
          )}
        </button>
      </div>
    </div>
  );
}
