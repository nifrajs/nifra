import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runCaptured } from "../src/mcp-run.ts"

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})
const tempDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "nifra-run-capture-"))
  dirs.push(dir)
  return dir
}

test("each result carries what its own request logged", async () => {
  const results = await runCaptured(
    await tempDir(),
    {
      fetch: async (request: Request) => {
        const path = new URL(request.url).pathname
        console.log(`handling ${path}`)
        setTimeout(() => console.warn(`late ${path}`), 0)
        return Response.json({ path })
      },
    },
    [{ path: "/one" }, { path: "/two" }],
  )
  expect(results.map((r) => r.status)).toEqual([200, 200])
  expect(results[0]?.logs).toEqual([
    { level: "log", message: "handling /one" },
    { level: "warn", message: "late /one" },
  ])
  expect(results[1]?.logs?.map((l) => l.message)).toEqual(["handling /two", "late /two"])
  expect(results[0]?.errors).toBeUndefined()
})

test("a bare 500 comes back with the error core logged, as a Diagnostic", async () => {
  const [result] = await runCaptured(
    await tempDir(),
    {
      fetch: () => {
        process.stderr.write(
          `${JSON.stringify({
            level: "error",
            message: "unhandled request error",
            method: "POST",
            path: "/api/orders",
            name: "TypeError",
            detail: "cannot read properties of undefined (reading 'id')",
            stack: "TypeError: cannot read\n    at create (/app/backend/orders.ts:12:5)",
            time: "now",
          })}\n`,
        )
        return new Response("internal_error", { status: 500 })
      },
    },
    [{ method: "POST", path: "/api/orders", body: {} }],
  )
  expect(result?.status).toBe(500)
  expect(result?.errors?.[0]?.name).toBe("TypeError")
  expect(result?.errors?.[0]?.frames[0]?.file).toBe("/app/backend/orders.ts")
  expect(result?.logs?.[0]?.level).toBe("error")
})

test("a thrown error keeps the runner's error and gains a Diagnostic", async () => {
  const [result] = await runCaptured(
    await tempDir(),
    {
      fetch: () => {
        throw new RangeError("out of range")
      },
    },
    [{ path: "/" }],
  )
  expect(result?.ok).toBe(false)
  expect(result?.error?.name).toBe("RangeError")
  expect(result?.errors?.[0]?.message).toContain("out of range")
})

test("logged secrets are redacted before they reach the agent", async () => {
  process.env.NIFRA_RUN_TEST_SECRET = "zyxwvutsrqponmlkjihgfedcba-98765"
  try {
    const [result] = await runCaptured(
      await tempDir(),
      {
        fetch: () => {
          console.log(`connecting with ${process.env.NIFRA_RUN_TEST_SECRET}`)
          return new Response("ok")
        },
      },
      [{ path: "/" }],
    )
    expect(result?.logs?.[0]?.message).toBe("connecting with [redacted:NIFRA_RUN_TEST_SECRET]")
  } finally {
    delete process.env.NIFRA_RUN_TEST_SECRET
  }
})

test("a malformed spec is that request's error, and the rest still run", async () => {
  const results = await runCaptured(await tempDir(), { fetch: () => new Response("ok") }, [
    { path: "http://[bad" },
    { path: "/fine" },
  ])
  expect(results).toHaveLength(2)
  expect(results[0]?.ok).toBe(false)
  expect(results[1]?.status).toBe(200)
})

test("the cold child keeps stdout for its JSON even when the app writes to it", async () => {
  const dir = await tempDir()
  await mkdir(join(dir, "backend"))
  await writeFile(
    join(dir, "backend", "app.ts"),
    [
      "export const backend = {",
      "  fetch() {",
      '    console.log("noisy handler")',
      '    process.stdout.write("raw stdout write\\n")',
      "    return Response.json({ ok: true })",
      "  },",
      "}",
      "",
    ].join("\n"),
  )
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/mcp-run.ts"), dir], {
    stdin: new TextEncoder().encode(JSON.stringify({ requests: [{ path: "/" }] })),
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited])
  expect(code).toBe(0)
  const output: { results: Array<{ body: unknown; logs: Array<{ message: string }> }> } =
    JSON.parse(stdout)
  expect(output.results[0]?.body).toEqual({ ok: true })
  expect(output.results[0]?.logs.map((l) => l.message)).toEqual([
    "noisy handler",
    "raw stdout write",
  ])
})
