/**
 * `@nifrajs/ts-plugin` - a TypeScript language-service plugin. It adds ONE thing to the editor:
 * go-to-definition on a route-path string literal jumps to the `routes/` file that serves it, so
 * `navigate({ to: "/orders" })`, `<Link to="/orders">`, or `href="/orders"` are click-through.
 *
 * Wire it up in a project's tsconfig:
 * ```json
 * { "compilerOptions": { "plugins": [{ "name": "@nifrajs/ts-plugin" }] } }
 * ```
 *
 * The routing rules are nifra's own: it discovers routes with `@nifrajs/web`'s `discoverRoutes` and
 * matches with `@nifrajs/core`'s pattern matcher (see ./resolve.ts), so a path resolves to exactly the
 * file it would serve at runtime. The plugin only wires that into `getDefinitionAndBoundSpan`.
 */
import { existsSync, realpathSync, statSync } from "node:fs"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { discoverRoutes } from "@nifrajs/web/fs"
import type * as ts from "typescript"
import { resolveRouteFile } from "./resolve.ts"

/** Walk up from a source file to the nearest directory that has a `routes/` folder - the app root. */
export function findRoutesDir(
  fromFile: string,
  exists: (p: string) => boolean = existsSync,
): string | undefined {
  let dir = dirname(fromFile)
  for (let i = 0; i < 64; i++) {
    if (exists(join(dir, "routes"))) return join(dir, "routes")
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
  return undefined
}

/**
 * TypeScript can canonicalize a file through its host while the editor hands the plugin a different
 * spelling. Windows CI exposes this as the short `RUNNER~1` temp path versus the long path stored in
 * the Program. Match by filesystem identity before delegating to TypeScript; a failed realpath falls
 * back to the lexical absolute path so a missing or synthetic file is still handled normally.
 */
function normalizeProgramPath(fileName: string): string {
  const slashed = fileName.replaceAll("\\", "/")
  const withoutDevicePrefix = slashed.replace(/^\/\/\?\/UNC\//i, "//").replace(/^\/\/\?\//, "")
  return process.platform === "win32" ? withoutDevicePrefix.toLowerCase() : withoutDevicePrefix
}

/** Keep every spelling a filesystem resolver may return; native and portable realpath disagree on
 * some Windows short-name paths, so matching only one of them is still a false negative. */
function canonicalProgramPaths(fileName: string): readonly string[] {
  const absolute = resolve(fileName)
  const paths = new Set<string>([normalizeProgramPath(absolute)])
  for (const resolver of [realpathSync.native, realpathSync]) {
    try {
      paths.add(normalizeProgramPath(resolver(absolute)))
    } catch {
      // Synthetic editor files and a path removed during an edit have no realpath. The absolute
      // spelling remains a valid candidate for TypeScript's virtual source overlay.
    }
  }
  return [...paths]
}

/**
 * TypeScript keeps an internal, canonical `Path` for every source file. Prefer that lookup when it
 * is available: unlike a direct string comparison it applies the same case/normalization rules the
 * Program used while loading the file. This is important on Windows, where the language service can
 * receive an 8.3 spelling (`RUNNER~1`) while the Program was populated from the long spelling.
 */
function typeScriptProgramPath(
  tsm: typeof ts,
  program: ts.Program,
  fileName: string,
): ts.Path | undefined {
  const toPath = (
    tsm as unknown as {
      toPath?: (
        fileName: string,
        currentDirectory: string,
        getCanonicalFileName: (fileName: string) => string,
      ) => ts.Path
    }
  ).toPath
  if (typeof toPath !== "function") return undefined
  const getCanonicalFileName = tsm.sys.useCaseSensitiveFileNames
    ? (value: string): string => value
    : (value: string): string => value.toLowerCase()
  try {
    return toPath(resolve(fileName), program.getCurrentDirectory(), getCanonicalFileName)
  } catch {
    return undefined
  }
}

/** Match a real file even when Windows handed the editor an 8.3 alias for the same path. */
function filesystemIdentity(fileName: string): string | undefined {
  try {
    const info = statSync(resolve(fileName), { bigint: true })
    if (info.ino === 0n) return undefined
    return `bigint:${info.dev}:${info.ino}`
  } catch {
    try {
      const info = statSync(resolve(fileName))
      if (info.ino === 0) return undefined
      return `number:${info.dev}:${info.ino}`
    } catch {
      // TypeScript also exposes virtual/source-overlay files. They have no filesystem identity, so
      // the lexical/realpath checks remain the correct fallback for those inputs.
      return undefined
    }
  }
}

function programSourceFile(
  tsm: typeof ts,
  program: ts.Program | undefined,
  fileName: string,
): ts.SourceFile | undefined {
  if (program === undefined) return undefined
  const direct = program.getSourceFile(fileName)
  if (direct !== undefined) return direct

  // `getSourceFileByPath` is the Program's own canonical lookup. It is deliberately attempted before
  // the filesystem scans below because an editor may provide a virtual source overlay that has no
  // stat/realpath identity at all.
  const programPath = typeScriptProgramPath(tsm, program, fileName)
  if (programPath !== undefined) {
    const byTypeScriptPath = program.getSourceFileByPath(programPath)
    if (byTypeScriptPath !== undefined) return byTypeScriptPath
  }

  const wanted = new Set(canonicalProgramPaths(fileName))
  const byPath = program
    .getSourceFiles()
    .find((source) => canonicalProgramPaths(source.fileName).some((path) => wanted.has(path)))
  if (byPath !== undefined) return byPath

  const wantedIdentity = filesystemIdentity(fileName)
  if (wantedIdentity === undefined) return undefined
  return program
    .getSourceFiles()
    .find((source) => filesystemIdentity(source.fileName) === wantedIdentity)
}

/** The innermost AST node whose span contains `position`. */
function innermostNodeAt(
  tsm: typeof ts,
  source: ts.SourceFile,
  node: ts.Node,
  position: number,
): ts.Node | undefined {
  if (position < node.getStart(source) || position > node.getEnd()) return undefined
  let found: ts.Node = node
  node.forEachChild((child) => {
    const inChild = innermostNodeAt(tsm, source, child, position)
    if (inChild !== undefined) found = inChild
  })
  return found
}

/**
 * If `position` sits on a string-literal route path (`"/..."`), return its text and the span INSIDE the
 * quotes (so the editor highlights the path, not the quotes). Exported for unit testing against a
 * `SourceFile` built with `ts.createSourceFile`.
 */
export function findRoutePathLiteral(
  tsm: typeof ts,
  source: ts.SourceFile,
  position: number,
): { text: string; span: ts.TextSpan } | undefined {
  const node = innermostNodeAt(tsm, source, source, position)
  if (node === undefined || !tsm.isStringLiteralLike(node)) return undefined
  if (!node.text.startsWith("/")) return undefined
  const start = node.getStart(source) + 1 // step past the opening quote
  return { text: node.text, span: { start, length: Math.max(0, node.getWidth(source) - 2) } }
}

/** Build the route go-to-definition for the literal at `position`, or undefined to fall through. */
function routeDefinitionAt(
  tsm: typeof ts,
  ls: ts.LanguageService,
  fileName: string,
  position: number,
): ts.DefinitionInfoAndBoundSpan | undefined {
  const source = programSourceFile(tsm, ls.getProgram(), fileName)
  if (source === undefined) return undefined
  const literal = findRoutePathLiteral(tsm, source, position)
  if (literal === undefined) return undefined
  const routesDir = findRoutesDir(fileName)
  if (routesDir === undefined) return undefined
  let file: string | undefined
  try {
    file = resolveRouteFile(literal.text, discoverRoutes(routesDir).routes)
  } catch {
    return undefined // a routes/ dir that can't be scanned is not this plugin's error to raise
  }
  if (file === undefined) return undefined
  const target = isAbsolute(file) ? file : join(routesDir, file)
  if (!existsSync(target)) return undefined
  return {
    definitions: [
      {
        fileName: target,
        textSpan: { start: 0, length: 0 },
        kind: tsm.ScriptElementKind.moduleElement,
        name: literal.text,
        containerName: "",
        containerKind: tsm.ScriptElementKind.unknown,
      },
    ],
    textSpan: literal.span,
  }
}

function init(modules: { typescript: typeof ts }): ts.server.PluginModule {
  const tsm = modules.typescript
  return {
    create(info: ts.server.PluginCreateInfo): ts.LanguageService {
      const ls = info.languageService
      // Proxy the language service, delegating every method to the real one except the one we augment.
      // Plain ASSIGNMENT (not Object.defineProperty) so each property stays writable - the override
      // below reassigns one, which a non-writable property would reject at runtime.
      const proxy = Object.create(null) as ts.LanguageService
      const writable = proxy as unknown as Record<string, unknown>
      for (const key of Object.keys(ls) as Array<keyof ts.LanguageService>) {
        const member = ls[key]
        writable[key] =
          typeof member === "function"
            ? (member as (...args: unknown[]) => unknown).bind(ls)
            : member
      }
      proxy.getDefinitionAndBoundSpan = (fileName, position) =>
        routeDefinitionAt(tsm, ls, fileName, position) ??
        ls.getDefinitionAndBoundSpan(
          programSourceFile(tsm, ls.getProgram(), fileName)?.fileName ?? fileName,
          position,
        )
      return proxy
    },
  }
}

export default init
