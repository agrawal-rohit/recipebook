"use client";

import { cn } from "cn";
import { useReducedMotion } from "motion/react";
import {
  AnimatedSpan,
  Terminal,
  TypingAnimation,
} from "@/components/ui/terminal";

const HERO_TERMINAL_SEQUENCE = [
  { kind: "command" as const, text: "$ npx recipebook add" },
  {
    kind: "muted" as const,
    text: "→ Registry https://example.com/registry.json",
  },
  {
    kind: "muted" as const,
    text: "→ Types ui-component · agent-skill · theme · template",
  },
  { kind: "prompt" as const, text: "? Item  pr-review  (agent-skill)" },
  { kind: "prompt" as const, text: "? Tone  concise" },
  { kind: "muted" as const, text: "→ Bindings tone=concise" },
  { kind: "muted" as const, text: "→ Plan root" },
  { kind: "muted" as const, text: "→ Integrity sha256 ok" },
  { kind: "muted" as const, text: "→ Write SKILL.md, AGENTS.md" },
  {
    kind: "brand" as const,
    text: "Item installed. Remote scripts were not executed.",
  },
] as const;

type HeroTerminalLine = (typeof HERO_TERMINAL_SEQUENCE)[number];

const HERO_TERMINAL_SURFACE =
  "h-auto max-h-none w-full border-neutral-700 bg-neutral-900 font-sans text-neutral-100 shadow-none";

function HeroTerminalLineContent({
  line,
}: {
  readonly line: HeroTerminalLine;
}) {
  const text = line.text;
  switch (text) {
    case "$ npx recipebook add":
      return (
        <>
          <span className="text-destructive">$ </span>
          <span className="text-info">npx</span>
          <span className="text-neutral-100"> recipebook </span>
          <span className="text-neutral-300">add</span>
        </>
      );
    case "→ Registry https://example.com/registry.json":
      return (
        <>
          <span className="text-neutral-500">→ Registry </span>
          <span className="text-info">https://example.com/registry.json</span>
        </>
      );
    case "→ Types ui-component · agent-skill · theme · template":
      return (
        <span className="text-neutral-500">
          → Types ui-component · agent-skill · theme · template
        </span>
      );
    case "? Item  pr-review  (agent-skill)":
      return (
        <span className="text-primary">? Item pr-review (agent-skill)</span>
      );
    case "? Tone  concise":
      return <span className="text-primary">? Tone concise</span>;
    case "→ Bindings tone=concise":
      return <span className="text-neutral-500">→ Bindings tone=concise</span>;
    case "→ Plan root":
      return <span className="text-neutral-500">→ Plan root</span>;
    case "→ Integrity sha256 ok":
      return <span className="text-neutral-500">→ Integrity sha256 ok</span>;
    case "→ Write SKILL.md, AGENTS.md":
      return (
        <>
          <span className="text-neutral-500">→ Write </span>
          <span className="text-neutral-300">SKILL.md</span>
          <span className="text-neutral-500">, </span>
          <span className="text-neutral-300">AGENTS.md</span>
        </>
      );
    case "Item installed. Remote scripts were not executed.":
      return (
        <span className="text-primary">
          Item installed. Remote scripts were not executed.
        </span>
      );
    default: {
      const _exhaustive: never = text;
      return _exhaustive;
    }
  }
}

export function HeroTerminal() {
  const reduceMotion = useReducedMotion();

  if (reduceMotion) {
    return (
      <div
        className={cn(
          "min-w-0 w-full rounded-lg border font-sans",
          HERO_TERMINAL_SURFACE,
        )}
      >
        <div className="border-neutral-700 border-b p-4">
          <div className="flex flex-row gap-x-2">
            <div className="size-2 rounded-full bg-destructive" />
            <div className="size-2 rounded-full bg-warning" />
            <div className="size-2 rounded-full bg-success" />
          </div>
        </div>
        <pre className="min-w-0 overflow-x-auto p-4 font-sans text-sm">
          <code className="grid gap-y-1">
            {HERO_TERMINAL_SEQUENCE.map((line) => (
              <span key={line.text}>
                <HeroTerminalLineContent line={line} />
              </span>
            ))}
          </code>
        </pre>
      </div>
    );
  }

  return (
    <Terminal className={HERO_TERMINAL_SURFACE} sequence startOnView>
      {HERO_TERMINAL_SEQUENCE.map((line, index) => {
        if (index === 0) {
          return (
            <div key={line.text} className="text-sm font-normal tracking-tight">
              <span className="text-destructive">$ </span>
              <TypingAnimation
                as="span"
                className="inline text-neutral-100"
                duration={28}
              >
                npx recipebook add
              </TypingAnimation>
            </div>
          );
        }
        return (
          <AnimatedSpan key={line.text}>
            <span>
              <HeroTerminalLineContent line={line} />
            </span>
          </AnimatedSpan>
        );
      })}
    </Terminal>
  );
}
