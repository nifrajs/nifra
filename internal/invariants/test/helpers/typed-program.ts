import { join, resolve } from "node:path"
import ts from "typescript"

const REPO = resolve(import.meta.dir, "../../../..")

/** Every adapter the typing gates compile against. */
export const TYPED_ADAPTERS = ["react", "preact", "solid", "svelte", "vue"] as const

/** The workspace's packages from their sources, so a gate sees the code under test, not a stale build. */
function sourcePaths(): Record<string, string[]> {
  const root = ts.readConfigFile(join(REPO, "tsconfig.json"), ts.sys.readFile)
  const mapped: Record<string, string[]> = {}
  const rootPaths = ts.parseJsonConfigFileContent(root.config, ts.sys, REPO).options.paths ?? {}
  for (const [key, targets] of Object.entries(rootPaths)) {
    mapped[key] = targets.map((target) => resolve(REPO, target))
  }
  mapped["@nifrajs/web"] = [join(REPO, "packages/web/src/index.ts")]
  mapped["@nifrajs/web/client"] = [join(REPO, "packages/web/src/client.ts")]
  mapped["@nifrajs/web/forms"] = [join(REPO, "packages/web/src/forms.ts")]
  for (const adapter of TYPED_ADAPTERS) {
    for (const entry of ["query", "router"]) {
      mapped[`@nifrajs/web-${adapter}/${entry}`] = [
        join(REPO, `packages/web-${adapter}/src/${entry}.ts`),
      ]
    }
  }
  return mapped
}

export interface Reading {
  readonly code: number
  readonly where: string
  readonly line: number
  /** Path relative to the app root. */
  readonly file: string
}

/** The diagnostics of `adapter`'s program over `files`, kept to those inside `app`. */
export function programDiagnostics(
  app: string,
  adapter: string,
  files: readonly string[],
): Reading[] {
  const tsconfig = ts.readConfigFile(
    join(REPO, `packages/web-${adapter}/tsconfig.json`),
    ts.sys.readFile,
  )
  const parsed = ts.parseJsonConfigFileContent(
    tsconfig.config,
    ts.sys,
    join(REPO, `packages/web-${adapter}`),
  )
  const options: ts.CompilerOptions = {
    ...parsed.options,
    paths: sourcePaths(),
    pathsBasePath: REPO,
    rootDirs: [app, join(app, ".nifra/types")],
    noEmit: true,
    skipLibCheck: true,
    types: [],
  }
  const program = ts.createProgram([...files], options)
  return ts.getPreEmitDiagnostics(program).flatMap((item) => {
    if (item.file === undefined || !item.file.fileName.startsWith(app)) return []
    const at = item.file.getLineAndCharacterOfPosition(item.start ?? 0)
    return [
      {
        code: item.code,
        where: ts.flattenDiagnosticMessageText(item.messageText, " "),
        line: at.line + 1,
        file: item.file.fileName.slice(app.length + 1),
      },
    ]
  })
}
