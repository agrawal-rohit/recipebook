import type { BeforeWriteHook } from "@cheetos/core";
import * as spdxLicenseList from "spdx-license-list/full";

const licenses = spdxLicenseList as unknown as Record<
	string,
	{ name: string; licenseText: string }
>;

/** Placeholders that need year / copyright holder substitution. */
const COPYRIGHT_PLACEHOLDER =
	/<year>|<copyright holders>|<owner>|<name of author>/;

/**
 * Fill SPDX license text from already-captured conditions and update LICENSE.
 * @param ctx - Install hook context with license conditions captured.
 * @returns LICENSE file to update in the working compiled item.
 */
const beforeWrite: BeforeWriteHook = async (ctx) => {
	const licenseId = ctx.conditions.licenseId;
	if (typeof licenseId !== "string" || licenseId.length === 0)
		throw new Error('Condition "licenseId" is required to generate LICENSE.');

	const entry = licenses[licenseId];
	if (!entry) throw new Error(`Unknown SPDX license id "${licenseId}".`);

	let licenseText = entry.licenseText;
	if (COPYRIGHT_PLACEHOLDER.test(licenseText)) {
		const holder = ctx.conditions.authorName;
		const year = ctx.conditions.copyrightYear;
		if (typeof holder !== "string" || holder.length === 0)
			throw new Error(
				'Condition "authorName" is required for licenses with a copyright holder.',
			);
		if (typeof year !== "string" || year.length === 0)
			throw new Error(
				'Condition "copyrightYear" is required for licenses with a copyright year.',
			);

		licenseText = licenseText
			.replaceAll("<year>", year)
			.replaceAll("<copyright holders>", holder)
			.replaceAll("<owner>", holder)
			.replaceAll("<name of author>", holder);
	}

	return {
		files: [{ target: "LICENSE", content: licenseText }],
	};
};

export default beforeWrite;
