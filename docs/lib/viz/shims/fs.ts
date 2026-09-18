/**
 * Node builtin shims so `@cheetos/core` plan/parse can load in the browser.
 * Only the symbols touched during simulation need to exist.
 */

export default {};

export function existsSync(): boolean {
  return false;
}

export function readFileSync(): string {
  throw new Error("fs.readFileSync is unavailable in the runtime viz");
}

export function readdirSync(): string[] {
  return [];
}

export const promises = {
  readFile: async () => {
    throw new Error("fs.promises.readFile is unavailable in the runtime viz");
  },
};
