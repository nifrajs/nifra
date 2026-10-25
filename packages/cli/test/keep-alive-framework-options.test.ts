import { afterAll, expect, test } from "bun:test"
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { createFixtureProject, createFixtureRoot, removeFixtureRoot } from "./fixture-root.ts"

/**
 * An app run by the CLI owns no `createWebApp` call, so `keepAlive` exported from
 * backend/framework.ts is the only way it names its session cookie. Both the dev server and the server
 * entry `nifra build` generates must take it: a sign-in through the named cookie rotates the epoch.
 */
const root = createFixtureRoot("tmp-keep-alive-framework-")
afterAll(() => removeFixtureRoot(root))

const cli = resolve(import.meta.dir, "../src/cli.ts")
// `c.set.cookie` marks `sid` Secure, so the epoch takes the `__Host-` name even over local http.
const EPOCH = /^__Host-nifra-epoch=[0-9a-f]{32}; Path=\/; SameSite=Lax; Secure; Max-Age=300$/

function app(): string {
  const dir = createFixtureProject(root, "app-")
  const nodeModules = join(dir, "node_modules", "@nifrajs")
  mkdirSync(nodeModules, { recursive: true })
  for (const pkg of ["web", "web-react"]) {
    symlinkSync(resolve(import.meta.dir, "..", "..", pkg), join(nodeModules, pkg), "dir")
  }
  mkdirSync(join(dir, "routes"), { recursive: true })
  mkdirSync(join(dir, "backend"), { recursive: true })
  writeFileSync(
    join(dir, "backend/framework.ts"),
    [
      'import { reactAdapter } from "@nifrajs/web-react"',
      "export const adapter = reactAdapter",
      'export const clientModule = "@nifrajs/web-react/client"',
      'export const keepAlive = { identityCookies: ["sid"] }',
      "export const use = (app: any) =>",
      '  app.get("/login", (c: any) => {',
      '    c.set.cookie("sid", "fresh", { maxAge: 300, httpOnly: true })',
      '    return "ok"',
      "  })",
    ].join("\n"),
  )
  writeFileSync(
    join(dir, "routes/index.tsx"),
    "export const keepAlive = true\nexport default function List() { return <p>list</p> }\n",
  )
  return dir
}

async function portFrom(
  proc: {
    readonly stdout: ReadableStream<Uint8Array>
    readonly stderr: ReadableStream<Uint8Array>
  },
  pattern: RegExp,
): Promise<number> {
  const reader = proc.stdout.getReader()
  const decoder = new TextDecoder()
  let seen = ""
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    const port = pattern.exec(seen)?.[1]
    if (port !== undefined) {
      reader.releaseLock()
      return Number(port)
    }
    const { value, done } = await reader.read()
    if (done) break
    seen += decoder.decode(value, { stream: true })
  }
  const stderr = await new Response(proc.stderr).text()
  throw new Error(`no listening line:\n${seen}\n--- stderr ---\n${stderr}`)
}

async function signInRotates(port: number): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${port}/login`)
  expect(response.status).toBe(200)
  const cookies = response.headers.getSetCookie()
  expect(cookies[0]).toStartWith("sid=fresh")
  expect(cookies.slice(1)).toEqual([expect.stringMatching(EPOCH)])
}

test("nifra dev takes keepAlive from backend/framework.ts", async () => {
  const dir = app()
  const proc = Bun.spawn([process.execPath, cli, "dev", "--port", "0"], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
  })
  try {
    await signInRotates(await portFrom(proc, /http:\/\/localhost:(\d+)/))
  } finally {
    proc.kill()
    await proc.exited
  }
}, 90_000)

test("the server entry nifra build generates takes keepAlive from backend/framework.ts", async () => {
  const dir = app()
  const build = Bun.spawn([process.execPath, cli, "build", "--target", "bun"], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [out, err, exit] = await Promise.all([
    new Response(build.stdout).text(),
    new Response(build.stderr).text(),
    build.exited,
  ])
  if (exit !== 0) throw new Error(`nifra build exited ${exit}:\n${out}\n${err}`)
  const entry = await Bun.file(join(dir, "dist/server.js")).text()
  expect(entry).toContain("keepAlive")
  const proc = Bun.spawn([process.execPath, join(dir, "dist/server.js")], {
    cwd: dir,
    env: { ...process.env, PORT: "0", NODE_ENV: "production" },
    stdout: "pipe",
    stderr: "pipe",
  })
  try {
    await signInRotates(await portFrom(proc, /localhost:(\d+)/))
  } finally {
    proc.kill()
    await proc.exited
  }
}, 120_000)
