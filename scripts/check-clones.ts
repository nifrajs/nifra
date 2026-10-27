/**
 * Clone ratchet: no package's own sources may gain duplicated code.
 *
 * Every tracked `packages/<name>/src` file is cut into tokens, and every run of at least
 * {@link WINDOW} identical tokens that appears twice inside one package is a clone. A package's count
 * is its tokens that lie inside a clone, every copy included. No count may rise above the committed
 * baseline, so the duplication that exists is frozen and new code reuses instead of copying.
 *
 * ## What it does NOT cover
 *
 * Copies across packages: a zero-dependency adapter keeps its own copy of a helper on purpose. The
 * generated copies are `check:vendored`'s, and the per-package helper owners `noHelperCopy`'s. Runs
 * shorter than the window, and copies with renamed identifiers, are not counted either.
 *
 * ## Usage
 *
 *   bun run check:clones                             # verify no package gained cloned tokens
 *   bun run check:clones --update                    # lower the baseline to the current counts
 *   bun run check:clones --update --accept-increase  # ...and raise the entries that grew
 *
 * `--update` is lower-only for the coverage ratchet's reason, and raising a count takes a second flag
 * that prints every entry it raised.
 */

import { spawnSync } from "node:child_process"
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import ts from "typescript"
import { codeUnitOrder } from "./code-unit-order.ts"

const ROOT = join(import.meta.dir, "..")
const DEFAULT_BASELINE = join(ROOT, "clones-baseline.json")

/** Tokens a run must share to count: shorter repeats are idiom, not copies. */
export const WINDOW = 60
// A window seen more often than this is boilerplate shared by many files, not one copied block.
const BUCKET_CAP = 24
// Clones listed per package that grew; the longest come first.
const REPORTED = 20

export interface SourceText {
  readonly path: string
  readonly text: string
}

interface Token {
  readonly id: number
  readonly line: number
}

/** The file's tokens without its imports, re-exports and comments, each interned through `ids`. */
export function tokenize(file: SourceText, ids: Map<string, number>): Token[] {
  const kind = file.path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const source = ts.createSourceFile(file.path, file.text, ts.ScriptTarget.Latest, true, kind)
  const tokens: Token[] = []
  const visit = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node) ||
      (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined) ||
      ts.isJSDoc(node)
    )
      return
    const children = node.getChildren(source)
    if (children.length > 0) {
      for (const child of children) visit(child)
      return
    }
    if (node.kind === ts.SyntaxKind.EndOfFileToken || node.kind === ts.SyntaxKind.SyntaxList) return
    const text = node.getText(source)
    let id = ids.get(text)
    if (id === undefined) {
      id = ids.size + 1
      ids.set(text, id)
    }
    const start = node.getStart(source)
    tokens.push({ id, line: source.getLineAndCharacterOfPosition(start).line + 1 })
  }
  visit(source)
  return tokens
}

export interface CloneSite {
  readonly path: string
  readonly firstLine: number
  readonly lastLine: number
}

/** One run of at least WINDOW tokens that two places in a package share. */
export interface Clone {
  readonly pkg: string
  readonly tokens: number
  readonly a: CloneSite
  readonly b: CloneSite
}

const packageOf = (path: string): string => path.split("/")[1] ?? path

interface Diagonal {
  readonly fileA: number
  readonly fileB: number
  readonly offset: number
  readonly starts: number[]
}

/** Tokens inside a clone, every copy included, per package. */
export type Counts = Record<string, number>

