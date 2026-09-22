import {
	type DefaultRenderer,
	Listr,
	type ListrTaskWrapper,
	type SimpleRenderer,
} from "listr2";

/** A single executable subtask, optionally with nested children. */
export interface Subtask {
	/** Subtask title shown in the nested list. */
	title: string;
	/** Async work for this subtask. Omit when this node only groups children. */
	task?: () => Promise<void>;
	/** Nested subtasks shown under this title. */
	subtasks?: Subtask[];
}

/**
 * Create a leaf subtask.
 * @param title - Task title.
 * @param task - Task function.
 * @returns A subtask object.
 */
export function task(title: string, task: () => Promise<void>): Subtask {
	return { title, task };
}

/**
 * Create a parent subtask that only groups nested work.
 * @param title - Group title.
 * @param subtasks - Nested subtasks. Must be non-empty.
 * @returns A subtask object.
 * @throws Error when `subtasks` is empty.
 */
export function taskGroup(title: string, subtasks: Subtask[]): Subtask {
	if (subtasks.length === 0)
		throw new Error(`Task group "${title}" has no work.`);
	return { title, subtasks };
}

/** Listr parent wrapper used to nest subtasks. */
type TaskParent = ListrTaskWrapper<
	unknown,
	typeof DefaultRenderer,
	typeof SimpleRenderer
>;

/**
 * Convert CLI subtasks into Listr task configs, including nested groups.
 * @param subtasks - Nested subtask tree.
 * @param collapseErrors - Renderer option forwarded to nested lists.
 * @returns Listr task objects.
 */
function toListrTasks(
	subtasks: Subtask[],
	collapseErrors: boolean,
): Array<{
	title: string;
	task: (_ctx: unknown, parent: TaskParent) => Promise<unknown>;
}> {
	return subtasks.map((subtask) => ({
		title: subtask.title,
		task: async (_ctx: unknown, parent: TaskParent) => {
			if (subtask.subtasks && subtask.subtasks.length > 0) {
				if (subtask.task) await subtask.task();
				return parent.newListr(toListrTasks(subtask.subtasks, collapseErrors), {
					rendererOptions: { collapseErrors },
				});
			}
			if (!subtask.task)
				throw new Error(`Subtask "${subtask.title}" has no work.`);
			await subtask.task();
		},
	}));
}

/**
 * Run work under a Listr goal title, either as a single async unit or nested subtasks.
 * @param title - Overall goal title (e.g. `"Preparing package"`).
 * @param work - Single async unit of work, or nested subtasks. Required.
 * @param opts - Optional rendering behavior.
 * @throws Error when `work` is an empty subtask list.
 */
export async function runWithTasks(
	title: string,
	work: (() => Promise<void>) | Subtask[],
	opts: { collapseErrors?: boolean } = {},
): Promise<void> {
	const isSubtasks = Array.isArray(work);
	if (isSubtasks && work.length === 0)
		throw new Error(`Task "${title}" has no work.`);

	const collapseErrors = opts.collapseErrors ?? true;
	const tasks = new Listr(
		[
			{
				title,
				task: async (_ctx: unknown, parent: TaskParent) => {
					if (!isSubtasks) {
						await work();
						return;
					}

					return parent.newListr(toListrTasks(work, collapseErrors), {
						rendererOptions: { collapseErrors },
					});
				},
			},
		],
		{
			silentRendererCondition: !process.stdout.isTTY,
			rendererOptions: {
				collapseErrors,
			},
		},
	);

	await tasks.run();
}
