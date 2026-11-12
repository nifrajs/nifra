import { afterEach, beforeEach } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import ts from "typescript"

export interface TypeApp {
  /** The temp app's directory: made before each test, removed after it. */
  readonly root: string
  write(path: string, text: string): void
  /** A file `nifra types` wrote under `.nifra/types`. */
  generated(path: string): string
  /** Type errors in `files`, as `file:line message`, with `.nifra/types` merged in through `rootDirs`. */
  typeErrors(files: readonly string[]): string[]
}

/**
 * A scratch app for type-level tests. It lives inside the workspace so `@nifrajs/*` resolves, and the
 * checks read workspace source through the `bun` export condition, so they never depend on a stale
 * `dist`. `prefix` must start with `.tmp-` so the directory is ignored.
 */
export function typeApp(prefix: string): TypeApp {
  let root = ""
  beforeEach(() => {
    root = mkdtempSync(prefix)
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })
  return {
    get root() {
      return root
    },
    write(path, text) {
      const file = join(root, path)
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, text)
    },
    generated: (path) => readFileSync(join(root, ".nifra/types", path), "utf8"),
    typeErrors(files) {
      const program = ts.createProgram(
        files.map((file) => join(root, file)),
        {
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          target: ts.ScriptTarget.ESNext,
          module: ts.ModuleKind.ESNext,
          moduleResolution: ts.ModuleResolutionKind.Bundler,
          customConditions: ["bun"],
          allowImportingTsExtensions: true,
          jsx: ts.JsxEmit.Preserve,
          types: ["bun"],
          lib: ["lib.esnext.d.ts", "lib.dom.d.ts"],
          rootDirs: [root, join(root, ".nifra/types")],
        },
      )
      // Only the app's own files: workspace source is checked by the repo's typecheck, not here.
      // TypeScript names files with `/` separators; on Windows `root` has `\` ones.
      const prefixPath = root.replaceAll("\\", "/")
      const own = (diagnostic: ts.Diagnostic): boolean =>
        diagnostic.file === undefined || diagnostic.file.fileName.startsWith(prefixPath)
      return ts
        .getPreEmitDiagnostics(program)
        .filter(own)
        .map((diagnostic) => {
          const where =
            diagnostic.file === undefined || diagnostic.start === undefined
              ? ""
              : `${diagnostic.file.fileName.slice(prefixPath.length + 1)}:${diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start).line + 1} `
          return where + ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")
        })
    },
  }
}
