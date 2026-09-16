import Image from "next/image";
import type { CSSProperties } from "react";

import darkSrc from "./dark-logo.svg";
import lightSrc from "./light-logo.svg";

type Props = Readonly<{
	className?: string;
	style?: CSSProperties;
}>;

function logoUrl(imported: string | { src?: string }): string {
	return typeof imported === "string" ? imported : (imported.src ?? "");
}

export default function Logo({ className, style }: Props) {
	const imgClassName = className ?? "h-6 w-auto";

	return (
		<>
			<Image
				src={logoUrl(lightSrc)}
				alt="Cheetos"
				width={120}
				height={24}
				style={style}
				className={`${imgClassName} block dark:hidden`}
				draggable={false}
				unoptimized
			/>
			<Image
				src={logoUrl(darkSrc)}
				alt="Cheetos"
				width={120}
				height={24}
				style={style}
				className={`${imgClassName} hidden dark:block`}
				draggable={false}
				unoptimized
			/>
		</>
	);
}
