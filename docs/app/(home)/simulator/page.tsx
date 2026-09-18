import type { Metadata } from "next";
import { RuntimeSimulator } from "@/components/viz/RuntimeSimulator";

export const metadata: Metadata = {
  title: "Simulator",
  description:
    "Interactive walkthrough of the Cheetos add pipeline — graph resolution, scripts, filesystem, and insights.",
};

export default function SimulatorPage() {
  return (
    <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col px-4 py-8 md:px-6">
      <header className="mb-6 max-w-2xl">
        <p className="ui-eyebrow">interactive · add pipeline</p>
        <h1
          className="mb-2 text-3xl font-semibold tracking-tight"
          style={{
            fontFamily: "var(--cheetos-display)",
            color: "var(--cheetos-ink)",
          }}
        >
          Simulator
        </h1>
        <p
          className="text-sm leading-relaxed md:text-base"
          style={{ color: "var(--cheetos-ink-muted)" }}
        >
          Watch pack resolution, script order, filesystem writes, and insights
          for a simulated{" "}
          <code className="font-mono text-[0.9em]">cheetos add</code> run.
        </p>
      </header>
      <RuntimeSimulator />
    </main>
  );
}
