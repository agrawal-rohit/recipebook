# pebbles

The published `pebbles` CLI package.

## Commands

### `add`

Install registry items into the current working directory:

```bash
npx pebbles add pr-template-configuration
npx pebbles add testing-configuration --overwrite
npx pebbles add
```

When item ids are omitted, `add` prompts with a multiselect. Shared registry conditions use local condition handlers for prompt defaults when available, then prompt for the rest. Compiled item files are fetched from the index location, item handlers may generate or transform files, and packages are installed using the project’s selected package manager (lockfile detection, otherwise a prompt) after confirming whether to install now.

### `list`

```bash
npx pebbles list
npx pebbles list --type workflow,configuration
```

## Registry source

By default, `pebbles` uses the bundled registry from the monorepo. You can point it at a custom registry in following ways:

1. CLI flag at each command:

```bash
npx pebbles --registry <url-or-path> list
```

2. Environment variable:

```bash
export PEBBLES_REGISTRY="<url-or-path>"
npx pebbles list
```

3. Global preference set through the `config` command:

```bash
npx pebbles config set <url-or-path>
npx pebbles config get
npx pebbles config unset
npx pebbles list
```