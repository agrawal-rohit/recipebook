import { CopyCommand } from "@/components/copy-command";
import { HeroTerminal } from "@/components/hero-terminal";

export default function HomePage() {
  return (
    <div className="relative -mt-14 min-h-dvh w-full bg-background pt-14">
      <div
        className="absolute inset-0 z-0"
        style={{
          background:
            "radial-gradient(ellipse 80% 60% at 50% 0%, color-mix(in srgb, var(--color-primary) 25%, transparent), transparent 70%), var(--color-background)",
        }}
      />
      <main className="relative z-10 mx-auto flex min-h-[calc(100dvh-3.5rem)] w-full max-w-(--fd-layout-width) flex-col justify-center px-6 py-10 md:py-12">
        <section className="grid min-w-0 items-center gap-10 md:grid-cols-2 md:gap-12 lg:gap-16">
          <div className="flex min-w-0 flex-col gap-6">
            <div className="flex flex-col gap-4">
              <h1 className="text-balance font-semibold text-4xl text-foreground tracking-tight md:text-5xl md:leading-[1.1]">
                Declare any artefact. Share it from a registry you control.
              </h1>
              <p className="max-w-xl text-pretty text-lg text-muted-foreground">
                Recipebook is a declarative framework for authoring and sharing
                files of any kind. You choose the types, conditions, and files —
                UI components, agent skills, themes, templates, configs, or
                whatever you name. At add, conditions and mustache bindings
                shape what lands.
              </p>
            </div>
            <CopyCommand />
          </div>
          <div className="min-w-0 w-full max-w-md md:justify-self-end">
            <HeroTerminal />
          </div>
        </section>
      </main>
    </div>
  );
}
