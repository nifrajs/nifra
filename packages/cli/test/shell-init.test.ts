import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseFlags } from "../src/cli.ts"
import { runShellCommand } from "../src/shell-command.ts"
import {
  cargoToml,
  crateName,
  LIB_RS,
  originOf,
  runShellInit,
  tauriConf,
  transportSource,
} from "../src/shell-init.ts"

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const project = (pkg?: object): string => {
  const dir = mkdtempSync(join(tmpdir(), "nifra-shell-init-"))
  dirs.push(dir)
  if (pkg) writeFileSync(join(dir, "package.json"), JSON.stringify(pkg))
  return dir
}
const tree = (dir: string): string[] =>
  readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((p) => /\.[a-z]+$/.test(p) || p.endsWith(".gitignore"))
    .sort()

test("crateName is a valid crate for any package name", () => {
  expect(crateName("@scope/My Cool_App")).toBe("my-cool-app")
  expect(crateName("2fast")).toBe("app-2fast")
  expect(crateName("---")).toBe("app")
  expect(crateName("")).toBe("app")
  for (const raw of ["a", "Z9", "@x/y.z", "ünï", "1", "a--b"]) {
    expect(crateName(raw)).toMatch(/^[a-z][a-z0-9-]*[a-z0-9]$|^[a-z]$/)
  }
})

test("originOf keeps the origin and refuses anything but http(s)", () => {
  expect(originOf("https://api.example.com/v1/x?q=1")).toBe("https://api.example.com")
  expect(originOf("http://127.0.0.1:3111")).toBe("http://127.0.0.1:3111")
  expect(() => originOf("tauri://localhost")).toThrow("must be http or https")
  expect(() => originOf("api.example.com")).toThrow("must be a URL")
})

test("a scaffold writes the transport and the Tauri project, named after the package", async () => {
  const dir = project({ name: "@scope/todo-app" })
  const result = await runShellInit(dir, { origin: "https://api.example.com" })
  expect(result.files.every((f) => f.action === "wrote")).toBe(true)
  expect(tree(dir)).toEqual([
    "frontend/shell-transport.ts",
    "package.json",
    "src-tauri/.gitignore",
    "src-tauri/Cargo.toml",
    "src-tauri/build.rs",
    "src-tauri/capabilities/default.json",
    "src-tauri/src/lib.rs",
    "src-tauri/src/main.rs",
    "src-tauri/tauri.conf.json",
  ])
  expect(readFileSync(join(dir, "frontend/shell-transport.ts"), "utf8")).toContain(
    '"https://api.example.com"',
  )
  expect(readFileSync(join(dir, "src-tauri/Cargo.toml"), "utf8")).toContain('name = "todo-app"')
  expect(readFileSync(join(dir, "src-tauri/src/main.rs"), "utf8")).toContain("todo_app_lib::run()")
  expect(result.id).toBe("com.example.todoapp")
})

test("the generated config names the dist, both builds and the server in the CSP", () => {
  const conf = JSON.parse(tauriConf("Todo", "com.example.todo", "https://api.example.com"))
  expect(conf.build.frontendDist).toBe("../dist-shell")
  expect(conf.build.beforeBuildCommand).toBe(
    "nifra build --target static --out dist-shell --transport ./frontend/shell-transport.ts",
  )
  expect(conf.build.beforeDevCommand).toContain("--transport ./frontend/shell-transport.ts")
  expect(conf.build.devUrl).toBe("http://localhost:3112")
  expect(conf.identifier).toBe("com.example.todo")
  // The window is built in lib.rs, which hides it until the first paint.
  expect(conf.app.windows).toEqual([])
  expect(conf.app.security.csp).toContain(
    "connect-src 'self' https://api.example.com wss://api.example.com",
  )
  // The lib name main.rs calls is the one Cargo.toml declares.
  expect(cargoToml("todo-app")).toContain('name = "todo_app_lib"')
  expect(transportSource("http://localhost:1")).toContain('"http://localhost:1"')
})

test("a second run keeps what exists, and --force rewrites it", async () => {
  const dir = project()
  await runShellInit(dir)
  writeFileSync(join(dir, "src-tauri/src/lib.rs"), "// mine\n")
  const again = await runShellInit(dir)
  expect(again.files.every((f) => f.action === "skipped")).toBe(true)
  expect(readFileSync(join(dir, "src-tauri/src/lib.rs"), "utf8")).toBe("// mine\n")
  const forced = await runShellInit(dir, { force: true })
  expect(forced.files.every((f) => f.action === "wrote")).toBe(true)
  expect(readFileSync(join(dir, "src-tauri/src/lib.rs"), "utf8")).toContain("tauri::Builder")
})

test("a bad bundle id or origin writes nothing", async () => {
  const dir = project()
  await expect(runShellInit(dir, { id: "not an id" })).rejects.toThrow("--id must look like")
  await expect(runShellInit(dir, { origin: "ftp://x" })).rejects.toThrow("--origin")
  expect(tree(dir)).toEqual([])
})

test("the command refuses an unknown kind, option or empty value", async () => {
  const dir = project()
  const quiet = console.error
  console.error = () => {}
  try {
    expect(await runShellCommand(dir, [])).toBe(1)
    expect(await runShellCommand(dir, ["electron"])).toBe(1)
    expect(await runShellCommand(dir, ["tauri", "--bogus"])).toBe(1)
    expect(await runShellCommand(dir, ["tauri", "--origin"])).toBe(1)
    expect(await runShellCommand(dir, ["tauri", "--origin", "--force"])).toBe(1)
    expect(tree(dir)).toEqual([])
  } finally {
    console.error = quiet
  }
})

test("the command writes the files and reports them", async () => {
  const dir = project({ name: "demo" })
  const lines: string[] = []
  const log = console.log
  console.log = (...parts: unknown[]) => void lines.push(parts.join(" "))
  try {
    expect(await runShellCommand(dir, ["tauri", "--origin=https://api.example.com"])).toBe(0)
    expect(lines.join("\n")).toContain("wrote    src-tauri/tauri.conf.json")
    lines.length = 0
    expect(await runShellCommand(dir, ["tauri", "--json"])).toBe(0)
    expect(
      JSON.parse(lines.join("\n")).files.every((f: { action: string }) => f.action === "skipped"),
    ).toBe(true)
  } finally {
    console.log = log
  }
})

test("--transport is a build flag with a value", () => {
  expect(parseFlags([]).transport).toBeUndefined()
  expect(parseFlags(["--transport", "./t.ts"]).transport).toBe("./t.ts")
  expect(parseFlags(["--transport=./t.ts", "--target", "static"]).transport).toBe("./t.ts")
  expect(() => parseFlags(["--transport"])).toThrow("--transport needs a value")
})

test("the window opens hidden, shows on the first paint, and a timer shows it if none comes", () => {
  expect(LIB_RS).toContain(".visible(false)")
  expect(LIB_RS).toContain("first-contentful-paint")
  expect(LIB_RS).toContain("invoke('shell_painted')")
  expect(LIB_RS).toContain("generate_handler![shell_painted]")
  expect(LIB_RS).toContain("Duration::from_secs(3)")
  // The shown window is the one the capability names.
  expect(LIB_RS).toContain('WebviewWindowBuilder::new(app, "main"')
})
