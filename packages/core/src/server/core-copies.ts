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
const registry = globalThis as Record<symbol, string[] | undefined>
const COPIES = Symbol.for("nifra.core.copies")
const VERSIONS = Symbol.for("nifra.core.copy-versions")
registry[COPIES] ??= []
const copies = registry[COPIES]
const here = String(import.meta.url).split("?")[0] as string

if (!copies.includes(here) && copies.push(here) > 1) {
  // The registrar marks the process when it installs; without the mark a declared singleCopy was never
  // armed here, most often because bunfig.toml's preload line sits below a [table] header. Bun-only and
  // behind the inline NODE_ENV literal, so a production bundle drops the hint.
  console.warn(
    `[nifra] @nifrajs/core is loaded ${copies.length} times; \`nifra check\` names each importer:\n  ${copies.join("\n  ")}${typeof Bun !== "undefined" && process.env.NODE_ENV !== "production" && !(Symbol.for("nifra.single-copy.active") in globalThis) ? "\n  No single-copy registrar ran in this process: bunfig.toml must preload @nifrajs/core/single-copy/register at its top level, above any [table], for bun run, and under [test] for bun test." : ""}`,
  )
}

/** This copy's version: a literal like the package root's `VERSION` (no fs on the edge), which
 * `scripts/version.ts` rewrites on every release and `check:publish` asserts. */
const COPY_VERSION = "5.8.0"

/** Record this copy's version beside its URL. Called by each `server()` behind the development guard,
 * so a production bundle drops it with the version; a copy that built a server has recorded one. */
export function recordCopyVersion(): void {
  versionsByUrl().set(here, COPY_VERSION)
}

/** The process-wide URL -> version map every copy shares. */
const versionsByUrl = (): Map<unknown, unknown> => {
  const found: unknown = Reflect.get(globalThis, VERSIONS)
  if (found instanceof Map) return found
  const created = new Map<unknown, unknown>()
  Reflect.set(globalThis, VERSIONS, created)
  return created
}

const labelled = (url: string): string => {
  const version = versionsByUrl().get(url)
  return typeof version === "string" ? `${url} (${version})` : url
}

/** Why `merge()` refused a value that is not a server of this copy: when another copy is loaded, the
 * value is most likely its server, so both copies are named, with their versions where recorded
 * (copies before 5.2 record none), and the way to collapse them. Called only outside production. */
export function mergeRefusal(): string {
  const base = "merge() requires a server() from this copy of @nifrajs/core"
  const others = copies.filter((url) => url !== here)
  if (others.length === 0) return base
  return [
    `${base}, and ${copies.length} copies are loaded:`,
    `  this copy:  ${labelled(here)}`,
    ...others.map((url) => `  other copy: ${labelled(url)}`),
    "A server() from another copy cannot be merged. Make every package that builds a server() resolve one copy: in a linked repository, install the same nifra version (`nifra upgrade <version> --write`, then `bun install`); `nifra doctor` names each importer.",
  ].join("\n")
}