/** The clones inside each package, and each package's tokens that lie inside one. */
export function findClones(files: readonly SourceText[]): {
  readonly clones: Clone[]
  readonly counts: Counts
} {
  const ids = new Map<string, number>()
  const streams = files.map((file) => tokenize(file, ids))

  const buckets = new Map<string, Array<readonly [number, number]>>()
  streams.forEach((tokens, file) => {
    for (let at = 0; at + WINDOW <= tokens.length; at++) {
      let h1 = 2166136261
      let h2 = 5381
      for (let k = at; k < at + WINDOW; k++) {
        const id = tokens[k]?.id ?? 0
        h1 = Math.imul(h1 ^ id, 16777619)
        h2 = (Math.imul(h2, 33) + id) | 0
      }
      const key = `${h1}:${h2}`
      const bucket = buckets.get(key)
      if (bucket === undefined) buckets.set(key, [[file, at]])
      else if (bucket.length <= BUCKET_CAP) bucket.push([file, at])
    }
  })

  // Matching windows on one diagonal (same pair of files, same offset) chain into one run.
  const diagonals = new Map<string, Diagonal>()
  for (const bucket of buckets.values()) {
    if (bucket.length < 2 || bucket.length > BUCKET_CAP) continue
    bucket.forEach(([fileA, atA], x) => {
      for (const [fileB, atB] of bucket.slice(x + 1)) {
        if (packageOf(files[fileA]?.path ?? "") !== packageOf(files[fileB]?.path ?? "")) continue
        if (fileA === fileB && Math.abs(atA - atB) < WINDOW) continue
        const offset = atA - atB
        const key = `${fileA}:${fileB}:${offset}`
        const diagonal = diagonals.get(key)
        if (diagonal === undefined) diagonals.set(key, { fileA, fileB, offset, starts: [atA] })
        else diagonal.starts.push(atA)
      }
    })
  }

  const covered = streams.map((tokens) => new Uint8Array(tokens.length))
  const site = (file: number, start: number, end: number): CloneSite => {
    covered[file]?.fill(1, start, end + 1)
    const tokens = streams[file] ?? []
    return {
      path: files[file]?.path ?? "",
      firstLine: tokens[start]?.line ?? 0,
      lastLine: tokens[end]?.line ?? 0,
    }
  }
  const clones: Clone[] = []
  for (const { fileA, fileB, offset, starts } of diagonals.values()) {
    starts.sort((x, y) => x - y)
    let first = starts[0] ?? 0
    let last = first
    const flush = (): void => {
      clones.push({
        pkg: packageOf(files[fileA]?.path ?? ""),
        tokens: last - first + WINDOW,
        a: site(fileA, first, last + WINDOW - 1),
        b: site(fileB, first - offset, last - offset + WINDOW - 1),
      })
    }
    for (const at of starts.slice(1)) {
      if (at === last + 1) {
        last = at
        continue
      }
      flush()
      first = at
      last = at
    }
    flush()
  }

  const counts: Counts = {}
  covered.forEach((marks, file) => {
    const inside = marks.reduce((sum, mark) => sum + mark, 0)
    if (inside === 0) return
    const pkg = packageOf(files[file]?.path ?? "")
    counts[pkg] = (counts[pkg] ?? 0) + inside
  })
  const order = (x: Clone, y: Clone): number =>
    y.tokens - x.tokens ||
    codeUnitOrder(x.a.path, y.a.path) ||
    x.a.firstLine - y.a.firstLine ||
    codeUnitOrder(x.b.path, y.b.path) ||
    x.b.firstLine - y.b.firstLine
  return {
    clones: clones.sort(order),
    counts: Object.fromEntries(Object.entries(counts).sort(([x], [y]) => codeUnitOrder(x, y))),
  }
}

export interface Change {
  readonly pkg: string
  readonly was: number
  readonly now: number
}

/** Every package whose count rose, and every one that fell. */
export function compareCounts(
  baseline: Counts,
  current: Counts,
): { readonly increased: Change[]; readonly decreased: Change[] } {
  const increased: Change[] = []
  const decreased: Change[] = []
  for (const pkg of new Set([...Object.keys(baseline), ...Object.keys(current)])) {
    const was = baseline[pkg] ?? 0
    const now = current[pkg] ?? 0
    if (now > was) increased.push({ pkg, was, now })
    else if (now < was) decreased.push({ pkg, was, now })
  }
  const order = (a: Change, b: Change): number => codeUnitOrder(a.pkg, b.pkg)
  return { increased: increased.sort(order), decreased: decreased.sort(order) }
}

