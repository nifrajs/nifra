import { createRequire } from "node:module"
import type * as TS from "typescript"

/** The code of the error a TypeScript without the in-process compiler API raises here. */
export const UNSUPPORTED_TYPESCRIPT = "NIFRA_TS_UNSUPPORTED"

function isCompiler(value: unknown): value is typeof TS {
  return (
    typeof value === "object" &&
    value !== null &&
    "createSourceFile" in value &&
    typeof value.createSourceFile === "function"
  )
}

/**
 * The TypeScript compiler API, resolved from `from` the way `import "typescript"` there would be.
 * TypeScript 7's package ships no in-process compiler API (its root export is only `version`), so
 * it raises an error that names the fix instead of a TypeError on first use.
 */
export function loadTypeScript(from: string = import.meta.url): typeof TS {
  const loaded: unknown = createRequire(from)("typescript")
  if (isCompiler(loaded)) return loaded
  const version =
    typeof loaded === "object" &&
    loaded !== null &&
    "version" in loaded &&
    typeof loaded.version === "string"
      ? loaded.version
      : "unknown"
  throw Object.assign(
    new Error(
      `${UNSUPPORTED_TYPESCRIPT}: server components read component modules with the TypeScript compiler API, which TypeScript ${version} does not ship. Pin the project to TypeScript 6 (for example, \`bun add -d typescript@^6\`).`,
    ),
    { code: UNSUPPORTED_TYPESCRIPT, version },
  )
}

export const ts: typeof TS = loadTypeScript()
