import fs from "node:fs";
import path from "node:path";
import {
	type CompiledItem,
	isMissingPathError,
	joinRelativePathUnderRoot,
	writeFileAsync,
} from "@yoinker/core";
import { primaryText } from "../cli/labels";
import { confirmInput } from "../cli/prompts";

/** One file that should be created or replaced on disk. */
export interface PlannedFileWrite {
	/** Relative target path from the payload. */
	target: string;
	/** Absolute destination under the project root. */
	destination: string;
	/** Interpolated file contents. */
	content: string;
	/** Absolute project root used to jail ancestor paths at write time. */
	projectDir: string;
}

/** Files to write for one install item. */
export interface PlannedItemWrites {
	/** Display label for progress. */
	label: string;
	/** Files that will be written (new or replacing existing). */
	files: PlannedFileWrite[];
}

/** Jailed write set for every payload file. */
export interface FileWritePlan {
	/** Items that have files to write, in plan order. */
	items: PlannedItemWrites[];
	/** Relative targets that already exist and will be replaced. */
	conflicts: string[];
}

/** One compiled item file target with its absolute destination. */
interface ResolvedCompiledItemTarget {
	/** Index of the source item in the install list. */
	itemIndex: number;
	/** Display label for progress. */
	label: string;
	/** Relative target path from the payload. */
	target: string;
	/** Absolute destination under the project root. */
	destination: string;
	/** Interpolated file contents. */
	content: string;
}

/**
 * Assert a destination has not already been claimed, then record it.
 * @param destination - Absolute destination path.
 * @param target - Relative target for error messages.
 * @param seenTargets - Destinations already claimed in this pass.
 * @throws Error when the destination was already claimed.
 */
function claimDestination(
	destination: string,
	target: string,
	seenTargets: Set<string>,
): void {
	if (seenTargets.has(destination))
		throw new Error(
			`Multiple compiled items write to the same target "${primaryText(target)}".`,
		);
	seenTargets.add(destination);
}

/**
 * Reject symbolic links on the destination's ancestor path under the project root.
 * @param projectDir - Absolute project root.
 * @param destination - Absolute destination path.
 * @param target - Relative target for error messages.
 * @throws Error when an ancestor directory is a symbolic link.
 */
async function assertAncestorPathHasNoSymlinks(
	projectDir: string,
	destination: string,
	target: string,
): Promise<void> {
	const root = path.resolve(projectDir);
	let current = path.dirname(path.resolve(destination));

	while (true) {
		try {
			const stat = await fs.promises.lstat(current);
			if (stat.isSymbolicLink())
				throw new Error(
					`Compiled item file target "${primaryText(target)}" path includes a symbolic link.`,
				);
		} catch (error) {
			if (!isMissingPathError(error)) throw error;
		}

		if (current === root) return;
		const parent = path.dirname(current);
		/* v8 ignore next -- filesystem root stop when jail root is not an ancestor */
		if (parent === current) return;
		current = parent;
	}
}

/**
 * Classify a destination that already exists as a file.
 * Uses `lstat` so a symlink is not treated as a regular file.
 * @param target - Relative compiled item target (for error messages).
 * @param destination - Absolute path under the project root.
 * @returns True when a file exists; false when missing.
 * @throws Error when the destination exists as a directory, symlink, or special node.
 */
async function destinationIsExistingFile(
	target: string,
	destination: string,
): Promise<boolean> {
	let stat: fs.Stats;
	try {
		stat = await fs.promises.lstat(destination);
	} catch (error) {
		if (isMissingPathError(error)) return false;
		throw error;
	}

	if (stat.isSymbolicLink())
		throw new Error(
			`Compiled item file target "${primaryText(target)}" exists and is a symbolic link.`,
		);
	if (stat.isDirectory())
		throw new Error(
			`Compiled item file target "${primaryText(target)}" exists and is a directory.`,
		);
	if (stat.isFile()) return true;
	throw new Error(
		`Compiled item file target "${primaryText(target)}" exists but is neither a file nor a directory.`,
	);
}

