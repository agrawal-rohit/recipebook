import { text } from "@clack/prompts";
import { assertInteractiveStdin, throwIfCanceled } from "./internal";

/**
 * Prompt for a text input with optional validation and default.
 * @param message - Prompt message to display.
 * @param opts - Optional prompt configuration, including `required`.
 * @param defaultValue - Optional default value.
 * @returns Trimmed user input.
 * @throws {OperationCanceledError} When the user cancels.
 */
export async function textInput(
	message: string,
	opts: { placeholder?: string; required?: boolean } = {},
	defaultValue?: string,
): Promise<string> {
	assertInteractiveStdin(
		"Provide the value through a condition default, or re-run in a terminal.",
	);
	const raw = await text({
		message,
		...(opts.placeholder !== undefined && { placeholder: opts.placeholder }),
		...(defaultValue !== undefined && {
			initialValue: defaultValue,
			defaultValue,
		}),
		...(opts.required && {
			validate: (value) => (!value?.trim() ? "A value is required" : undefined),
		}),
	});

	throwIfCanceled(raw);
	if (typeof raw !== "string")
		throw new Error(`Text prompt "${message}" returned a non-string value.`);
	return raw.trim();
}
