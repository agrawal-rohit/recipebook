import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/cn";

export function Eyebrow({
  className,
  ...props
}: HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn("ui-eyebrow", className)} {...props} />;
}

export function Panel({
  className,
  title,
  children,
  ...props
}: HTMLAttributes<HTMLElement> & { title?: ReactNode }) {
  return (
    <section className={cn("ui-panel", className)} {...props}>
      {title ? <h2 className="ui-panel-title">{title}</h2> : null}
      {children}
    </section>
  );
}

export type ChipTone = "default" | "amber" | "rose" | "muted";

export function Chip({
  className,
  tone = "default",
  ...props
}: HTMLAttributes<HTMLSpanElement> & { tone?: ChipTone }) {
  return (
    <span
      className={cn("ui-chip", className)}
      data-tone={tone === "default" ? undefined : tone}
      {...props}
    />
  );
}

export function ChipRow({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("ui-chip-row", className)} {...props} />;
}

export function PhasePill({
  className,
  ...props
}: HTMLAttributes<HTMLSpanElement>) {
  return <span className={cn("ui-phase-pill", className)} {...props} />;
}

export function EmptyHint({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("ui-empty-hint", className)} {...props} />;
}

export type FindingKind = "bug-risk" | "hotspot" | "redundancy";

export function FindingChip({
  className,
  kind,
  ...props
}: HTMLAttributes<HTMLSpanElement> & { kind: FindingKind }) {
  return (
    <span
      className={cn("ui-finding-chip", className)}
      data-kind={kind}
      {...props}
    />
  );
}

export function Note({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("ui-note", className)} {...props} />;
}
