# Cheetos runtime simulator

Interactive teaching demo for the `cheetos add` pipeline. Lives under the docs
app at **`/simulator`**.

## What you’ll see

- **Graph resolution** — layered SVG of `dependsOn` as candidates → planned → active → done
- **Script execution order** — numbered `beforeWrite` / `afterInstall` rail with live status
- **Virtual filesystem** — seeded project tree that gains planned, written, hook, and install paths per step
- **Insights** — a detector pass over the finished trace that flags hotspots, redundant operations, and bug-risk patterns
- Real **`@cheetos/core`** parse / deps / plan; simulated hooks & installs with relative timing

## Run

```bash
pnpm docs:dev
# open http://localhost:3000/simulator
```

Shared UI primitives (`Panel`, `Chip`, `Note`, …) live in `docs/components/ui`
and are registered for MDX via `docs/components/mdx.tsx`.
