/**
 * Presentational helpers for the runtime simulator player.
 */

import type {
  DepGraphEdge,
  DepGraphNode,
  FsEntry,
  ScriptLogEntry,
  SimState,
  SimStep,
  TraceFinding,
  TraceInsights,
} from "../engine/simulate";

function esc(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * Layered SVG dependency graph. Edges point from dependent → dependency.
 * @param graph - Current dep graph snapshot
 * @param highlight - Optional focus from the active step
 */
export function renderDepGraph(
  graph: SimState["depGraph"],
  highlight?: SimStep["highlight"],
): string {
  const nodes = graph.nodes;
  if (nodes.length === 0) {
    return `<div class="ui-empty-hint">Graph appears after dependency resolution.</div>`;
  }

  const highlightIds = new Set(highlight?.itemIds ?? []);
  const highlightEdges = new Set(
    (highlight?.edges ?? []).map((edge) => `${edge.from}->${edge.to}`),
  );

  const byLayer = new Map<number, DepGraphNode[]>();
  for (const node of nodes) {
    const list = byLayer.get(node.layer) ?? [];
    list.push(node);
    byLayer.set(node.layer, list);
  }
  const layers = [...byLayer.keys()].sort((a, b) => a - b);
  const maxCount = Math.max(
    ...layers.map((layer) => byLayer.get(layer)!.length),
    1,
  );

  const colW = 160;
  const rowH = 56;
  const padX = 24;
  const padY = 28;
  const width = Math.max(320, layers.length * colW + padX * 2);
  const height = Math.max(140, maxCount * rowH + padY * 2);

  const positions = new Map<string, { x: number; y: number }>();
  for (const layer of layers) {
    const col = byLayer.get(layer)!;
    col.forEach((node, index) => {
      const x = padX + layers.indexOf(layer) * colW + colW / 2;
      const span = (maxCount - col.length) * rowH;
      const y = padY + span / 2 + index * rowH + rowH / 2;
      positions.set(node.id, { x, y });
    });
  }

  const edgeEls = graph.edges
    .map((edge: DepGraphEdge) => {
      const a = positions.get(edge.from);
      const b = positions.get(edge.to);
      if (!a || !b) return "";
      const key = `${edge.from}->${edge.to}`;
      const active = highlightEdges.has(key);
      const midX = (a.x + b.x) / 2;
      return `<path class="edge${active ? " active" : ""}" d="M ${a.x - 36} ${a.y} C ${midX} ${a.y}, ${midX} ${b.y}, ${b.x + 36} ${b.y}" fill="none" marker-end="url(#arrow)" />`;
    })
    .join("");

  const nodeEls = nodes
    .map((node) => {
      const pos = positions.get(node.id)!;
      const short = node.id.length > 22 ? `${node.id.slice(0, 20)}…` : node.id;
      const hl = highlightIds.has(node.id);
      return `
				<g class="node status-${node.status}${hl ? " highlight" : ""}" transform="translate(${pos.x}, ${pos.y})">
					<title>${esc(node.title)} (${esc(node.id)})${node.packIds?.length ? `\npacks: ${node.packIds.join(", ")}` : ""}</title>
					<rect x="-52" y="-18" width="104" height="36" rx="6" />
					<text class="node-id" text-anchor="middle" dy="-2">${esc(short)}</text>
					<text class="node-meta" text-anchor="middle" dy="12">${esc(node.type ?? "")}${node.packIds?.length ? ` · ${esc(node.packIds.join("+"))}` : ""}</text>
				</g>`;
    })
    .join("");

  return `
		<svg class="dep-graph" viewBox="0 0 ${width} ${height}" role="img" aria-label="Dependency resolution graph">
			<defs>
				<marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
					<path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
				</marker>
			</defs>
			${edgeEls}
			${nodeEls}
		</svg>
		<div class="legend">
			<span><i class="swatch selected"></i> selected</span>
			<span><i class="swatch candidate"></i> candidate</span>
			<span><i class="swatch planned"></i> planned</span>
			<span><i class="swatch active"></i> active</span>
			<span><i class="swatch done"></i> done</span>
		</div>
		<p class="graph-caption">Columns are topo layers (left installs first). Arrows: dependent → dependency.</p>
	`;
}

/**
 * Ordered script execution rail.
 * @param log - Script log from state
 * @param highlightUris - URIs to emphasize
 */
export function renderScriptRail(
  log: ScriptLogEntry[],
  highlightUris: string[] = [],
): string {
  if (log.length === 0) {
    return `<div class="ui-empty-hint">No beforeWrite / afterInstall scripts on this plan yet.</div>`;
  }
  const hot = new Set(highlightUris);
  return `
		<ol class="script-rail">
			${log
        .map((entry) => {
          const name = entry.uri.split("/").pop() ?? entry.uri;
          return `
						<li class="script-item status-${entry.status}${hot.has(entry.uri) ? " highlight" : ""}">
							<span class="script-order">${entry.order}</span>
							<div>
								<strong>${esc(entry.phase)}</strong>
								<code>${esc(name)}</code>
								<span class="script-owner">${esc(entry.itemId)}</span>
							</div>
							<span class="script-status">${entry.status}</span>
						</li>`;
        })
        .join("")}
		</ol>`;
}

interface TreeNode {
  name: string;
  path: string;
  entry?: FsEntry;
  children: Map<string, TreeNode>;
}

function buildTree(fs: Record<string, FsEntry>): TreeNode {
  const root: TreeNode = { name: "", path: "", children: new Map() };
  const paths = Object.keys(fs).sort((a, b) => a.localeCompare(b));
  for (const path of paths) {
    const parts = path.split("/");
    let cursor = root;
    let acc = "";
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]!;
      acc = acc ? `${acc}/${part}` : part;
      if (!cursor.children.has(part)) {
        cursor.children.set(part, {
          name: part,
          path: acc,
          children: new Map(),
        });
      }
      cursor = cursor.children.get(part)!;
      if (i === parts.length - 1) cursor.entry = fs[path];
    }
  }
  return root;
}

