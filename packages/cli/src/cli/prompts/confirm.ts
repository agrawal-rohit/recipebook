import { confirm } from "@clack/prompts";
import { assertInteractiveStdin, throwIfCanceled } from "./internal";

/**
 * Prompt for a boolean confirmation.
 * @param message - Prompt message to display.
 * @param opts - Optional confirm prompt configuration.
 * @param defaultValue - Optional default boolean value.
 * @returns User confirmation result.
 * @throws {OperationCanceledError} When the user cancels.
 * @throws Error when the prompt result is not a boolean.
 */
export async function confirmInput(
	message: string,
	opts: { active?: string; inactive?: string } = {},
	defaultValue?: boolean,
): Promise<boolean> {
	assertInteractiveStdin(
		"Pass --overwrite to replace existing files, or re-run in a terminal.",
	);
	const res = await confirm({
		message,
		...opts,
		...(defaultValue !== undefined ? { initialValue: defaultValue } : {}),
	});

	throwIfCanceled(res);
	if (typeof res !== "boolean")
		throw new Error(
			`Confirm prompt "${message}" returned a non-boolean value.`,
		);
	return res;
}
