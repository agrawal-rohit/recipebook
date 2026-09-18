/**
 * Walk a Cheetos `add` pipeline over a sample registry and emit timed teaching steps.
 * Uses real `@cheetos/core` plan/parse APIs; hooks and disk writes are simulated.
 */

import {
  assumeContextFromSelectedItems,
  buildInstallPlan,
  catalogNeedsPackageManager,
  collectItemLocalConditions,
  collectRegistryDependencies,
  collectRequiredConditions,
  type IndexEntry,
  type IndexItem,
  type InstallNode,
  NpmPackageManager,
  PACKAGE_MANAGER_KEY,
  parseItemId,
  parseRegistryDocument,
  type Registry,
  type RegistryContext,
  type RegistryPackageManager,
  uniqueKnownRegistryItems,
} from "@cheetos/core/browser";
import { simulatedDurationMs } from "./timing";

export type SimPhase =
  | "parse"
  | "select"
  | "assume-context"
  | "collect-deps"
  | "package-manager"
  | "collect-conditions"
  | "build-plan"
  | "load-compiled"
  | "before-write"
  | "interpolate"
  | "plan-files"
  | "write-files"
  | "merge-commands"
  | "install-packages"
  | "after-install"
  | "done";

export type { RegistryContext, RegistryPackageManager };
export { NpmPackageManager };

export type GraphNodeStatus =
  | "unseen"
  | "selected"
  | "candidate"
  | "planned"
  | "active"
  | "done";

export interface DepGraphNode {
  id: string;
  title: string;
  type?: string;
  status: GraphNodeStatus;
  packIds?: string[];
  /** Topological layer (0 = roots / leaves installed first). */
  layer: number;
}

export interface DepGraphEdge {
  from: string;
  to: string;
  kind: "dependsOn" | "selected";
}

export interface ScriptLogEntry {
  order: number;
  phase: "beforeWrite" | "afterInstall";
  uri: string;
  itemId: string;
  status: "queued" | "running" | "done" | "skipped";
}

export interface FsEntry {
  path: string;
  kind: "file" | "dir";
  content?: string;
  /** How this path arrived in the tree. */
  origin: "seed" | "planned" | "written" | "hook" | "install";
  /** Last step id that touched this path. */
  touchedBy?: string;
}

export interface FsEvent {
  path: string;
  action: "create" | "update" | "plan" | "conflict";
  stepId: string;
}

export interface PlanNodeView {
  itemId: string;
  packIds?: string[];
  sources: string[];
  beforeWrite: string[];
  afterInstall: string[];
}

export interface SimState {
  selectedItems: string[];
  context: RegistryContext;
  packageManager: RegistryPackageManager | undefined;
  needsPackageManager: boolean;
  candidates: { id: string; title?: string }[];
  requiredConditions: {
    key: string;
    scope: "shared" | "item";
    itemId?: string;
    label?: string;
  }[];
  missingConditions: string[];
  plan: PlanNodeView[];
  depGraph: { nodes: DepGraphNode[]; edges: DepGraphEdge[] };
  compiled: Record<
    string,
    {
      files: { target: string }[];
      dependencies: string[];
      commands: string[];
      itemId: string;
    }
  >;
  bindings: Record<string, string>;
  /** Path → entry; dirs are implied by file paths too. */
  fs: Record<string, FsEntry>;
  fsEvents: FsEvent[];
  plannedFiles: string[];
  fileConflicts: string[];
  scriptLog: ScriptLogEntry[];
  pendingScripts: {
    phase: "beforeWrite" | "afterInstall";
    uri: string;
    itemId: string;
  }[];
  installCommands: string[][];
  itemCount: number;
  warning?: string;
}

export interface SimStep {
  id: string;
  phase: SimPhase;
  title: string;
  detail: string;
  durationMs: number;
  t0: number;
  t1: number;
  state: SimState;
  /** Paths this step wrote/updated (write-files, hook notes, lockfile, package.json). */
  filesWritten?: string[];
  /** Nodes visited by this step (build-plan: plan length). */
  graphVisits?: number;
  /** True when the step overwrote an already-existing file. */
  redundantWrite?: boolean;
  highlight?: {
    itemIds?: string[];
    conditionKeys?: string[];
    sources?: string[];
    scriptUris?: string[];
    files?: string[];
    edges?: Array<{ from: string; to: string }>;
  };
}

export type FindingKind = "hotspot" | "redundancy" | "bug-risk";

export interface TraceFinding {
  id: string;
  kind: FindingKind;
  /** 1 = worth a look, 2 = suspicious, 3 = likely bug. */
  severity: 1 | 2 | 3;
  title: string;
  detail: string;
  stepIds: string[];
  itemIds?: string[];
  paths?: string[];
  conditionKeys?: string[];
}

export interface TraceInsights {
  findings: TraceFinding[];
  /** Step ids (by index) that any finding points at, for timeline markers. */
  markedStepIndexes: number[];
}

export interface SimulationTrace {
  steps: SimStep[];
  totalDurationMs: number;
  final: SimState;
  error?: { message: string; stepIndex: number };
  insights: TraceInsights;
}

export interface SimulateAddInput {
  registry: unknown;
  selectedItems: string[];
  context: RegistryContext;
  packageManager?: RegistryPackageManager;
  /** Optional pre-existing project files (path → content). */
  seedFs?: Record<string, string>;
}

/** Create an empty simulation state snapshot. */
export function emptySimState(): SimState {
  return {
    selectedItems: [],
    context: {},
    packageManager: undefined,
    needsPackageManager: false,
    candidates: [],
    requiredConditions: [],
    missingConditions: [],
    plan: [],
    depGraph: { nodes: [], edges: [] },
    compiled: {},
    bindings: {},
    fs: {},
    fsEvents: [],
    plannedFiles: [],
    fileConflicts: [],
    scriptLog: [],
    pendingScripts: [],
    installCommands: [],
    itemCount: 0,
  };
}

function cloneState(state: SimState): SimState {
  return structuredClone(state);
}

function nodeView(node: InstallNode): PlanNodeView {
  return {
    itemId: node.itemId,
    packIds: node.packIds,
    sources: [...(node.sources ?? [])],
    beforeWrite: [...(node.beforeWriteScripts ?? [])],
    afterInstall: [...(node.afterInstallScripts ?? [])],
  };
}

