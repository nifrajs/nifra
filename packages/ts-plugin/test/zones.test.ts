import { afterAll, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import ts from "typescript"
import plugin from "../src/index.ts"
import { ZONE_DIAGNOSTIC_CODE } from "../src/zones.ts"

// A real language service over a temp app, driven through the plugin's own proxy.
const root = mkdtempSync(join(tmpdir(), "nifra-ts-zones-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const FILES: Record<string, string> = {
  "routes/index.tsx": [
    'import type { Row } from "../backend/db"',
    'import { type Rows } from "../backend/db"',
    'import { query } from "../backend/db"',
    'import { format } from "../shared/format"',
    'import { Button } from "../frontend/button"',
    'import { readFileSync } from "node:fs"',
    'import { Pool } from "pg"',
    'import { loader } from "./index.backend"',
    'import { save } from "../backend/save.fn"',
    "export default function Home() {",
    "  return [query, format, Button, readFileSync, Pool, loader, save]",
    "}",
    "",
  ].join("\n"),
  "routes/index.backend.ts": [
    'import { query } from "../backend/db"',
    'import { Pool } from "pg"',
    "export async function loader() { return [query, Pool] }",
    "",
  ].join("\n"),
  "backend/db.ts": [
    "export type Row = { id: string }",
    "export type Rows = Row[]",
    "export const query = () => []",
    "",
  ].join("\n"),
  "backend/save.fn.ts": "export const save = () => null\n",
  "backend/mail.ts": 'import { Button } from "../frontend/button"\nexport const mail = Button\n',
  "shared/format.ts": [
    'import { query } from "../backend/db"',
    'export const format = () => import("../frontend/button").then(() => query)',
    "",
  ].join("\n"),
  "frontend/button.tsx": [
    'import { legacy } from "./old.server"',
    "export const Button = () => legacy",
    "",
  ].join("\n"),
  "frontend/old.server.ts": "export const legacy = 1\n",
  "scripts/seed.ts": 'import { query } from "../backend/db"\nquery()\n',
  "node_modules/pg/package.json": JSON.stringify({ name: "pg", types: "index.d.ts" }),
  "node_modules/pg/index.d.ts": "export declare class Pool {}\n",
}
for (const [path, text] of Object.entries(FILES)) {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), text)
}

const scripts = Object.keys(FILES)
  .filter((path) => /\.tsx?$/.test(path) && !path.startsWith("node_modules/"))
  .map((path) => join(root, path))
const host: ts.LanguageServiceHost = {
  getScriptFileNames: () => scripts,
  getScriptVersion: () => "1",
  getScriptSnapshot: (file) => {
    try {
      return ts.ScriptSnapshot.fromString(readFileSync(file, "utf8"))
    } catch {
      return undefined
    }
  },
  getCurrentDirectory: () => root,
  getCompilationSettings: () => ({
    jsx: ts.JsxEmit.ReactJSX,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    target: ts.ScriptTarget.ESNext,
    noEmit: true,
    types: [],
  }),
  getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
  fileExists: ts.sys.fileExists,
  readFile: ts.sys.readFile,
  readDirectory: ts.sys.readDirectory,
  directoryExists: ts.sys.directoryExists,
  getDirectories: ts.sys.getDirectories,
}
const proxy = plugin({ typescript: ts }).create({
  languageService: ts.createLanguageService(host, ts.createDocumentRegistry()),
  languageServiceHost: host,
} as unknown as ts.server.PluginCreateInfo)

/** The zone errors in one file, as `<the import as written>: <message>`. */
function zoneErrors(path: string): string[] {
  const text = FILES[path] ?? ""
  return proxy
    .getSemanticDiagnostics(join(root, path))
    .filter((diagnostic) => diagnostic.code === ZONE_DIAGNOSTIC_CODE)
    .map((diagnostic) => {
      const at = diagnostic.start ?? 0
      const written = text.slice(at, at + (diagnostic.length ?? 0))
      return `${written}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`
    })
}

test("a page's value imports of backend code, built-ins and server packages are errors", () => {
  const errors = zoneErrors("routes/index.tsx")
  expect(errors.map((error) => error.slice(0, error.indexOf(":")))).toEqual([
    '"../backend/db"',
    '"node',
    '"pg"',
    '"./index.backend"',
  ])
  expect(errors[0]).toContain(
    "routes/index.tsx (a route's frontend half) imports backend/db.ts (backend code)",
  )
  expect(errors[1]).toContain("Node and Bun built-ins run on the server only")
  expect(errors[2]).toContain('package "pg" is server code')
  expect(errors[3]).toContain("imports routes/index.backend.ts (a route's backend half)")
})

test("a backend half may import backend code and server packages", () => {
  expect(zoneErrors("routes/index.backend.ts")).toEqual([])
})

test("backend code importing frontend code is an error", () => {
  expect(zoneErrors("backend/mail.ts")).toEqual([
    expect.stringContaining("backend code may not import frontend code") as unknown as string,
  ])
})

test("shared code may import only shared code, dynamic imports included", () => {
  const errors = zoneErrors("shared/format.ts")
  expect(errors).toHaveLength(2)
  expect(errors[0]).toStartWith('"../backend/db": shared/format.ts (shared code) imports')
  expect(errors[1]).toStartWith('"../frontend/button": shared/format.ts (shared code) imports')
})

test("an import of a file in no valid zone carries the classifier's reason", () => {
  expect(zoneErrors("frontend/button.tsx")).toEqual([
    expect.stringContaining('uses the retired ".server" suffix') as unknown as string,
  ])
})

test("a file no build loads is not checked", () => {
  expect(zoneErrors("scripts/seed.ts")).toEqual([])
})

test("TypeScript's own diagnostics still come through", () => {
  const broken = join(root, "routes/broken.tsx")
  writeFileSync(broken, "export const n: number = 'x'\n")
  scripts.push(broken)
  expect(proxy.getSemanticDiagnostics(broken).map((diagnostic) => diagnostic.code)).toEqual([2322])
})
