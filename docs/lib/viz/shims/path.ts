/**
 * Minimal POSIX-ish path shim for browser bundling of `@cheetos/core`.
 */

export function isAbsolute(p: string): boolean {
  return p.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(p);
}

export function join(...parts: string[]): string {
  return parts
    .filter((part) => part.length > 0)
    .join("/")
    .replace(/\/+/g, "/");
}

export function resolve(...parts: string[]): string {
  const stack: string[] = [];
  for (const part of parts.join("/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") stack.pop();
    else stack.push(part);
  }
  return `/${stack.join("/")}`;
}

export function relative(from: string, to: string): string {
  const fromParts = resolve(from).split("/").filter(Boolean);
  const toParts = resolve(to).split("/").filter(Boolean);
  let i = 0;
  while (
    i < fromParts.length &&
    i < toParts.length &&
    fromParts[i] === toParts[i]
  )
    i++;
  const ups = fromParts.length - i;
  return [...Array(ups).fill(".."), ...toParts.slice(i)].join("/") || ".";
}

export default { isAbsolute, join, resolve, relative };
