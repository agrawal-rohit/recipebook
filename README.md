<div align="center">
  <img src="https://cdn.rohit-agrawal.com/work/cheetos/logo.png" alt="Cheetos" style="width: 30%; margin: auto" />
</div>

<br />

<div align="center">
  <p align="center" style="width: 80%; margin: auto">
    <img alt="Status" src="https://img.shields.io/github/actions/workflow/status/agrawal-rohit/cheetos/ci.yml">
    <img alt="Coverage" src="https://img.shields.io/sonar/coverage/agrawal-rohit_cheetos?server=https%3A%2F%2Fsonarcloud.io">
    <img alt="Downloads" src="https://img.shields.io/npm/dt/cheetos">
    <img alt="Biome" src="https://img.shields.io/badge/code_style-biome-60a5fa">
    <img alt="License" src="https://img.shields.io/github/license/agrawal-rohit/cheetos" />
  </p>
</div>

<div align="center">
  <p>An opinionated scaffolding CLI with a default registry and a raw registry core.</p>
</div>

`cheetos` eliminates repetitive project setup by providing opinionated templates with pre-configured tooling, best practices, and reusable registry items. Now as a monorepo, it ships with three complementary packages:

- **`cheetos`**: the CLI users run via `npx` to scaffold projects and add components
- **`@cheetos/core`**: shared internals and registry-document validation
- **`@cheetos/registry`**: the private default registry content bundled into the CLI

By default, `npx cheetos` uses the bundled registry from this repository. To point the CLI at a custom registry, use `--registry`, set the `CHEETOS_REGISTRY` environment variable, or persist a default with `cheetos config set`.

## Quickstart

Add a registry item to the current project (one at a time):

```bash
npx cheetos add pr-template-configuration
npx cheetos add testing-configuration --overwrite
npx cheetos add
```

Use a custom registry for one invocation:

```bash
npx cheetos --registry https://example.com/registry.json add pr-template-configuration
```

Persist a default registry source (stored in `~/.config/cheetos/config.json`):

```bash
npx cheetos config set https://example.com/registry.json
npx cheetos add pr-template-configuration
```

Inspect or clear the saved source:

```bash
npx cheetos config get
npx cheetos config unset
```

Or set it as an environment variable for all commands:

```bash
export CHEETOS_REGISTRY="https://example.com/registry.json"
npx cheetos add pr-template-configuration
```

Registry source precedence: `--registry` flag > `CHEETOS_REGISTRY` env > saved config > bundled default.
## Workspace layout

```text
packages/
├── cli/        # published as `cheetos`
├── core/       # published as `@cheetos/core`
└── registry/   # private default registry content
docs/           # documentation site
```

## Building a custom registry

`@cheetos/core` compiles, validates, and parses registry documents. Call `buildRegistry` with a raw registry `sourceDir` (items, `types.json`, optional `conditions/conditions.json`) and an `outDir` for compiled output:

```ts
import { buildRegistry, parseRegistryDocument } from "@cheetos/core";

await buildRegistry({ sourceDir, outDir });
const registry = parseRegistryDocument(JSON.parse(registryJson));
```

That emits `registry.json` (the index) plus compiled items at `r/{itemId}.json` (pack-less items) or `r/{itemId}/{packId}.json` under `outDir`. Item identity is the `items` map key; each item or pack has a `source` URI. Consumers join it against the index location (`joinIndexSource`). File contents and ecosystem-tagged dependencies live in the compiled item, not the index.

`@cheetos/core` exposes:

- `buildRegistry()` for compiling a registry source tree into an index plus compiled items
- Schema types and validation for the index (`IndexItem`) and compiled items (`CompiledItem`)
- `parseRegistryDocument()` and `parseWithSchema()` for runtime validation (unknown keys are rejected; use `compiledItemSchema` for compiled items)
- `joinIndexSource()` for storage-agnostic index `source` joining

The private `@cheetos/registry` package holds the default opinionated content and a short build script around `buildRegistry` (`pnpm build:registry`).

## Development

Requirements:

- Node.js 20+
- pnpm

Get started:

```bash
pnpm install
pnpm run build
```

Common development commands:

```bash
pnpm run check          # typecheck and lint (writes fixes)
pnpm run build          # build all packages
pnpm run build:registry # rebuild compiled registry metadata
pnpm cov                # run tests with coverage
pnpm run quality:changes # quality gate on changed files (pre-PR)
pnpm run quality         # full codebase quality scan
```

The default registry content lives under `packages/registry/registry/`. Compilation writes `packages/registry/registry.json` (committed) and `packages/registry/r/` (gitignored build output, bundled into the CLI package at `prepack`).

## Releases

This repository uses [release-please](https://github.com/googleapis/release-please):

1. Contributors merge code using conventional commits
2. Every push to `main` opens or updates a Release PR with version bumps and changelog
3. Maintainers review and squash-merge the Release PR to tag changed packages
   (for example `cheetos@v0.3.0`, `core@v0.3.0`) and publish only those packages to npm

For details on the contributor and maintainer workflows, see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE) © [Rohit Agrawal](https://rohit.build/)
