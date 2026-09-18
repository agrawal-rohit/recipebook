# docs

Cheetos documentation site built with [Fumadocs](https://fumadocs.dev) and Next.js.

```bash
pnpm docs:dev
```

Open http://localhost:3000.

| Route            | Description                                      |
| ---------------- | ------------------------------------------------ |
| `/`              | Landing page                                     |
| `/docs`          | Public documentation (notebook layout)           |
| `/simulator`     | Interactive add-pipeline simulator               |
| `/internal`      | Pipeline artefacts (dev only)                    |
| `/api/search`    | Search route handler                             |

- `lib/source.ts` — content loaders for docs + artefacts
- `lib/layout.shared.tsx` — shared nav (Docs, Simulator, GitHub)
