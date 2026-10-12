import { afterEach, beforeEach, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { createFixtureRoot, removeFixtureRoot, writeAppFile } from "./fixture-root.ts"

const CLI = resolve(import.meta.dir, "../src/cli.ts")
let root: string

beforeEach(() => {
  root = createFixtureRoot("tmp-reflect-exit-")
  // An app that records what it was told and, like a Redis client retrying, can hold the process open.
  writeAppFile(
    root,
    "backend/app.ts",
    [
      'import { writeFileSync } from "node:fs"',
      'import { server } from "@nifrajs/core"',
      'writeFileSync(new URL("../reflect.txt", import.meta.url), process.env.NIFRA_REFLECT ?? "")',
      'if (process.env.HOLD_OPEN === "1") setInterval(() => {}, 60_000)',
      'export const backend = server().get("/x", () => "x")',
      "",
    ].join("\n"),
  )
})
afterEach(() => removeFixtureRoot(root))

async function cli(
  args: readonly string[],
  holdOpen: boolean,
): Promise<{ exit: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([process.execPath, CLI, ...args], {
    cwd: root,
    env: { ...process.env, HOLD_OPEN: holdOpen ? "1" : "0" },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exit] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { exit, stdout, stderr }
}

test("a reflecting command tells the app it is being read", async () => {
  const run = await cli(["routes"], false)
  expect(run.exit).toBe(0)
  expect(run.stdout).toContain("/x")
  expect(run.stderr).not.toContain("keeping the process alive")
  expect(readFileSync(join(root, "reflect.txt"), "utf8")).toBe("routes")
})

test("a reflecting command exits after answering when the app holds the process open", async () => {
  const run = await cli(["routes"], true)
  expect(run.exit).toBe(0)
  expect(run.stdout).toContain("/x")
  expect(run.stderr).toContain(
    "`nifra routes` has finished, but something the app started when it was imported",
  )
  expect(run.stderr).toContain("process.env.NIFRA_REFLECT")
}, 30_000)

test("`nifra sdk` exits after writing the SDK when the app holds the process open", async () => {
  const run = await cli(["sdk", "--lang", "python", "--out", "sdk.py"], true)
  expect(run.exit).toBe(0)
  expect(readFileSync(join(root, "sdk.py"), "utf8")).toContain("/x")
  expect(run.stderr).toContain("`nifra sdk` has finished")
}, 30_000)

test("`nifra upgrade --write` exits after its edits when the app holds the process open", async () => {
  const { version } = JSON.parse(readFileSync(resolve(import.meta.dir, "../package.json"), "utf8"))
  writeAppFile(
    root,
    "package.json",
    JSON.stringify({ name: "held", type: "module", dependencies: { "@nifrajs/core": "5.0.0" } }),
  )
  const run = await cli(["upgrade", version, "--write", "--no-verify"], true)
  expect(run.exit).toBe(0)
  expect(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).dependencies).toEqual({
    "@nifrajs/core": version,
  })
  expect(run.stderr).toContain("`nifra upgrade` has finished")
}, 30_000)

test("`nifra build` exits after building when the app holds the process open", async () => {
  writeAppFile(
    root,
    "nifra.config.ts",
    'export { adapter } from "./backend/framework.ts"\nexport const clientModule = "@nifrajs/web-react/client"\n',
  )
  writeAppFile(
    root,
    "backend/framework.ts",
    'import { reactAdapter } from "@nifrajs/web-react"\nexport const adapter = reactAdapter\n',
  )
  writeAppFile(
    root,
    "routes/index.tsx",
    "export default function Home() {\n  return <p>home</p>\n}\n",
  )
  const run = await cli(["build"], true)
  expect(run.exit).toBe(0)
  expect(existsSync(join(root, "dist", "server.js"))).toBe(true)
  expect(run.stderr).toContain("`nifra build` has finished")
}, 60_000)