function seedFilesystem(
  seed?: Record<string, string>,
): Record<string, FsEntry> {
  const defaults: Record<string, string> = {
    "README.md": "# Existing project\n",
    "package.json": '{\n  "name": "demo-pkg",\n  "private": true\n}\n',
    ".gitignore": "node_modules/\ndist/\n",
  };
  const merged = { ...defaults, ...seed };
  const fs: Record<string, FsEntry> = {};
  for (const [path, content] of Object.entries(merged)) {
    ensureParentDirs(fs, path);
    fs[path] = { path, kind: "file", content, origin: "seed" };
  }
  return fs;
}

function ensureParentDirs(fs: Record<string, FsEntry>, filePath: string): void {
  const parts = filePath.split("/");
  let acc = "";
  for (let i = 0; i < parts.length - 1; i++) {
    acc = acc ? `${acc}/${parts[i]}` : parts[i]!;
    if (!fs[acc]) fs[acc] = { path: acc, kind: "dir", origin: "seed" };
  }
}

/**
 * Build synthetic compiled payloads with several files so the FS tree looks real.
 * @param source - Compiled item URI
 * @param itemId - Owning registry item
 * @param item - Index item metadata
 * @param packIds - Selected packs
 */
function synthesizeCompiled(
  source: string,
  itemId: string,
  item: IndexItem | undefined,
  packIds: string[] | undefined,
): {
  files: { target: string }[];
  dependencies: string[];
  commands: string[];
  itemId: string;
} {
  const leaf =
    source
      .split("/")
      .pop()
      ?.replace(/\.json$/, "") ?? itemId;
  const type = item?.type ?? "configuration";
  const files: { target: string }[] = [];
  const dependencies: string[] = [];
  const commands: string[] = [];

  if (type === "workflow" || source.includes("workflow")) {
    files.push({ target: `.github/workflows/${leaf}.yml` });
    if (itemId.includes("setup-workspace")) {
      files.push({ target: `.github/actions/setup-workspace/action.yml` });
    }
  } else if (type === "agent-instruction") {
    files.push({ target: `.cursor/rules/${leaf}.mdc` });
    files.push({ target: `AGENTS.md` });
  } else if (type === "subagent") {
    files.push({ target: `.cursor/agents/${leaf}.md` });
  } else if (type === "starter-template") {
    files.push({ target: `src/index.ts` });
    files.push({ target: `tsconfig.json` });
    files.push({ target: `package.json` });
    if (packIds?.includes("react") || leaf === "react") {
      files.push({ target: `src/App.tsx` });
      files.push({ target: `vite.config.ts` });
      dependencies.push("react", "react-dom");
      commands.push("dev", "build");
    } else {
      dependencies.push("typescript");
      commands.push("build", "test");
    }
  } else if (itemId.includes("license") || itemId.includes("code-of-conduct")) {
    if (itemId.includes("license")) files.push({ target: "LICENSE" });
    if (itemId.includes("code-of-conduct"))
      files.push({ target: "CODE_OF_CONDUCT.md" });
  } else if (itemId.includes("pr-template")) {
    files.push({ target: ".github/pull_request_template.md" });
  } else if (itemId.includes("issue-templates")) {
    files.push({ target: ".github/ISSUE_TEMPLATE/bug_report.md" });
    files.push({ target: ".github/ISSUE_TEMPLATE/feature_request.md" });
  } else if (itemId.includes("package-management")) {
    files.push({ target: ".npmrc" });
    if (packIds?.some((id) => id.includes("pnpm"))) {
      files.push({ target: "pnpm-workspace.yaml" });
    }
  } else if (itemId.includes("pre-commit")) {
    files.push({ target: ".husky/pre-commit" });
    files.push({ target: "lint-staged.config.js" });
    dependencies.push("husky", "lint-staged");
  } else if (itemId.includes("testing")) {
    files.push({ target: "vitest.config.ts" });
    files.push({ target: "stryker.config.mjs" });
    dependencies.push("vitest", "@stryker-mutator/core");
    commands.push("test", "mutate");
  } else if (itemId.includes("dependency-updates")) {
    files.push({ target: ".github/dependabot.yml" });
  } else if (itemId.includes("code-quality")) {
    if (packIds?.includes("biome") || leaf === "biome") {
      files.push({ target: "biome.json" });
      dependencies.push("@biomejs/biome");
      commands.push("lint", "format");
    }
    if (packIds?.includes("sonar") || leaf === "sonar") {
      files.push({ target: "sonar-project.properties" });
    }
    if (packIds?.includes("fallow") || leaf === "fallow") {
      files.push({ target: "fallow.config.json" });
      dependencies.push("fallow");
    }
    if (files.length === 0) files.push({ target: `.config/${leaf}.json` });
  } else {
    files.push({ target: `.config/${leaf}.json` });
  }

  return { files, dependencies, commands, itemId };
}

