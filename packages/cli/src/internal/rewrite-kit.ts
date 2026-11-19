import type * as TS from "typescript"
import { scriptKindOf } from "./script-kind.ts"

/** A site a rewrite found and left alone, with what to write instead. */
export interface ManualSite {
  readonly line: number
  readonly reason: string
}

export interface RewriteResult {
  readonly text: string
  /** Sites rewritten. */
  readonly count: number
  readonly manual: readonly ManualSite[]
}

export interface SourceRewrite {
  readonly id: string
  /** What it rewrites, for the plan. */
  readonly description: string
  /** Whether `text` may hold a site: a file it refuses is never parsed. */
  readonly mentions: (text: string) => boolean
  /** Whether `.svelte` and `.vue` files are read too. Left out, they are skipped: a rewrite parses a TypeScript source. */
  readonly components?: boolean
  readonly rewrite: (ts: typeof TS, file: string, text: string) => RewriteResult
}

export interface Edit {
  readonly start: number
  readonly end: number
  readonly text: string
}

/** Apply `edits` (disjoint ranges) to `text`, from the end so earlier offsets stay valid. */
export function applyEdits(text: string, edits: readonly Edit[]): string {
  let out = text
  for (const edit of edits.toSorted((a, b) => b.start - a.start)) {
    out = `${out.slice(0, edit.start)}${edit.text}${out.slice(edit.end)}`
  }
  return out
}

/** Parse `text` as `file`, with the line lookup a rewrite lists its manual sites by. */
export function parseSource(ts: typeof TS, file: string, text: string) {
  const tree = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKindOf(ts, file))
  const lineOf = (node: TS.Node): number =>
    tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1
  return { tree, lineOf }
}
