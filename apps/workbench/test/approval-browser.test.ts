/**
 * The shipped browser bundle against a real host whose turn stops on an approval: the card must show
 * while the turn's stream is still open, since the turn cannot finish until someone decides it.
 * Skipped when no Chrome is installed.
 */

import { afterAll, beforeAll, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { CodingAgentRpcServer, NifraBackend } from "@nifrajs/coding-agent"
import {
  type ChromePage,
  findChrome,
  launchChrome,
} from "../../../packages/cli/test/headless-chrome.ts"

const chrome = findChrome()
const packageRoot = join(import.meta.dir, "..")
let page: ChromePage | undefined
let rpc: CodingAgentRpcServer | undefined
let ui: ReturnType<typeof Bun.serve> | undefined
let workbenchUrl = ""
let written = 0

beforeAll(async () => {
  if (chrome === undefined) return
  const build = Bun.spawn(["bun", "run", "build:browser"], {
    cwd: packageRoot,
    stdout: "pipe",
    stderr: "pipe",
  })
  if ((await build.exited) !== 0) throw new Error(await new Response(build.stderr).text())

  rpc = new CodingAgentRpcServer({
    backend: new NifraBackend({
      // One tool call that needs approval, then a reply once the tool's result is in.
      model: {
        complete: (request) =>
          request.messages.some((message) => message.role === "tool")
            ? { type: "text", text: "done" }
            : { type: "tool", name: "write_note", input: { text: "note" } },
      },
      tools: [
        {
          name: "write_note",
          description: "Write a note",
          capabilities: ["filesystem.write"],
          requiresApproval: true,
          execute: () => {
            written++
            return "written"
          },
        },
      ],
    }),
    cwd: process.cwd(),
    hostname: "127.0.0.1",
  })
  const handle = await rpc.start()
  const files: Record<string, readonly [string, string]> = {
    "/": ["index.html", "text/html; charset=utf-8"],
    "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  }
  ui = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const file = files[new URL(request.url).pathname]
      if (file === undefined) return new Response("Not found", { status: 404 })
      return new Response(await readFile(join(packageRoot, "dist/public", file[0])), {
        headers: { "content-type": file[1] },
      })
    },
  })
  workbenchUrl = `${ui.url.toString().replace(/\/$/, "")}/#rpc=${encodeURIComponent(handle.url)}&token=${encodeURIComponent(handle.token)}`
  page = await launchChrome(chrome)
}, 120_000)

afterAll(async () => {
  await page?.close()
  ui?.stop(true)
  await rpc?.stop()
})

test.skipIf(chrome === undefined)(
  "a pending approval shows while its turn waits, and approving it finishes the turn",
  async () => {
    if (page === undefined) throw new Error("expected a browser page")
    await page.goto(workbenchUrl)
    await page.waitFor(`document.getElementById("connection")?.textContent === "connected"`)
    await page.evaluate(`(() => {
      document.getElementById("prompt").value = "write a note"
      document.getElementById("composer").requestSubmit()
      return true
    })()`)
    await page.waitFor(`document.querySelector("#approvals .approval") !== null`)
    expect(
      await page.evaluate<string>(`document.querySelector("#approvals .approval")?.textContent`),
    ).toContain("filesystem.write")
    // The turn is still open: its tool has not run and the reply has not arrived.
    expect(written).toBe(0)
    expect(
      await page.evaluate<string>(`document.getElementById("timeline").textContent`),
    ).not.toContain("approval.resolved")

    await page.evaluate(`(() => {
      document.querySelector("#approvals .approval-actions button").click()
      return true
    })()`)
    await page.waitFor(
      `document.getElementById("timeline").textContent.includes("approval.resolved · approved")`,
    )
    await page.waitFor(`document.querySelector("#approvals .approval") === null`)
    expect(written).toBe(1)
    expect(page.errors).toEqual([])
  },
  60_000,
)