function buildDepEdges(entries: IndexEntry[]): DepGraphEdge[] {
  const ids = new Set(entries.map((entry) => entry.itemId));
  const edges: DepGraphEdge[] = [];
  for (const { itemId, item } of entries) {
    for (const dep of item.dependsOn ?? []) {
      if (ids.has(dep))
        edges.push({ from: itemId, to: dep, kind: "dependsOn" });
    }
    for (const pack of item.packs ?? []) {
      for (const dep of pack.dependsOn ?? []) {
        if (ids.has(dep))
          edges.push({ from: itemId, to: dep, kind: "dependsOn" });
      }
    }
  }
  const seen = new Set<string>();
  return edges.filter((edge) => {
    const key = `${edge.from}->${edge.to}:${edge.kind}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function layerNodes(ids: string[], edges: DepGraphEdge[]): Map<string, number> {
  const dependents = new Map<string, string[]>();
  const indegree = new Map<string, number>();
  for (const id of ids) {
    dependents.set(id, []);
    indegree.set(id, 0);
  }
  // Edge A→B means A dependsOn B, so B must install before A.
  for (const edge of edges) {
    if (!indegree.has(edge.from) || !indegree.has(edge.to)) continue;
    dependents.get(edge.to)?.push(edge.from);
    indegree.set(edge.from, (indegree.get(edge.from) ?? 0) + 1);
  }
  const layers = new Map<string, number>();
  const queue = ids.filter((id) => (indegree.get(id) ?? 0) === 0);
  for (const id of queue) layers.set(id, 0);
  while (queue.length > 0) {
    const id = queue.shift()!;
    const layer = layers.get(id) ?? 0;
    for (const next of dependents.get(id) ?? []) {
      const nextLayer = Math.max(layers.get(next) ?? 0, layer + 1);
      layers.set(next, nextLayer);
      const deg = (indegree.get(next) ?? 1) - 1;
      indegree.set(next, deg);
      if (deg === 0) queue.push(next);
    }
  }
  for (const id of ids) if (!layers.has(id)) layers.set(id, 0);
  return layers;
}

function graphFromCandidates(
  entries: IndexEntry[],
  selectedIds: Set<string>,
  status: GraphNodeStatus,
): SimState["depGraph"] {
  const edges = buildDepEdges(entries);
  const layers = layerNodes(
    entries.map((entry) => entry.itemId),
    edges,
  );
  return {
    nodes: entries.map(({ itemId, item }) => ({
      id: itemId,
      title: item.title,
      type: item.type,
      status: selectedIds.has(itemId) ? "selected" : status,
      layer: layers.get(itemId) ?? 0,
    })),
    edges,
  };
}

function applyPlanToGraph(
  graph: SimState["depGraph"],
  plan: PlanNodeView[],
): SimState["depGraph"] {
  const planned = new Map(plan.map((node) => [node.itemId, node]));
  const layers = layerNodes(
    graph.nodes.map((node) => node.id),
    graph.edges,
  );
  return {
    edges: graph.edges,
    nodes: graph.nodes.map((node) => {
      const planNode = planned.get(node.id);
      if (!planNode)
        return { ...node, layer: layers.get(node.id) ?? node.layer };
      return {
        ...node,
        status: "planned" as const,
        packIds: planNode.packIds,
        layer: layers.get(node.id) ?? node.layer,
      };
    }),
  };
}

function setGraphActive(
  graph: SimState["depGraph"],
  itemIds: string[],
  mode: "active" | "done",
): SimState["depGraph"] {
  const set = new Set(itemIds);
  return {
    ...graph,
    nodes: graph.nodes.map((node) => {
      if (!set.has(node.id)) return node;
      if (mode === "done")
        return {
          ...node,
          status:
            node.status === "planned" ||
            node.status === "active" ||
            node.status === "selected"
              ? "done"
              : node.status,
        };
      return { ...node, status: "active" };
    }),
  };
}

function shortScriptName(uri: string): string {
  return uri.split("/").pop() ?? uri;
}

/**
 * Simulate a Cheetos `add` run for teaching — ordered steps, state, and relative timing.
 * @param input - Registry document, selection, captured context, optional package manager
 * @returns Trace with timed steps; `error` set when a phase fails
 */
export function simulateAdd(input: SimulateAddInput): SimulationTrace {
  const steps: SimStep[] = [];
  let t = 0;
  let state = emptySimState();
  state.fs = seedFilesystem(input.seedFs);
  let phaseCounts: Partial<Record<SimPhase, number>> = {};

  const push = (
    phase: SimPhase,
    title: string,
    detail: string,
    durationMs: number,
    next: SimState,
    highlight?: SimStep["highlight"],
    meta?: {
      filesWritten?: string[];
      graphVisits?: number;
      redundantWrite?: boolean;
    },
  ): string => {
    const ordinal = (phaseCounts[phase] ?? 0) + 1;
    phaseCounts = { ...phaseCounts, [phase]: ordinal };
    const id = `${phase}-${ordinal}`;
    const t0 = t;
    const t1 = t0 + durationMs;
    t = t1;
    state = next;
    steps.push({
      id,
      phase,
      title,
      detail,
      durationMs,
      t0,
      t1,
      state: cloneState(next),
      filesWritten: meta?.filesWritten,
      graphVisits: meta?.graphVisits,
      redundantWrite: meta?.redundantWrite,
      highlight,
    });
    return id;
  };

  const traceSoFar = (): Omit<SimulationTrace, "insights"> => ({
    steps,
    totalDurationMs: t,
    final: cloneState(state),
  });

  const fail = (message: string): SimulationTrace => ({
    ...traceSoFar(),
    error: { message, stepIndex: Math.max(0, steps.length - 1) },
    insights: analyzeTrace(steps),
  });

  // --- parse ---
  let registry: Registry;
  try {
    registry = parseRegistryDocument(input.registry);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    push("parse", "Parse registry", message, simulatedDurationMs("noop"), {
      ...state,
      warning: message,
    });
    return fail(message);
  }

  const itemCount = Object.keys(registry.items).length;
  push(
    "parse",
    "Parse registry",
    `Validated index with ${itemCount} items` +
      (registry.conditions
        ? ` and ${Object.keys(registry.conditions).length} shared conditions`
        : ""),
    simulatedDurationMs("perItem", Math.min(itemCount, 8)),
    { ...state, itemCount },
  );

  // --- select ---
  if (input.selectedItems.length === 0) {
    const message = "Select at least one registry item to install.";
    push("select", "Select items", message, simulatedDurationMs("noop"), {
      ...state,
      selectedItems: [],
    });
    return fail(message);
  }

  let selectedItems: string[];
  try {
    selectedItems = uniqueKnownRegistryItems(
      input.selectedItems,
      registry.items,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    push(
      "select",
      "Select items",
      message,
      simulatedDurationMs("noop"),
      { ...state, selectedItems: [...input.selectedItems] },
      { itemIds: [...input.selectedItems] },
    );
    return fail(message);
  }

  const selectedIds = new Set(
    selectedItems.map((token) => parseItemId(token).id),
  );
  const selectGraph: SimState["depGraph"] = {
    nodes: [...selectedIds].map((id) => ({
      id,
      title: registry.items[id]?.title ?? id,
      type: registry.items[id]?.type,
      status: "selected" as const,
      layer: 0,
    })),
    edges: [],
  };

  push(
    "select",
    "Select items",
    `Resolved ${selectedItems.length} selected token(s): ${selectedItems.join(", ")}`,
    simulatedDurationMs("perItem", selectedItems.length),
    { ...state, selectedItems, depGraph: selectGraph },
    { itemIds: [...selectedIds] },
  );

  // --- assume-context ---
  let context: RegistryContext = { ...input.context };
  try {
    const assumed = assumeContextFromSelectedItems(
      selectedItems,
      registry.items,
      registry.conditions,
    );
    context = { ...assumed, ...input.context };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    push(
      "assume-context",
      "Assume context from pins",
      message,
      simulatedDurationMs("noop"),
      { ...state, context },
    );
    return fail(message);
  }

  const assumedKeys = Object.keys(context).filter(
    (key) => !(key in input.context) || input.context[key] !== context[key],
  );
  push(
    "assume-context",
    "Assume context from pins",
    assumedKeys.length > 0
      ? `Seeded ${assumedKeys.join(", ")} from id@pack pins; merged with captured context`
      : "No pack pins — using captured context as-is",
    simulatedDurationMs(
      assumedKeys.length > 0 ? "perCondition" : "noop",
      assumedKeys.length || 1,
    ),
    { ...state, context },
    { conditionKeys: Object.keys(context) },
  );

  // --- collect-deps (graph resolution) ---
  let candidates: IndexEntry[];
  try {
    candidates = collectRegistryDependencies(
      selectedItems,
      registry.items,
      context,
      input.packageManager,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    push(
      "collect-deps",
      "Resolve dependency graph",
      message,
      simulatedDurationMs("noop"),
      { ...state, context },
    );
    return fail(message);
  }

  const depGraph = graphFromCandidates(candidates, selectedIds, "candidate");
  push(
    "collect-deps",
    "Resolve dependency graph",
    `Walked dependsOn → ${candidates.length} nodes, ${depGraph.edges.length} edges`,
    simulatedDurationMs("perItem", candidates.length),
    {
      ...state,
      context,
      candidates: candidates.map(({ itemId, item }) => ({
        id: itemId,
        title: item.title,
      })),
      depGraph,
    },
    {
      itemIds: candidates.map((entry) => entry.itemId),
      edges: depGraph.edges.map((edge) => ({ from: edge.from, to: edge.to })),
    },
  );

  // --- package-manager ---
  const needsPackageManager = catalogNeedsPackageManager(
    candidates,
    registry.conditions,
  );
  const packageManager = input.packageManager;
  push(
    "package-manager",
    "Package manager",
    needsPackageManager
      ? packageManager
        ? `Using ${packageManager} (drives pack when.${PACKAGE_MANAGER_KEY})`
        : "Catalog needs a package manager — none selected yet"
      : "No package-manager-gated packs in this candidate set",
    simulatedDurationMs(needsPackageManager ? "perCondition" : "noop", 1),
    { ...state, packageManager, needsPackageManager },
  );

  // --- collect-conditions ---
  const requiredShared = collectRequiredConditions(
    candidates,
    registry.conditions,
    context,
    packageManager,
    selectedItems,
  );
  const requiredLocal = collectItemLocalConditions(
    candidates,
    context,
    packageManager,
    selectedItems,
  );
  const requiredConditions = [
    ...requiredShared.map((condition) => ({
      key: condition.key,
      scope: "shared" as const,
      label: condition.label,
    })),
    ...requiredLocal.map((condition) => ({
      key: condition.key,
      scope: "item" as const,
      label: condition.label,
    })),
  ];
  const missingConditions = requiredConditions
    .map((condition) => condition.key)
    .filter((key) => context[key] === undefined);

  push(
    "collect-conditions",
    "Collect conditions",
    missingConditions.length > 0
      ? `Still missing: ${missingConditions.join(", ")} (continuing with provided context)`
      : requiredConditions.length === 0
        ? "No additional conditions required"
        : "All required conditions already present in context",
    simulatedDurationMs("perCondition", Math.max(1, requiredConditions.length)),
    { ...state, requiredConditions, missingConditions },
    { conditionKeys: requiredConditions.map((condition) => condition.key) },
  );

  // --- build-plan ---
  let planNodes: InstallNode[];
  try {
    planNodes = buildInstallPlan(
      selectedItems,
      registry.items,
      context,
      packageManager,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    push(
      "build-plan",
      "Build install plan",
      message,
      simulatedDurationMs("noop"),
      { ...state },
    );
    return fail(message);
  }

  const plan = planNodes.map(nodeView);
  const pendingBefore = plan.flatMap((node) =>
    node.beforeWrite.map((uri) => ({
      phase: "beforeWrite" as const,
      uri,
      itemId: node.itemId,
    })),
  );
  const pendingAfter = plan.flatMap((node) =>
    node.afterInstall.map((uri) => ({
      phase: "afterInstall" as const,
      uri,
      itemId: node.itemId,
    })),
  );
  const scriptLog: ScriptLogEntry[] = [
    ...pendingBefore.map((script, index) => ({
      order: index + 1,
      phase: script.phase,
      uri: script.uri,
      itemId: script.itemId,
      status: "queued" as const,
    })),
    ...pendingAfter.map((script, index) => ({
      order: pendingBefore.length + index + 1,
      phase: script.phase,
      uri: script.uri,
      itemId: script.itemId,
      status: "queued" as const,
    })),
  ];

  const plannedGraph = applyPlanToGraph(state.depGraph, plan);
  push(
    "build-plan",
    "Build install plan",
    `Topo order (${plan.length}): ${plan.map((node) => (node.packIds?.length ? `${node.itemId}@${node.packIds.join("+")}` : node.itemId)).join(" → ") || "(empty)"}`,
    simulatedDurationMs("perItem", plan.length),
    {
      ...state,
      plan,
      depGraph: plannedGraph,
      pendingScripts: [...pendingBefore, ...pendingAfter],
      scriptLog,
    },
    {
      itemIds: plan.map((node) => node.itemId),
      edges: plannedGraph.edges.map((edge) => ({
        from: edge.from,
        to: edge.to,
      })),
    },
    { graphVisits: plan.length },
  );

  // --- load-compiled ---
  const compiled: SimState["compiled"] = {};
  for (const node of plan) {
    for (const source of node.sources) {
      compiled[source] = synthesizeCompiled(
        source,
        node.itemId,
        registry.items[node.itemId],
        node.packIds,
      );
    }
  }
  const sourceCount = Object.keys(compiled).length;
  push(
    "load-compiled",
    "Load compiled items",
    sourceCount > 0
      ? `Resolved ${sourceCount} source URI(s) → ${Object.values(compiled).reduce((n, item) => n + item.files.length, 0)} files`
      : "No compiled sources on this plan",
    simulatedDurationMs(
      sourceCount > 0 ? "perSource" : "noop",
      sourceCount || 1,
    ),
    { ...state, compiled },
    { sources: Object.keys(compiled) },
  );

  // --- before-write ---
  let bindings: Record<string, string> = { ...contextToBindings(context) };
  if (packageManager) bindings[PACKAGE_MANAGER_KEY] = packageManager;
  let scriptLogState = [...state.scriptLog];
  let fs = { ...state.fs };
  let fsEvents = [...state.fsEvents];

  if (pendingBefore.length === 0) {
    push(
      "before-write",
      "beforeWrite hooks",
      "No beforeWrite scripts on this plan",
      simulatedDurationMs("noop"),
      {
        ...state,
        bindings,
        pendingScripts: [...pendingAfter],
        scriptLog: scriptLogState,
      },
    );
  } else {
    let remaining = [...pendingBefore, ...pendingAfter];
    for (const script of pendingBefore) {
      scriptLogState = scriptLogState.map((entry) =>
        entry.uri === script.uri &&
        entry.itemId === script.itemId &&
        entry.phase === "beforeWrite"
          ? { ...entry, status: "running" }
          : entry.status === "running"
            ? { ...entry, status: "done" }
            : entry,
      );
      remaining = remaining.filter(
        (entry) =>
          !(
            entry.phase === script.phase &&
            entry.uri === script.uri &&
            entry.itemId === script.itemId
          ),
      );
      bindings = {
        ...bindings,
        [`hook:${script.itemId}`]: "applied",
      };
      // Simulated hook may stage a sidecar note file
      const hookNote = `.cheetos/hooks/${script.itemId}.beforeWrite.log`;
      ensureParentDirs(fs, hookNote);
      const stepPreview = `before-write·${script.itemId}`;
      fs = {
        ...fs,
        [hookNote]: {
          path: hookNote,
          kind: "file",
          content: `ran ${shortScriptName(script.uri)}\n`,
          origin: "hook",
          touchedBy: stepPreview,
        },
      };

      const stepId = push(
        "before-write",
        `beforeWrite · ${script.itemId}`,
        `Execute ${shortScriptName(script.uri)} — order #${scriptLogState.find((entry) => entry.uri === script.uri)?.order ?? "?"}`,
        simulatedDurationMs("perScript", 1),
        {
          ...state,
          bindings,
          pendingScripts: remaining,
          scriptLog: scriptLogState,
          depGraph: setGraphActive(state.depGraph, [script.itemId], "active"),
          fs,
          fsEvents: [
            ...fsEvents,
            { path: hookNote, action: "create", stepId: stepPreview },
          ],
        },
        {
          itemIds: [script.itemId],
          scriptUris: [script.uri],
          files: [hookNote],
        },
        { filesWritten: [hookNote] },
      );
      fs = {
        ...fs,
        [hookNote]: { ...fs[hookNote]!, touchedBy: stepId },
      };
      fsEvents = [...fsEvents, { path: hookNote, action: "create", stepId }];
      scriptLogState = scriptLogState.map((entry) =>
        entry.uri === script.uri && entry.itemId === script.itemId
          ? { ...entry, status: "done" }
          : entry,
      );
      state = {
        ...state,
        scriptLog: scriptLogState,
        fs,
        fsEvents,
        depGraph: setGraphActive(state.depGraph, [script.itemId], "done"),
      };
    }
  }

  // --- interpolate ---
  push(
    "interpolate",
    "Interpolate templates",
    `Bindings ready: ${Object.keys(bindings).join(", ") || "(none)"}`,
    simulatedDurationMs(
      "perCondition",
      Math.max(1, Object.keys(bindings).length),
    ),
    { ...state, bindings },
    { conditionKeys: Object.keys(bindings) },
  );

  // --- plan-files ---
  const plannedFiles: string[] = [];
  for (const payload of Object.values(state.compiled)) {
    for (const file of payload.files) plannedFiles.push(file.target);
  }
  const uniquePlanned = [...new Set(plannedFiles)];
  const fileConflicts = uniquePlanned.filter(
    (target) =>
      state.fs[target]?.kind === "file" && state.fs[target]?.origin === "seed",
  );
  const planFs = { ...state.fs };
  let planEvents = [...state.fsEvents];
  for (const target of uniquePlanned) {
    ensureParentDirs(planFs, target);
    if (!planFs[target]) {
      planFs[target] = {
        path: target,
        kind: "file",
        content: undefined,
        origin: "planned",
      };
    }
  }
  const planStepId = push(
    "plan-files",
    "Plan file writes",
    uniquePlanned.length > 0
      ? `Queued ${uniquePlanned.length} write(s)` +
          (fileConflicts.length
            ? `; ${fileConflicts.length} overwrite(s) of seed files`
            : "")
      : "No files to write",
    simulatedDurationMs(
      uniquePlanned.length > 0 ? "perFile" : "noop",
      uniquePlanned.length || 1,
    ),
    {
      ...state,
      plannedFiles: uniquePlanned,
      fileConflicts,
      fs: planFs,
      fsEvents: [
        ...planEvents,
        ...uniquePlanned.map((path) => ({
          path,
          action: (fileConflicts.includes(path) ? "conflict" : "plan") as
            | "conflict"
            | "plan",
          stepId: "plan-files",
        })),
      ],
    },
    { files: uniquePlanned },
  );
  planEvents = state.fsEvents.map((event) =>
    event.stepId === "plan-files" ? { ...event, stepId: planStepId } : event,
  );
  state = { ...state, fsEvents: planEvents };

  // --- write-files (one step per file for FS animation) ---
  if (uniquePlanned.length === 0) {
    push(
      "write-files",
      "Write files",
      "Skipped — nothing to write",
      simulatedDurationMs("noop"),
      { ...state },
    );
  } else {
    fs = { ...state.fs };
    fsEvents = [...state.fsEvents];
    for (const target of uniquePlanned) {
      const owner =
        Object.values(state.compiled).find((payload) =>
          payload.files.some((file) => file.target === target),
        )?.itemId ?? "?";
      ensureParentDirs(fs, target);
      const content = [
        `# ${target}`,
        `# written by ${owner}`,
        `# bindings: ${Object.keys(bindings).slice(0, 6).join(", ")}`,
        "",
      ].join("\n");
      const existed =
        fs[target]?.origin === "seed" || fs[target]?.origin === "written";
      const action = existed ? "update" : "create";
      const previewId = `write:${target}`;
      fs = {
        ...fs,
        [target]: {
          path: target,
          kind: "file",
          content,
          origin: "written",
          touchedBy: previewId,
        },
      };
      const stepId = push(
        "write-files",
        `Write · ${target}`,
        `${action === "update" ? "Overwrite" : "Create"} ${target} (from ${owner})`,
        simulatedDurationMs("perFile", 1),
        {
          ...state,
          fs,
          fsEvents: [...fsEvents, { path: target, action, stepId: previewId }],
          depGraph: setGraphActive(state.depGraph, [owner], "active"),
        },
        { files: [target], itemIds: [owner] },
        {
          filesWritten: [target],
          redundantWrite: action === "update",
        },
      );
      fs = {
        ...fs,
        [target]: { ...fs[target]!, touchedBy: stepId },
      };
      fsEvents = [...fsEvents, { path: target, action, stepId }];
      state = {
        ...state,
        fs,
        fsEvents,
        depGraph: setGraphActive(state.depGraph, [owner], "done"),
      };
    }
  }

  // --- merge-commands ---
  const commands = [
    ...new Set(
      Object.values(state.compiled).flatMap((payload) => payload.commands),
    ),
  ];
  if (commands.length > 0 && state.fs["package.json"]) {
    const pkgPath = "package.json";
    const prev = state.fs[pkgPath]?.content ?? "{}";
    const merged = `${prev.replace(/\n$/, "")}\n/* scripts: ${commands.join(", ")} */\n`;
    fs = {
      ...state.fs,
      [pkgPath]: {
        path: pkgPath,
        kind: "file",
        content: merged,
        origin: "written",
        touchedBy: "merge-commands",
      },
    };
    const stepId = push(
      "merge-commands",
      "Merge project commands",
      `Merged scripts into package.json: ${commands.join(", ")}`,
      simulatedDurationMs("perItem", 1),
      {
        ...state,
        fs,
        fsEvents: [
          ...state.fsEvents,
          { path: pkgPath, action: "update", stepId: "merge-commands" },
        ],
      },
      { files: [pkgPath] },
      {
        filesWritten: [pkgPath],
        redundantWrite: state.fs[pkgPath]?.origin !== "seed",
      },
    );
    state = {
      ...state,
      fs: {
        ...state.fs,
        [pkgPath]: { ...state.fs[pkgPath]!, touchedBy: stepId },
      },
      fsEvents: state.fsEvents.map((event) =>
        event.stepId === "merge-commands" ? { ...event, stepId } : event,
      ),
    };
  } else {
    push(
      "merge-commands",
      "Merge project commands",
      "No ecosystem commands on compiled items",
      simulatedDurationMs("noop"),
      { ...state },
    );
  }

  // --- install-packages ---
  const deps = [
    ...new Set(
      Object.values(state.compiled).flatMap((payload) => payload.dependencies),
    ),
  ];
  const installCommands: string[][] =
    deps.length > 0 && packageManager
      ? [[packageManager, "add", "-D", ...deps]]
      : deps.length > 0
        ? [["<pm>", "add", "-D", ...deps]]
        : [];

  if (deps.length > 0) {
    const lockfile =
      packageManager === "pnpm"
        ? "pnpm-lock.yaml"
        : packageManager === "yarn"
          ? "yarn.lock"
          : packageManager === "bun"
            ? "bun.lockb"
            : "package-lock.json";
    fs = { ...state.fs };
    ensureParentDirs(fs, "node_modules/.package-lock.json");
    fs[lockfile] = {
      path: lockfile,
      kind: "file",
      content: `# lockfile for ${deps.join(", ")}\n`,
      origin: "install",
      touchedBy: "install-packages",
    };
    fs["node_modules"] = {
      path: "node_modules",
      kind: "dir",
      origin: "install",
      touchedBy: "install-packages",
    };
    const stepId = push(
      "install-packages",
      "Install packages",
      `Run ${installCommands.map((argv) => argv.join(" ")).join(" ; ")} → ${lockfile}`,
      simulatedDurationMs("perItem", Math.max(1, deps.length)),
      {
        ...state,
        installCommands,
        fs,
        fsEvents: [
          ...state.fsEvents,
          { path: lockfile, action: "create", stepId: "install-packages" },
          {
            path: "node_modules",
            action: "create",
            stepId: "install-packages",
          },
        ],
      },
      { files: [lockfile, "node_modules"] },
      {
        filesWritten: [lockfile, "node_modules"],
        redundantWrite: packageManager === undefined,
      },
    );
    state = {
      ...state,
      fs: {
        ...state.fs,
        [lockfile]: { ...state.fs[lockfile]!, touchedBy: stepId },
        node_modules: { ...state.fs.node_modules!, touchedBy: stepId },
      },
      fsEvents: state.fsEvents.map((event) =>
        event.stepId === "install-packages" ? { ...event, stepId } : event,
      ),
    };
  } else {
    push(
      "install-packages",
      "Install packages",
      "No package dependencies declared on this plan",
      simulatedDurationMs("noop"),
      { ...state, installCommands },
    );
  }

  // --- after-install ---
  const afterQueue = state.pendingScripts.filter(
    (entry) => entry.phase === "afterInstall",
  );
  scriptLogState = [...state.scriptLog];
  if (afterQueue.length === 0) {
    push(
      "after-install",
      "afterInstall hooks",
      "No afterInstall scripts on this plan",
      simulatedDurationMs("noop"),
      { ...state, pendingScripts: [], scriptLog: scriptLogState },
    );
  } else {
    let remaining = [...afterQueue];
    fs = { ...state.fs };
    fsEvents = [...state.fsEvents];
    for (const script of afterQueue) {
      scriptLogState = scriptLogState.map((entry) =>
        entry.uri === script.uri &&
        entry.itemId === script.itemId &&
        entry.phase === "afterInstall"
          ? { ...entry, status: "running" }
          : entry.status === "running"
            ? { ...entry, status: "done" }
            : entry,
      );
      remaining = remaining.filter(
        (entry) =>
          !(entry.uri === script.uri && entry.itemId === script.itemId),
      );
      const hookNote = `.cheetos/hooks/${script.itemId}.afterInstall.log`;
      ensureParentDirs(fs, hookNote);
      fs = {
        ...fs,
        [hookNote]: {
          path: hookNote,
          kind: "file",
          content: `ran ${shortScriptName(script.uri)}\n`,
          origin: "hook",
          touchedBy: "after-install",
        },
      };
      const stepId = push(
        "after-install",
        `afterInstall · ${script.itemId}`,
        `Execute ${shortScriptName(script.uri)} — order #${scriptLogState.find((entry) => entry.uri === script.uri && entry.phase === "afterInstall")?.order ?? "?"}`,
        simulatedDurationMs("perScript", 1),
        {
          ...state,
          pendingScripts: remaining,
          scriptLog: scriptLogState,
          depGraph: setGraphActive(state.depGraph, [script.itemId], "active"),
          fs,
          fsEvents: [
            ...fsEvents,
            { path: hookNote, action: "create", stepId: "after-install" },
          ],
        },
        {
          itemIds: [script.itemId],
          scriptUris: [script.uri],
          files: [hookNote],
        },
        { filesWritten: [hookNote] },
      );
      fs = {
        ...fs,
        [hookNote]: { ...fs[hookNote]!, touchedBy: stepId },
      };
      fsEvents = [...fsEvents, { path: hookNote, action: "create", stepId }];
      scriptLogState = scriptLogState.map((entry) =>
        entry.uri === script.uri &&
        entry.itemId === script.itemId &&
        entry.phase === "afterInstall"
          ? { ...entry, status: "done" }
          : entry,
      );
      state = {
        ...state,
        scriptLog: scriptLogState,
        fs,
        fsEvents,
        depGraph: setGraphActive(state.depGraph, [script.itemId], "done"),
      };
    }
  }

  // --- done ---
  const written = Object.values(state.fs).filter(
    (entry) => entry.kind === "file" && entry.origin !== "seed",
  ).length;
  push(
    "done",
    "Done",
    `Finished · ${plan.length} item(s) · ${written} new/updated file(s) · ${state.scriptLog.filter((entry) => entry.status === "done").length} script(s) · ${formatMs(t)} simulated`,
    simulatedDurationMs("noop"),
    {
      ...state,
      pendingScripts: [],
      depGraph: {
        ...state.depGraph,
        nodes: state.depGraph.nodes.map((node) =>
          node.status === "planned" || node.status === "active"
            ? { ...node, status: "done" as const }
            : node,
        ),
      },
    },
    {
      itemIds: plan.map((node) => node.itemId),
      files: Object.keys(state.fs),
    },
  );

  return {
    steps,
    totalDurationMs: t,
    final: cloneState(state),
    insights: analyzeTrace(steps),
  };
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function contextToBindings(context: RegistryContext): Record<string, string> {
  const bindings: Record<string, string> = {};
  for (const [key, value] of Object.entries(context)) {
    if (typeof value === "string") bindings[key] = value;
    else if (typeof value === "boolean") bindings[key] = String(value);
    else if (Array.isArray(value)) bindings[key] = value.join(",");
  }
  return bindings;
}