function renderTreeNode(
  node: TreeNode,
  highlightFiles: Set<string>,
  depth: number,
): string {
  const kids = [...node.children.values()];
  if (node.path === "") {
    return kids
      .map((child) => renderTreeNode(child, highlightFiles, 0))
      .join("");
  }
  const entry = node.entry;
  const isDir = entry?.kind === "dir" || kids.length > 0;
  const hot = highlightFiles.has(node.path);
  const origin = entry?.origin ?? (isDir ? "seed" : "planned");
  const icon = isDir ? "▸" : "·";
  const childHtml = kids
    .map((child) => renderTreeNode(child, highlightFiles, depth + 1))
    .join("");
  return `
		<div class="fs-row origin-${origin}${hot ? " hot" : ""}" style="padding-left:${depth * 14}px">
			<span class="fs-icon">${icon}</span>
			<span class="fs-name">${esc(node.name)}</span>
			<span class="fs-origin">${origin}</span>
		</div>
		${childHtml}`;
}

/**
 * Live virtual filesystem tree.
 * @param fs - Filesystem snapshot
 * @param highlightFiles - Paths touched this step
 */
export function renderFileTree(
  fs: Record<string, FsEntry>,
  highlightFiles: string[] = [],
): string {
  const files = Object.values(fs).filter((entry) => entry.kind === "file");
  if (files.length === 0) {
    return `<div class="ui-empty-hint">Filesystem is empty.</div>`;
  }
  const tree = buildTree(fs);
  const hot = new Set(highlightFiles);
  const recent = files
    .filter((entry) => entry.touchedBy && hot.has(entry.path))
    .map((entry) => entry.path);
  return `
		<div class="fs-tree" role="tree" aria-label="Virtual project filesystem">
			${renderTreeNode(tree, hot, 0)}
		</div>
		${
      recent.length
        ? `<p class="fs-pulse">Touched now: ${recent.map((path) => `<code>${esc(path)}</code>`).join(", ")}</p>`
        : ""
    }`;
}

/**
 * Compact context chips.
 * @param context - Registry context map
 */
export function renderContextChips(context: SimState["context"]): string {
  const entries = Object.entries(context);
  if (entries.length === 0) {
    return `<span class="ui-chip" data-tone="muted">empty</span>`;
  }
  return entries
    .map(([key, value]) => {
      const display = Array.isArray(value)
        ? value.join("+")
        : String(value ?? "");
      return `<span class="ui-chip">${esc(key)}=${esc(display)}</span>`;
    })
    .join("");
}

const KIND_LABEL: Record<TraceFinding["kind"], string> = {
  hotspot: "hotspot",
  redundancy: "redundancy",
  "bug-risk": "bug risk",
};

/**
 * Grouped insights panel. Findings are bucketed by kind; each row lists its
 * affected items/paths and exposes its first step index via `data-jump-step`
 * so the player can jump to it.
 * @param insights - Detector pass output
 * @param steps - Ordered trace steps, used to resolve finding → step index
 */
export function renderInsights(
  insights: TraceInsights,
  steps: readonly SimStep[] = [],
): string {
  const findings = insights.findings;
  if (findings.length === 0) {
    return `<div class="ui-empty-hint">No hotspots, redundant operations, or bug risks detected.</div>`;
  }
  const firstStepIndex = (finding: TraceFinding): number => {
    const id = finding.stepIds[0] ?? "";
    const index = steps.findIndex((step) => step.id === id);
    return index >= 0 ? index : -1;
  };
  const byKind = (kind: TraceFinding["kind"]) =>
    findings
      .filter((finding) => finding.kind === kind)
      .sort((a, b) => b.severity - a.severity);

  const renderGroup = (kind: TraceFinding["kind"], label: string): string => {
    const items = byKind(kind);
    if (items.length === 0) return "";
    return `
			<section class="insights-group kind-${kind}">
				<h4>${esc(label)} <span class="count">${items.length}</span></h4>
				<ul>
					${items
            .map((finding) => {
              const index = firstStepIndex(finding);
              const chips = [
                ...(finding.itemIds ?? []).map((id) => `item:${id}`),
                ...(finding.paths ?? []).map((path) => `path:${path}`),
                ...(finding.conditionKeys ?? []).map((key) => `key:${key}`),
              ]
                .slice(0, 4)
                .map((chip) => `<code>${esc(chip)}</code>`)
                .join(" ");
              return `
								<li class="finding sev-${finding.severity}">
									${index >= 0 ? `<button class="finding-jump" type="button" data-jump-step="${index}" title="Jump to first affected step">§</button>` : `<span class="finding-kind">—</span>`}
									<div>
										<strong>${esc(finding.title)}</strong>
										<p>${esc(finding.detail)}</p>
										${chips ? `<div class="finding-chips">${chips}</div>` : ""}
									</div>
									<span class="finding-kind">${KIND_LABEL[finding.kind]}</span>
								</li>`;
            })
            .join("")}
				</ul>
			</section>`;
  };

  return `
		<div class="insights">
			${renderGroup("bug-risk", "Bug risks")}
			${renderGroup("hotspot", "Hotspots")}
			${renderGroup("redundancy", "Redundant operations")}
		</div>`;
}
