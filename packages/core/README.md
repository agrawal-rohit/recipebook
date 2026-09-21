# @cheetos/core

Shared primitives and utilities for building and consuming `cheetos` registries.

This package powers the [`cheetos`](https://www.npmjs.com/package/cheetos) CLI, which points at a registry source via `--registry`, `CHEETOS_REGISTRY`, or `cheetos configure set`.

## Compile a registry

Third-party authors compile a registry source tree into an index plus compiled items:

```ts
import { buildRegistry } from "@cheetos/core";

await buildRegistry({
	sourceDir: "/path/to/my-registry/registry",
	outDir: "/path/to/my-registry",
	registryFileName: "registry.json",
	// Optional layout overrides (defaults shown):
	// itemManifestFileName: "registry-item.json",
	// typesFileName: "types.json",
	// conditionsFileName: "conditions/conditions.json",
	// compiledDirName: "r",
	// bundleExternalPackages: ["acme-helpers"], // always includes @cheetos/core
});
```

That writes compiled output under `outDir` (defaults match the paths below; override via options above):

- `registry.json` (or `registryFileName`) — index (identity is the `items` map key; each item may declare `source`, `packs`, and/or `beforeWrite` / `afterInstall`)
- `r/{itemId}.json` or `r/{itemId}/{packId}.json` — compiled items with `target`, inlined template `content`, and `dependencies` keyed by ecosystem
- `r/{itemId}.beforeWrite.{index}.js` / `r/{itemId}.afterInstall.{index}.js` — bundled install scripts (local registries only at install time)
- `r/_handlers/{key}.handler.js` — bundled condition handlers

## Consume a compiled index

A registry index is a JSON document exposing `items`, optional `conditions`, and `scriptIntegrity` / `itemIntegrity` digests. Compiled items describe `target`, inlined template `content`, and `dependencies` keyed by ecosystem; consumers join index `source` values against the index location with `joinIndexSource`.
- `parseWithSchema(compiledItemSchema, …)` — validate a compiled item
- `import type { BeforeWriteHook }` / `import type { ConditionHandler }` — typed hook contracts (prefer `import type` so bundles stay self-contained)

## Install lifecycle

Each item has two optional lifecycle hook phases: `beforeWrite` (preparing Cheetos-managed files, commands, dependencies, and bindings before any disk writes occur) and `afterInstall` (running live environment activation and tool initialization commands after files are written and packages installed). Each phase accepts script paths relative to the item folder (`..` is allowed as long as the file stays under the registry source). Other registry items belong in `dependsOn`. The CLI runs `beforeWrite` scripts, prompts for file overwrite confirmation if targets already exist, writes planned files, merges `package.json` scripts, optionally installs dependencies, then runs `afterInstall` scripts in plan order. `afterInstall` still runs if the user declines package installation, and must not return a value.
