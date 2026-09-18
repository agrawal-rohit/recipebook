/**
 * Interactive player for the Cheetos add-runtime simulation.
 */

import registryJson from "../../../packages/registry/registry.json";
import { type Scenario, scenarios } from "./engine/scenarios";
import {
  type SimStep,
  type SimulationTrace,
  simulateAdd,
} from "./engine/simulate";
import {
  renderContextChips,
  renderDepGraph,
  renderFileTree,
  renderInsights,
  renderScriptRail,
} from "./ui/views";
import "./styles.css";

const SPEEDS = [0.5, 1, 1.5, 2, 4, 8] as const;

export type PlayerHandle = {
  destroy: () => void;
};

interface PlayerState {
  scenarioId: string;
  trace: SimulationTrace;
  index: number;
  playing: boolean;
  speed: (typeof SPEEDS)[number];
}

function runScenario(scenario: Scenario): SimulationTrace {
  return simulateAdd({
    registry: registryJson,
    selectedItems: scenario.selectedItems,
    context: scenario.context,
    packageManager: scenario.packageManager,
    seedFs: scenario.seedFs,
  });
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

/**
 * Mount the teaching simulator into a host element.
 * @param root - Element that receives the player DOM
 */
export function mountPlayer(root: HTMLElement): PlayerHandle {
  let timer: number | undefined;
  const initial = scenarios[0];
  if (!initial) throw new Error("No scenarios defined");

  const state: PlayerState = {
    scenarioId: initial.id,
    trace: runScenario(initial),
    index: 0,
    playing: false,
    speed: 1,
  };

  const stopTimer = (): void => {
    if (timer !== undefined) {
      window.clearTimeout(timer);
      timer = undefined;
    }
  };

  const scheduleNext = (): void => {
    stopTimer();
    if (!state.playing) return;
    const step = state.trace.steps[state.index];
    if (!step || state.index >= state.trace.steps.length - 1) {
      state.playing = false;
      render();
      return;
    }
    const wait = Math.max(60, step.durationMs / state.speed);
    timer = window.setTimeout(() => {
      state.index += 1;
      render();
      scheduleNext();
    }, wait);
  };

  const selectScenario = (id: string): void => {
    const scenario = scenarios.find((entry) => entry.id === id);
    if (!scenario) return;
    stopTimer();
    state.scenarioId = id;
    state.trace = runScenario(scenario);
    state.index = 0;
    state.playing = false;
    render();
  };

  const currentStep = (): SimStep | undefined => state.trace.steps[state.index];

  const bindControls = (steps: SimStep[]): void => {
    root
      .querySelectorAll<HTMLButtonElement>("[data-scenario]")
      .forEach((button) => {
        button.addEventListener("click", () => {
          const id = button.dataset.scenario;
          if (id) selectScenario(id);
        });
      });

    root
      .querySelectorAll<HTMLButtonElement>("[data-step]")
      .forEach((button) => {
        button.addEventListener("click", () => {
          const index = Number(button.dataset.step);
          if (!Number.isFinite(index)) return;
          stopTimer();
          state.playing = false;
          state.index = index;
          render();
        });
      });

    root
      .querySelectorAll<HTMLButtonElement>("[data-jump-step]")
      .forEach((button) => {
        button.addEventListener("click", () => {
          const index = Number(button.dataset.jumpStep);
          if (!Number.isFinite(index)) return;
          stopTimer();
          state.playing = false;
          state.index = index;
          render();
        });
      });

    root
      .querySelector('[data-action="play"]')
      ?.addEventListener("click", () => {
        if (state.playing) {
          state.playing = false;
          stopTimer();
          render();
          return;
        }
        if (state.index >= steps.length - 1) state.index = 0;
        state.playing = true;
        render();
        scheduleNext();
      });

    root
      .querySelector('[data-action="prev"]')
      ?.addEventListener("click", () => {
        stopTimer();
        state.playing = false;
        state.index = Math.max(0, state.index - 1);
        render();
      });

    root
      .querySelector('[data-action="next"]')
      ?.addEventListener("click", () => {
        stopTimer();
        state.playing = false;
        state.index = Math.min(steps.length - 1, state.index + 1);
        render();
      });

    root
      .querySelector('[data-action="reset"]')
      ?.addEventListener("click", () => {
        stopTimer();
        state.playing = false;
        state.index = 0;
        render();
      });

    root
      .querySelector<HTMLSelectElement>('[data-action="speed"]')
      ?.addEventListener("change", (event) => {
        const value = Number((event.target as HTMLSelectElement).value);
        if (SPEEDS.includes(value as (typeof SPEEDS)[number])) {
          state.speed = value as (typeof SPEEDS)[number];
          if (state.playing) scheduleNext();
        }
      });
  };

  const render = (): void => {
    const scenario =
      scenarios.find((entry) => entry.id === state.scenarioId) ?? scenarios[0]!;
    const step = currentStep();
    const steps = state.trace.steps;
    const err = state.trace.error;
    const snapshot = step?.state ?? state.trace.final;
    const fileCount = Object.values(snapshot.fs).filter(
      (entry) => entry.kind === "file",
    ).length;

    const insights = state.trace.insights;
    const markedIndexes = new Set(insights?.markedStepIndexes ?? []);
    const findingsAt = new Map<
      number,
      Array<{ kind: string; title: string; severity: number }>
    >();
    for (const finding of insights?.findings ?? []) {
      const first = steps.findIndex((entry) => entry.id === finding.stepIds[0]);
      if (first < 0) continue;
      const list = findingsAt.get(first) ?? [];
      list.push({
        kind: finding.kind,
        title: finding.title,
        severity: finding.severity,
      });
      findingsAt.set(first, list);
    }
    const stepFindings = findingsAt.get(state.index) ?? [];

    root.innerHTML = `
			<header class="hero">
				<p class="ui-eyebrow">cheetos add · teaching simulator</p>
				<h1>Runtime walkthrough</h1>
				<p>
					Watch graph resolution, script order, and a live virtual filesystem
					as real <code>@cheetos/core</code> planning runs — then simulated
					hooks, writes, and installs.
				</p>
			</header>
			<div class="layout">
				<aside class="ui-panel scenarios-panel">
					<h2 class="ui-panel-title">Scenarios</h2>
					<div class="scenario-list" role="listbox" aria-label="Teaching scenarios">
						${scenarios
              .map(
                (entry) => `
							<button
								type="button"
								class="scenario ${entry.id === state.scenarioId ? "active" : ""}"
								data-scenario="${entry.id}"
								role="option"
								aria-selected="${entry.id === state.scenarioId}"
							>
								<strong>${entry.label}</strong>
								<span>${entry.description}</span>
							</button>`,
              )
              .join("")}
					</div>
					<div class="scenario-meta">
						<div><span>roots</span><code>${scenario.selectedItems.join(", ")}</code></div>
						${scenario.packageManager ? `<div><span>pm</span><code>${scenario.packageManager}</code></div>` : ""}
						<div><span>context</span><div class="ui-chip-row">${renderContextChips(scenario.context)}</div></div>
					</div>
				</aside>
				<main class="stage">
					<div class="ui-panel transport-panel">
						<div class="transport" role="group" aria-label="Playback">
							<button type="button" class="primary" data-action="play">
								${state.playing ? "Pause" : "Play"}
							</button>
							<button type="button" data-action="prev" ${state.index === 0 ? "disabled" : ""}>Prev</button>
							<button type="button" data-action="next" ${state.index >= steps.length - 1 ? "disabled" : ""}>Next</button>
							<button type="button" data-action="reset">Reset</button>
							<label>
								Speed
								<select data-action="speed" aria-label="Playback speed">
									${SPEEDS.map(
                    (speed) =>
                      `<option value="${speed}" ${speed === state.speed ? "selected" : ""}>${speed}×</option>`,
                  ).join("")}
								</select>
							</label>
							<span class="clock" aria-live="polite">
								${step ? `${formatMs(step.t0)}→${formatMs(step.t1)}` : "—"}
								· ${formatMs(state.trace.totalDurationMs)} total
								· ${steps.length ? state.index + 1 : 0}/${steps.length}
								· ${snapshot.depGraph.nodes.length} nodes
								· ${fileCount} files
							</span>
						</div>

						<div class="timeline" role="slider" aria-label="Step timeline" aria-valuemin="1" aria-valuemax="${Math.max(1, steps.length)}" aria-valuenow="${state.index + 1}">
							${steps
                .map((entry, index) => {
                  const height = Math.max(
                    8,
                    Math.min(32, Math.round(entry.durationMs / 5)),
                  );
                  const isError = err !== undefined && index === err.stepIndex;
                  const cls = [
                    index < state.index ? "done" : "",
                    index === state.index ? "active" : "",
                    isError ? "error" : "",
                    markedIndexes.has(index) ? "marked" : "",
                    entry.phase,
                  ]
                    .filter(Boolean)
                    .join(" ");
                  return `<button type="button" class="${cls}" data-step="${index}" title="${entry.phase}: ${entry.title} (${formatMs(entry.durationMs)})${markedIndexes.has(index) ? " · finding" : ""}" style="height:${height}px" aria-label="Step ${index + 1}: ${entry.title}"></button>`;
                })
                .join("")}
						</div>

						<section class="step-card ${err && step && steps[err.stepIndex] === step ? "error" : ""}" aria-live="polite">
							<div class="step-meta">
								<span class="ui-phase-pill">${step?.phase ?? "—"}</span>
								<span>${step ? formatMs(step.durationMs) : "—"}</span>
								<span>${step?.id ?? "—"}</span>
							</div>
							<h3>${step?.title ?? "No steps"}</h3>
							<p>${step?.detail ?? "Choose a scenario and press Play."}</p>
							${stepFindings.length ? `<div class="step-findings">${stepFindings.map((finding) => `<span class="ui-finding-chip" data-kind="${finding.kind}">${finding.title}</span>`).join("")}</div>` : ""}
							${err ? `<p class="error-line">Stopped: ${err.message}</p>` : ""}
						</section>
					</div>

					<section class="ui-panel viz-panel">
						<h2 class="ui-panel-title">Graph resolution</h2>
						${renderDepGraph(snapshot.depGraph, step?.highlight)}
					</section>

					<section class="ui-panel viz-panel insights-panel">
						<h2 class="ui-panel-title">Insights <span class="count">${insights?.findings.length ?? 0}</span></h2>
						${insights ? renderInsights(insights, steps) : `<div class="ui-empty-hint">Waiting for a trace.</div>`}
					</section>

					<div class="split">
						<section class="ui-panel viz-panel">
							<h2 class="ui-panel-title">Script execution order</h2>
							${renderScriptRail(snapshot.scriptLog, step?.highlight?.scriptUris)}
						</section>
						<section class="ui-panel viz-panel">
							<h2 class="ui-panel-title">Virtual filesystem</h2>
							${renderFileTree(snapshot.fs, step?.highlight?.files)}
						</section>
					</div>

					<section class="ui-panel viz-panel compact">
						<h2 class="ui-panel-title">Install plan</h2>
						<div class="plan-flow">
							${
                snapshot.plan.length === 0
                  ? `<span class="ui-chip" data-tone="muted">empty until build-plan</span>`
                  : snapshot.plan
                      .map((node, index) => {
                        const hot = step?.highlight?.itemIds?.includes(
                          node.itemId,
                        );
                        return `${index > 0 ? `<span class="arrow">→</span>` : ""}<span class="ui-chip"${hot ? ' data-tone="amber"' : ""}>${node.itemId}${node.packIds?.length ? `@${node.packIds.join("+")}` : ""}</span>`;
                      })
                      .join("")
              }
						</div>
						<div class="ui-chip-row context-row">
							${renderContextChips(snapshot.context)}
							${snapshot.packageManager ? `<span class="ui-chip" data-tone="amber">packageManager=${snapshot.packageManager}</span>` : ""}
							${snapshot.missingConditions.map((key) => `<span class="ui-chip" data-tone="rose">missing:${key}</span>`).join("")}
						</div>
					</section>

					<div class="ui-note">
						Timing is simulated. Hooks and package installs are not executed for real —
						the filesystem and script rail show what the runtime would touch, in order.
					</div>
				</main>
			</div>
		`;

    bindControls(steps);
  };

  render();

  return {
    destroy: () => {
      stopTimer();
      root.replaceChildren();
    },
  };
}