/**
 * Detector pass over a finished trace — surfaces hotspots, redundant operations,
 * and likely bug patterns for teaching.
 * @param steps - Ordered simulation steps
 * @returns Findings grouped by severity plus timeline markers
 */
export function analyzeTrace(steps: SimStep[]): TraceInsights {
  const findings: TraceFinding[] = [];

  const resolveStepIndexes = (stepIds: string[]): number[] =>
    stepIds
      .map((id) => steps.findIndex((step) => step.id === id))
      .filter((index) => index >= 0);

  const allMarkedIndexes = new Set<number>();

  const add = (finding: Omit<TraceFinding, "id">): void => {
    const id = `${finding.kind}:${finding.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .slice(0, 48)}:${findings.length}`;
    findings.push({ ...finding, id });
    for (const index of resolveStepIndexes(finding.stepIds))
      allMarkedIndexes.add(index);
  };

  // --- provenance rollups ---
  const writtenByItem = new Map<string, string[]>();
  const writtenPaths: string[] = [];
  const redundantWrites: Array<{ path: string; itemId?: string }> = [];
  for (const step of steps) {
    for (const path of step.filesWritten ?? []) {
      writtenPaths.push(path);
      const owner =
        step.highlight?.itemIds?.[0] ??
        Object.values(step.state.compiled).find((payload) =>
          payload.files.some((file) => file.target === path),
        )?.itemId;
      if (owner) {
        const list = writtenByItem.get(owner) ?? [];
        list.push(path);
        writtenByItem.set(owner, list);
      }
    }
    if (step.redundantWrite)
      redundantWrites.push({ path: step.filesWritten?.[0] ?? "" });
  }

  // 1. Hotspots: items writing more than 2 files
  for (const [itemId, paths] of writtenByItem) {
    if (paths.length <= 2) continue;
    const stepIds = steps
      .filter(
        (step) =>
          step.highlight?.itemIds?.includes(itemId) &&
          (step.filesWritten?.length ?? 0) > 0,
      )
      .map((step) => step.id);
    if (stepIds.length === 0) continue;
    add({
      kind: "hotspot",
      severity: paths.length >= 6 ? 2 : 1,
      title: `High write volume: ${itemId}`,
      detail: `Writes ${paths.length} file(s): ${paths.join(", ")}. If these are static templates, consider consolidating into fewer compiled payloads.`,
      stepIds,
      itemIds: [itemId],
      paths,
    });
  }

  // 2. Hotspot: most-touched paths
  const touchCount = new Map<string, number>();
  for (const path of writtenPaths)
    touchCount.set(path, (touchCount.get(path) ?? 0) + 1);
  for (const [path, count] of touchCount) {
    if (count <= 1) continue;
    const stepIds = steps
      .filter((step) => (step.filesWritten ?? []).includes(path))
      .map((step) => step.id);
    add({
      kind: "hotspot",
      severity: count >= 3 ? 2 : 1,
      title: `Repeated target: ${path}`,
      detail: `${path} is written ${count} time(s). Each write re-emits the full file — a churn hotspot if content overlaps.`,
      stepIds,
      paths: [path],
    });
  }

  // 3. Hotspot: graph visits vs unique nodes
  const totalVisits = steps.reduce(
    (sum, step) => sum + (step.graphVisits ?? 0),
    0,
  );
  const uniqueNodes = new Set(
    steps
      .flatMap((step) => step.highlight?.itemIds ?? [])
      .filter((id, index, arr) => arr.indexOf(id) === index),
  ).size;
  if (totalVisits > uniqueNodes) {
    add({
      kind: "hotspot",
      severity: 1,
      title: `Graph re-visits: ${totalVisits} vs ${uniqueNodes} unique`,
      detail: `The install plan visits ${totalVisits} node(s) but only ${uniqueNodes} are unique — multi-root selections re-walk shared dependencies.`,
      stepIds: steps
        .filter((step) => step.phase === "build-plan")
        .map((step) => step.id),
    });
  }

  // 4. Redundancy: same path+action emitted more than once (the engine's
  //    placeholder-stepId double-push: preview event + real step event)
  const finalEvents = steps.at(-1)?.state.fsEvents ?? [];
  const eventCount = new Map<
    string,
    { path: string; action: string; count: number }
  >();
  for (const event of finalEvents) {
    const key = `${event.path}:${event.action}`;
    const current = eventCount.get(key) ?? {
      path: event.path,
      action: event.action,
      count: 0,
    };
    current.count += 1;
    eventCount.set(key, current);
  }
  for (const entry of eventCount.values()) {
    if (entry.count <= 1) continue;
    const stepIds = steps
      .filter((step) =>
        step.state.fsEvents.some(
          (event) => event.path === entry.path && event.action === entry.action,
        ),
      )
      .map((step) => step.id);
    add({
      kind: "redundancy",
      severity: 2,
      title: `Duplicate FS event: ${entry.action} ${entry.path}`,
      detail: `${entry.action} for ${entry.path} is recorded ${entry.count} time(s) in the final event log. The simulator emits a placeholder event and re-emits with the real step id — dedupe to keep the event log trustworthy.`,
      stepIds,
      paths: [entry.path],
    });
  }

  // 5. Redundancy: the same body written to multiple distinct paths
  const contentSeen = new Map<string, string[]>();
  for (const step of steps) {
    for (const [path, entry] of Object.entries(step.state.fs)) {
      if (entry.kind !== "file" || !entry.content) continue;
      const list = contentSeen.get(entry.content) ?? [];
      list.push(path);
      contentSeen.set(entry.content, list);
    }
  }
  for (const [content, paths] of contentSeen) {
    const unique = [...new Set(paths)];
    if (unique.length <= 1) continue;
    const writeStepIds = steps
      .filter((step) =>
        (step.filesWritten ?? []).some((p) => unique.includes(p)),
      )
      .map((step) => step.id);
    add({
      kind: "redundancy",
      severity: 1,
      title: `Identical content written to ${unique.length} paths`,
      detail: `${unique.join(", ")} all carry the same generated body (${content.trim().slice(0, 60)}…). Shared content should come from one template, then be copied per target.`,
      stepIds: writeStepIds,
      paths: unique,
    });
  }

  // 6. Redundancy: items planned in more than one build-plan visit
  const planVisits = new Map<string, number>();
  for (const step of steps) {
    if (step.phase !== "build-plan") continue;
    for (const node of step.state.plan) {
      planVisits.set(node.itemId, (planVisits.get(node.itemId) ?? 0) + 1);
    }
  }
  for (const [itemId, count] of planVisits) {
    if (count <= 1) continue;
    add({
      kind: "redundancy",
      severity: 1,
      title: `Re-planned node: ${itemId}`,
      detail: `${itemId} appears in ${count} build-plan snapshots. Multiple topo passes re-walk the same item — the final plan is what matters.`,
      stepIds: steps
        .filter((step) => step.phase === "build-plan")
        .map((step) => step.id),
      itemIds: [itemId],
    });
  }

  // 7. Bug risk: seed files overwritten
  const overwritten = redundantWrites.filter((entry) => entry.path);
  if (overwritten.length > 0) {
    const uniquePaths = [...new Set(overwritten.map((entry) => entry.path))];
    const stepIds = steps
      .filter(
        (step) => step.redundantWrite && (step.filesWritten ?? []).length > 0,
      )
      .map((step) => step.id);
    add({
      kind: "bug-risk",
      severity: 3,
      title: `Existing files overwritten`,
      detail: `${uniquePaths.join(", ")} already existed and were silently replaced. Data-loss risk — plan should surface a confirm-before-overwrite prompt.`,
      stepIds,
      paths: uniquePaths,
    });
  }

  // 8. Bug risk: missing conditions at done
  const doneStep = [...steps].reverse().find((step) => step.phase === "done");
  const finalMissing = doneStep?.state.missingConditions ?? [];
  if (finalMissing.length > 0) {
    add({
      kind: "bug-risk",
      severity: 2,
      title: `Uncaptured conditions: ${finalMissing.join(", ")}`,
      detail: `Simulation finished while ${finalMissing.join(", ")} were still missing from context. Templates using these keys would interpolate empty or throw.`,
      stepIds: steps
        .filter((step) => step.phase === "collect-conditions")
        .map((step) => step.id),
      conditionKeys: finalMissing,
    });
  }

  // 9. Bug risk: install with placeholder package manager
  const placeholderInstall = steps.find(
    (step) =>
      step.phase === "install-packages" &&
      step.state.installCommands?.some((argv) => argv[0] === "<pm>"),
  );
  if (placeholderInstall) {
    add({
      kind: "bug-risk",
      severity: 2,
      title: "Install ran with placeholder package manager",
      detail:
        "installCommands uses <pm> because packageManager gating could not be resolved. The install step proceeds with lockfile creation even though the command is not runnable.",
      stepIds: [placeholderInstall.id],
    });
  }

  // 10. Bug risk: a shared target declared by multiple different items
  const targetOwners = new Map<string, Set<string>>();
  const doneState = [...steps]
    .reverse()
    .find((step) => step.phase === "done")?.state;
  for (const payload of Object.values(doneState?.compiled ?? {})) {
    for (const file of payload.files) {
      const owners = targetOwners.get(file.target) ?? new Set<string>();
      owners.add(payload.itemId);
      targetOwners.set(file.target, owners);
    }
  }
  for (const [path, owners] of targetOwners) {
    if (owners.size <= 1) continue;
    const stepIds = steps
      .filter((step) => (step.filesWritten ?? []).includes(path))
      .map((step) => step.id);
    add({
      kind: "bug-risk",
      severity: owners.size >= 3 ? 3 : 2,
      title: `Colliding writers: ${path}`,
      detail: `${[...owners].join(", ")} each declare ${path}. Last writer wins and the write loop dedupes to a single step — ordering-dependent output and possible lost content; a merge/append policy is safer.`,
      stepIds: stepIds.length ? stepIds : [steps.at(-1)?.id ?? ""],
      itemIds: [...owners],
      paths: [path],
    });
  }

  return {
    findings,
    markedStepIndexes: [...allMarkedIndexes].sort((a, b) => a - b),
  };
}
