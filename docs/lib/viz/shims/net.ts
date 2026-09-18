/** Minimal `node:net` shim — `isIP` is unused by plan/parse paths we call. */
export function isIP(_input: string): number {
  return 0;
}

export default { isIP };
