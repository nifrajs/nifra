import type * as TSApi from "typescript"

/**
 * The parser mode for a source file, by its extension. A `.ts` file is not parsed as TSX: there
 * `<T>(x: T) => x` and `<Type>value` read as JSX, and parser recovery loses what follows them.
 */
export function scriptKindOf(ts: typeof TSApi, file: string): TSApi.ScriptKind {
  if (file.endsWith(".tsx")) return ts.ScriptKind.TSX
  if (/\.[cm]?ts$/.test(file)) return ts.ScriptKind.TS
  return file.endsWith(".jsx") ? ts.ScriptKind.JSX : ts.ScriptKind.JS
}
