import Link from "next/link";

export default function HomePage() {
  return (
    <main className="relative flex flex-1 flex-col overflow-hidden">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10"
        style={{
          background: `
            radial-gradient(ellipse 80% 60% at 20% 10%, color-mix(in srgb, var(--cheetos-teal-soft) 70%, transparent), transparent 55%),
            radial-gradient(ellipse 70% 50% at 90% 20%, color-mix(in srgb, var(--cheetos-amber-soft) 55%, transparent), transparent 50%),
            linear-gradient(180deg, var(--cheetos-paper-2) 0%, var(--cheetos-paper) 100%)
          `,
        }}
      />

      <section className="mx-auto flex w-full max-w-3xl flex-1 flex-col justify-center px-6 py-20 md:py-28">
        <p className="ui-eyebrow mb-4">registry · packs · hooks</p>
        <h1
          className="mb-5 text-5xl font-semibold tracking-tight md:text-6xl"
          style={{
            fontFamily: "var(--cheetos-display)",
            color: "var(--cheetos-ink)",
          }}
        >
          Cheetos
        </h1>
        <p
          className="max-w-xl text-lg leading-relaxed md:text-xl"
          style={{ color: "var(--cheetos-ink-muted)" }}
        >
          Compose project tooling from a registry — packs, scripts, and agent
          instructions.
        </p>
        <div className="mt-10 flex flex-wrap items-center gap-3">
          <Link
            href="/docs"
            className="inline-flex items-center rounded-[var(--cheetos-radius)] px-5 py-2.5 text-sm font-medium transition-opacity hover:opacity-90"
            style={{
              background: "var(--cheetos-teal)",
              color: "var(--cheetos-paper-2)",
            }}
          >
            Get started
          </Link>
          <Link
            href="/simulator"
            className="inline-flex items-center rounded-[var(--cheetos-radius)] border px-5 py-2.5 text-sm font-medium transition-colors hover:bg-white/60"
            style={{
              borderColor: "var(--cheetos-line)",
              color: "var(--cheetos-ink)",
            }}
          >
            Open simulator
          </Link>
        </div>
      </section>

      <section
        className="border-t px-6 py-14"
        style={{ borderColor: "var(--cheetos-line)" }}
      >
        <div className="mx-auto grid w-full max-w-3xl gap-8 sm:grid-cols-3">
          <Link href="/docs/getting-started" className="group block">
            <h2
              className="mb-2 text-base font-semibold group-hover:underline"
              style={{
                fontFamily: "var(--cheetos-display)",
                color: "var(--cheetos-ink)",
              }}
            >
              Getting started
            </h2>
            <p
              className="text-sm leading-relaxed"
              style={{ color: "var(--cheetos-ink-muted)" }}
            >
              Install the CLI and add your first pack.
            </p>
          </Link>
          <Link href="/docs/concepts" className="group block">
            <h2
              className="mb-2 text-base font-semibold group-hover:underline"
              style={{
                fontFamily: "var(--cheetos-display)",
                color: "var(--cheetos-ink)",
              }}
            >
              Concepts
            </h2>
            <p
              className="text-sm leading-relaxed"
              style={{ color: "var(--cheetos-ink-muted)" }}
            >
              Packs, registry resolution, and hooks.
            </p>
          </Link>
          <Link href="/simulator" className="group block">
            <h2
              className="mb-2 text-base font-semibold group-hover:underline"
              style={{
                fontFamily: "var(--cheetos-display)",
                color: "var(--cheetos-ink)",
              }}
            >
              Simulator
            </h2>
            <p
              className="text-sm leading-relaxed"
              style={{ color: "var(--cheetos-ink-muted)" }}
            >
              Watch the add pipeline plan and write files.
            </p>
          </Link>
        </div>
      </section>

      {process.env.NODE_ENV !== "production" ? (
        <p
          className="mx-auto w-full max-w-3xl px-6 pb-8 text-xs"
          style={{ color: "var(--cheetos-ink-muted)" }}
        >
          Dev:{" "}
          <Link href="/internal" className="underline">
            /internal
          </Link>{" "}
          artefacts
        </p>
      ) : null}
    </main>
  );
}
