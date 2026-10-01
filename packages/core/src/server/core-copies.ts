/**
 * Two physical copies of `@nifrajs/core` in one process (a linked sibling checkout, a nested install)
 * split every piece of module-scoped identity: a route from one copy's `server()` merged into the
 * other answers 500 from an internal TypeError as soon as it sets a cookie. The install is the
 * defect, so it is named the moment the second copy loads, not at the first failing request.
 * `nifra check` is the gate that fails the build on it; this is the runtime notice.
 *
 * Each copy records its module URL in a process-wide list. The query is dropped, so a dev server that
 * re-evaluates this same file (HMR, `--hot`) is one copy, not two.
 */
const registry = globalThis as unknown as Record<symbol, string[] | undefined>
const COPIES = Symbol.for("nifra.core.copies")
registry[COPIES] ??= []
const copies = registry[COPIES]
const here = String(import.meta.url).split("?")[0] as string

if (!copies.includes(here) && copies.push(here) > 1) {
  console.warn(
    `[nifra] @nifrajs/core is loaded ${copies.length} times; \`nifra check\` names each importer:\n  ${copies.join("\n  ")}`,
  )
}
