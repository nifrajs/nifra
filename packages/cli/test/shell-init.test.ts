import { afterEach, expect, test } from "bun:test"
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseFlags } from "../src/cli.ts"
import { bindCommandArgv, findCommandSpec } from "../src/command-catalog.ts"
import {
  cargoToml,
  crateName,
  LIB_RS,
  originOf,
  tauriConf,
  transportSource,
} from "../src/shell-files.ts"
import { initMobile, runShellInit } from "../src/shell-init.ts"

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
    "nifra build --target static --out dist-shell --transport ./frontend/shell-transport.ts --prerender /",
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

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined
const actions = (out: unknown): unknown[] => {
  const files = field(out, "files")
  return Array.isArray(files) ? files.map((f) => field(f, "action")) : []
}

const shell = (): NonNullable<ReturnType<typeof findCommandSpec>> => {
  const spec = findCommandSpec("shell")
  if (spec === undefined) throw new Error("shell is not in the command catalog")
  return spec
}

test("the shell command is a CLI catalog command that refuses an unknown kind, option or empty value", () => {
  expect(shell().transports).toEqual(["cli"])
  expect(() => bindCommandArgv(shell(), [])).toThrow("kind must be tauri")
  expect(() => bindCommandArgv(shell(), ["electron"])).toThrow("kind must be tauri")
  expect(() => bindCommandArgv(shell(), ["tauri", "--bogus"])).toThrow()
  expect(() => bindCommandArgv(shell(), ["tauri", "--origin"])).toThrow()
})

test("the shell command writes the files, reports them and what to do next", async () => {
  const dir = project({ name: "demo" })
  const input = bindCommandArgv(shell(), ["tauri", "--origin=https://api.example.com"])
  const out = await shell().run(input, { cwd: dir, cliVersion: "0" })
  expect(actions(out).every((action) => action === "wrote")).toBe(true)
  const text = shell().render(out, input).join("\n")
  expect(text).toContain("wrote    src-tauri/tauri.conf.json")
  expect(text).toContain("1. bun add -d @tauri-apps/cli")
  const again = await shell().run(input, { cwd: dir, cliVersion: "0" })
  expect(actions(again).every((action) => action === "skipped")).toBe(true)
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

/** A project whose `node_modules/.bin/tauri` is a script that logs its arguments and exits `code`. */
function withFakeTauri(code: number, say = ""): { dir: string; log: string } {
  const dir = project()
  const bin = join(dir, "node_modules", ".bin")
  mkdirSync(bin, { recursive: true })
  const log = join(dir, "calls.log")
  writeFileSync(
    join(bin, "tauri"),
    `#!/bin/sh\necho "$@" >> ${JSON.stringify(log)}\n${say === "" ? "" : `echo ${JSON.stringify(say)} >&2\n`}exit ${code}\n`,
  )
  chmodSync(join(bin, "tauri"), 0o755)
  return { dir, log }
}

test("mobile init runs the project's Tauri CLI once per platform, non-interactively", async () => {
  const { dir, log } = withFakeTauri(0)
  const results = await initMobile(dir, ["android", "ios"], "darwin")
  expect(results).toEqual([
    { platform: "android", ok: true, note: "" },
    { platform: "ios", ok: true, note: "" },
  ])
  expect(readFileSync(log, "utf8").trim().split("\n")).toEqual([
    "android init --ci",
    "ios init --ci",
  ])
})

test("a platform that fails is reported with what the CLI said, and the others still run", async () => {
  const { dir } = withFakeTauri(1, "no Android SDK found")
  const [android] = await initMobile(dir, ["android"], "linux")
  expect(android?.ok).toBe(false)
  expect(android?.note).toContain("no Android SDK found")
})

test("mobile init says what is missing instead of throwing", async () => {
  const noCli = await initMobile(project(), ["android"], "darwin")
  expect(noCli[0]).toMatchObject({ ok: false })
  expect(noCli[0]?.note).toContain("bun add -d @tauri-apps/cli")
  const { dir, log } = withFakeTauri(0)
  const ios = await initMobile(dir, ["ios"], "linux")
  expect(ios[0]).toMatchObject({
    platform: "ios",
    ok: false,
    note: "an iOS project needs macOS and Xcode",
  })
  expect(() => readFileSync(log, "utf8")).toThrow()
})

test("--mobile takes android, ios or all, and the command fails when a platform does", async () => {
  expect(() => bindCommandArgv(shell(), ["tauri", "--mobile", "windows"])).toThrow("mobile must be")
  const input = bindCommandArgv(shell(), ["tauri", "--mobile", "android"])
  const out = await shell().run(input, { cwd: project({ name: "m" }), cliVersion: "0" })
  expect(field(out, "ok")).toBe(false)
  expect(field(out, "mobile")).toHaveLength(1)
  expect(shell().success?.(out, input)).toBe(false)
  const none = await shell().run(bindCommandArgv(shell(), ["tauri"]), {
    cwd: project(),
    cliVersion: "0",
  })
  expect(none).toMatchObject({ ok: true, mobile: [] })
})
