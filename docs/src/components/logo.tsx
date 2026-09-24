import { cn } from "cn";

interface LogoProps {
  readonly className?: string;
}

export function Logo({ className }: LogoProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="200"
      height="200"
      viewBox="0 0 256 256"
      className={cn("size-5.5 shrink-0 text-primary", className)}
    >
      <title>Recipebook</title>
      <path
        fill="currentColor"
        d="M240 112a56.06 56.06 0 0 0-56-56c-1.77 0-3.54.1-5.29.26a56 56 0 0 0-101.42 0C75.54 56.1 73.77 56 72 56a56 56 0 0 0-24 106.59V208a16 16 0 0 0 16 16h128a16 16 0 0 0 16-16v-45.41A56.09 56.09 0 0 0 240 112m-48 96H64v-40.58a55.49 55.49 0 0 0 8 .58h112a55.49 55.49 0 0 0 8-.58Zm-8-56h-13.75l5.51-22.06a8 8 0 0 0-15.52-3.88L153.75 152H136v-24a8 8 0 0 0-16 0v24h-17.75l-6.49-25.94a8 8 0 1 0-15.52 3.88L85.75 152H72a40 40 0 0 1 0-80h.58a55.21 55.21 0 0 0-.58 8a8 8 0 0 0 16 0a40 40 0 0 1 80 0a8 8 0 0 0 16 0a55.21 55.21 0 0 0-.58-8h.58a40 40 0 0 1 0 80"
      />
    </svg>
  );
}
