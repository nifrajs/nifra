/** Run `hydrate` with `console.warn` sent to `warning`, where Svelte reports a hydration mismatch. */
export function warningsTo(
  warning: ((message: string) => void) | undefined,
  hydrate: () => unknown,
): void {
  if (warning === undefined) {
    hydrate()
    return
  }
  const originalWarn = console.warn
  console.warn = (...args) => warning(args.map(String).join(" "))
  try {
    hydrate()
  } finally {
    console.warn = originalWarn
  }
}