/** Tracked package sources, generated copies left out: `gen:vendored` writes those on purpose. */
async function packageSources(cwd: string): Promise<SourceText[]> {
  const result = spawnSync("git", ["ls-files", "-z", "packages/*/src/**"], {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`git ls-files failed:\n${result.stderr}`)
  const paths = result.stdout
    .split("\0")
    .filter((path) => /\.tsx?$/.test(path) && !path.endsWith(".d.ts"))
    .filter((path) => !path.includes("/generated/"))
    .sort(codeUnitOrder)
  return Promise.all(
    paths.map(async (path) => ({ path, text: await readFile(join(cwd, path), "utf8") })),
  )
}

/** What a run decided: the process exit code, and the lines to print. */
export interface RatchetOutcome {
  /** 0 ok, 1 a package gained cloned tokens, 2 the gate could not run at all. */
  readonly code: 0 | 1 | 2
  readonly report: readonly string[]
}

export interface RatchetPaths {
  readonly cwd?: string
  readonly baseline?: string
}

export async function run(
  argv: readonly string[] = process.argv,
  paths: RatchetPaths = {},
): Promise<RatchetOutcome> {
  const update = argv.includes("--update")
  const acceptIncrease = argv.includes("--accept-increase")
  const baselinePath = paths.baseline ?? DEFAULT_BASELINE
  if (acceptIncrease && !update) {
    return {
      code: 2,
      report: ["[clones] --accept-increase does nothing without --update. Nothing was written."],
    }
  }

  let found: ReturnType<typeof findClones>
  try {
    found = findClones(await packageSources(paths.cwd ?? ROOT))
  } catch (error) {
    return {
      code: 2,
      report: [`[clones] could not run: ${error instanceof Error ? error.message : error}`],
    }
  }
  const current = found.counts
  const total = Object.values(current).reduce((sum, count) => sum + count, 0)
  const write = (counts: Counts): Promise<void> =>
    writeFile(baselinePath, `${JSON.stringify(counts, null, 2)}\n`)

  const baselineText = await readFile(baselinePath, "utf8").catch(() => undefined)
  if (baselineText === undefined) {
    if (!update) {
      return {
        code: 2,
        report: [`[clones] no ${baselinePath}. Create it once with: bun run check:clones --update`],
      }
    }
    await write(current)
    return { code: 0, report: [`[clones] baseline created: ${total} cloned tokens`] }
  }

  const baseline: Counts = JSON.parse(baselineText)
  const { increased, decreased } = compareCounts(baseline, current)
  if (increased.length > 0 && !acceptIncrease) {
    const report = [`[clones] cloned tokens increased in ${increased.length} package(s):`, ""]
    for (const change of increased) {
      report.push(`  ${change.pkg}: ${change.was} -> ${change.now}`)
      const own = found.clones.filter((clone) => clone.pkg === change.pkg)
      for (const { tokens, a, b } of own.slice(0, REPORTED)) {
        report.push(
          `    ${tokens} tokens: ${a.path}:${a.firstLine}-${a.lastLine} = ${b.path}:${b.firstLine}-${b.lastLine}`,
        )
      }
      if (own.length > REPORTED) report.push(`    ...and ${own.length - REPORTED} more`)
    }
    report.push(
      "",
      "Reuse the existing code instead of copying it. If the copy only moved, say so explicitly:",
      "  bun run check:clones --update --accept-increase",
    )
    return { code: 1, report }
  }
  if (update) {
    const next: Counts = { ...baseline }
    for (const change of decreased) next[change.pkg] = change.now
    for (const change of acceptIncrease ? increased : []) next[change.pkg] = change.now
    for (const [pkg, count] of Object.entries(next)) if (count === 0) delete next[pkg]
    await write(Object.fromEntries(Object.entries(next).sort(([a], [b]) => codeUnitOrder(a, b))))
    const raised = acceptIncrease
      ? increased.map((c) => `  raised ${c.pkg}: ${c.was} -> ${c.now}`)
      : []
    return { code: 0, report: [`[clones] baseline updated: ${total} cloned tokens`, ...raised] }
  }
  const below =
    decreased.length > 0
      ? ` (${decreased.length} package(s) below it - lock them in with --update)`
      : ""
  return {
    code: 0,
    report: [`[clones] ok - ${total} cloned tokens, no package above baseline${below}`],
  }
}

if (import.meta.main) {
  const outcome = await run()
  for (const line of outcome.report) console.log(line)
  process.exit(outcome.code)
}
