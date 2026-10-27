/**
 * Clone ratchet: no package's own sources may gain duplicated code.
 *
 * Every tracked `packages/<name>/src` file is cut into tokens, and every run of at least
 * {@link WINDOW} identical tokens that appears twice inside one package joins a clone family. A
 * package's count is the duplicated tokens of its families: the shortest member's length times the
 * copies beyond the first. No count may rise above the committed baseline, so the duplication that
 * exists is frozen and new code reuses instead of copying.
 *
 * ## What it does NOT cover
 *
 * Copies across packages: a zero-dependency adapter keeps its own copy of a helper on purpose. The
 * generated copies are `check:vendored`'s, and the per-package helper owners `noHelperCopy`'s. Runs
 * shorter than the window, and copies with renamed identifiers, are not counted either.
 *
 * ## Usage
 *
 *   bun run check:clones                             # verify no package gained duplicated tokens
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

export interface CloneMember {
  readonly path: string
  readonly firstLine: number
  readonly lastLine: number
}

export interface CloneFamily {
  readonly pkg: string
  /** The shortest member's tokens times the copies beyond the first. */
  readonly weight: number
  readonly members: readonly CloneMember[]
}

const packageOf = (path: string): string => path.split("/")[1] ?? path

interface Diagonal {
  readonly fileA: number
  readonly fileB: number
  readonly offset: number
  readonly starts: number[]
}

interface Region {
  readonly file: number
  start: number
  end: number
}

/** The clone families inside each package: runs of at least WINDOW tokens repeated within it. */
export function findFamilies(files: readonly SourceText[]): CloneFamily[] {
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

  const regions: Region[] = []
  const parent: number[] = []
  const root = (index: number): number => {
    let at = index
    for (let up = parent[at]; up !== undefined && up !== at; up = parent[at]) at = up
    return at
  }
  const regionsOf = new Map<number, number[]>()
  const region = (file: number, start: number, end: number): number => {
    const known = regionsOf.get(file) ?? []
    for (const index of known) {
      const r = regions[index]
      if (r === undefined) continue
      const overlap = Math.min(r.end, end) - Math.max(r.start, start)
      if (overlap > 0.6 * Math.min(r.end - r.start, end - start)) {
        r.start = Math.min(r.start, start)
        r.end = Math.max(r.end, end)
        return index
      }
    }
    regions.push({ file, start, end })
    parent.push(regions.length - 1)
    known.push(regions.length - 1)
    regionsOf.set(file, known)
    return regions.length - 1
  }
  const ordered = [...diagonals.entries()].sort(([a], [b]) => codeUnitOrder(a, b))
  for (const [, { fileA, fileB, offset, starts }] of ordered) {
    starts.sort((a, b) => a - b)
    let first = starts[0] ?? 0
    let last = first
    const flush = (): void => {
      const a = region(fileA, first, last + WINDOW - 1)
      const b = region(fileB, first - offset, last - offset + WINDOW - 1)
      parent[root(a)] = root(b)
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

  const groups = new Map<number, number[]>()
  regions.forEach((_, index) => {
    const top = root(index)
    const group = groups.get(top)
    if (group === undefined) groups.set(top, [index])
    else group.push(index)
  })
  return [...groups.values()].map((group) => {
    const members = group.flatMap((index) => {
      const r = regions[index]
      if (r === undefined) return []
      const tokens = streams[r.file] ?? []
      return [
        {
          path: files[r.file]?.path ?? "",
          firstLine: tokens[r.start]?.line ?? 0,
          lastLine: tokens[Math.min(r.end, tokens.length - 1)]?.line ?? 0,
          length: r.end - r.start + 1,
        },
      ]
    })
    const shortest = Math.min(...members.map((member) => member.length))
    return {
      pkg: packageOf(members[0]?.path ?? ""),
      weight: shortest * (members.length - 1),
      members: members
        .map(({ path, firstLine, lastLine }) => ({ path, firstLine, lastLine }))
        .sort((a, b) => codeUnitOrder(a.path, b.path) || a.firstLine - b.firstLine),
    }
  })
}

/** Duplicated tokens per package. */
export type Counts = Record<string, number>

export function countFamilies(families: readonly CloneFamily[]): Counts {
  const counts: Counts = {}
  for (const family of families) counts[family.pkg] = (counts[family.pkg] ?? 0) + family.weight
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => codeUnitOrder(a, b)))
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
  /** 0 ok, 1 a package gained duplicated tokens, 2 the gate could not run at all. */
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

  let families: CloneFamily[]
  try {
    families = findFamilies(await packageSources(paths.cwd ?? ROOT))
  } catch (error) {
    return {
      code: 2,
      report: [`[clones] could not run: ${error instanceof Error ? error.message : error}`],
    }
  }
  const current = countFamilies(families)
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
    return { code: 0, report: [`[clones] baseline created: ${total} duplicated tokens`] }
  }

  const baseline: Counts = JSON.parse(baselineText)
  const { increased, decreased } = compareCounts(baseline, current)
  if (increased.length > 0 && !acceptIncrease) {
    const report = [`[clones] duplicated tokens increased in ${increased.length} package(s):`, ""]
    for (const change of increased) {
      report.push(`  ${change.pkg}: ${change.was} -> ${change.now}`)
      const own = families.filter((f) => f.pkg === change.pkg).sort((a, b) => b.weight - a.weight)
      for (const family of own) {
        const sites = family.members.map((m) => `${m.path}:${m.firstLine}-${m.lastLine}`)
        report.push(`    ${family.weight} tokens: ${sites.join("  ")}`)
      }
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
    return { code: 0, report: [`[clones] baseline updated: ${total} duplicated tokens`, ...raised] }
  }
  const below =
    decreased.length > 0
      ? ` (${decreased.length} package(s) below it - lock them in with --update)`
      : ""
  return {
    code: 0,
    report: [`[clones] ok - ${total} duplicated tokens, no package above baseline${below}`],
  }
}

if (import.meta.main) {
  const outcome = await run()
  for (const line of outcome.report) console.log(line)
  process.exit(outcome.code)
}