/**
 * Collect unique jailed destinations from labeled install items.
 * @param projectDir - Absolute project root.
 * @param items - Prepared items with display labels.
 * @returns Ordered destinations with payload content.
 * @throws Error when two files share a destination.
 */
function collectItemFileTargets(
	projectDir: string,
	items: Array<{ label: string; compiledItem: CompiledItem }>,
): ResolvedCompiledItemTarget[] {
	const seenTargets = new Set<string>();
	const targets: ResolvedCompiledItemTarget[] = [];

	for (const [itemIndex, { label, compiledItem }] of items.entries()) {
		for (const file of compiledItem.files) {
			// Jail the payload target under the project root before touching disk.
			const destination = joinRelativePathUnderRoot(
				projectDir,
				file.target,
				"Compiled item file target",
				"project directory",
			);
			claimDestination(destination, file.target, seenTargets);
			targets.push({
				itemIndex,
				label,
				target: file.target,
				destination,
				content: file.content,
			});
		}
	}

	return targets;
}

/**
 * Plan file writes: jail targets, reject duplicates, directories, and symlinks.
 * @param projectDir - Absolute project root.
 * @param items - Prepared items with display labels.
 * @returns Items that need writes, plus existing file targets.
 */
export async function planFileWrites(
	projectDir: string,
	items: Array<{ label: string; compiledItem: CompiledItem }>,
): Promise<FileWritePlan> {
	const plannedItems: PlannedItemWrites[] = [];
	const conflicts: string[] = [];
	const itemWrites = new Map<number, PlannedItemWrites>();

	for (const target of collectItemFileTargets(projectDir, items)) {
		await assertAncestorPathHasNoSymlinks(
			projectDir,
			target.destination,
			target.target,
		);
		const exists = await destinationIsExistingFile(
			target.target,
			target.destination,
		);
		if (exists) conflicts.push(target.target);

		let item = itemWrites.get(target.itemIndex);
		if (!item) {
			item = { label: target.label, files: [] };
			itemWrites.set(target.itemIndex, item);
			plannedItems.push(item);
		}
		item.files.push({
			target: target.target,
			destination: target.destination,
			content: target.content,
			projectDir,
		});
	}

	return { items: plannedItems, conflicts };
}

/**
 * Prompt once before replacing existing files that differ from the payload.
 * @param conflictingTargets - Relative targets that already exist with different content.
 * @param overwrite - Skip the prompt when true.
 * @throws Error when the user declines.
 */
export async function confirmFileOverwrites(
	conflictingTargets: string[],
	overwrite: boolean,
): Promise<void> {
	if (overwrite || conflictingTargets.length === 0) return;

	console.log();
	if (conflictingTargets.length === 1) {
		const target = conflictingTargets[0];
		const shouldOverwrite = await confirmInput(
			`Overwrite existing file ${primaryText(target)}?`,
			{},
			false,
		);
		if (!shouldOverwrite)
			throw new Error(
				`Installation canceled before overwriting ${primaryText(target)}.`,
			);
		console.log();
		return;
	}

	console.log("The following files already exist:");
	for (const target of conflictingTargets)
		console.log(`  - ${primaryText(target)}`);
	const shouldOverwrite = await confirmInput(
		"Overwrite these files?",
		{},
		false,
	);
	if (!shouldOverwrite)
		throw new Error("Installation canceled before overwriting existing files.");
	console.log();
}

/**
 * Write one planned file to disk.
 * Re-checks the destination so a path that became a directory or symlink after planning cannot be overwritten.
 * @param file - Jailed destination and contents.
 * @throws Error when the destination is a directory, symlink, or has a symlink ancestor.
 */
export async function writePlannedFile(file: PlannedFileWrite): Promise<void> {
	await assertAncestorPathHasNoSymlinks(
		file.projectDir,
		file.destination,
		file.target,
	);
	await destinationIsExistingFile(file.target, file.destination);
	await writeFileAsync(file.destination, file.content);
}
