import { server } from "@nifrajs/core"
import {
  STATIC_MOUNT_CASES,
  STATIC_MOUNTS_APP,
  staticMountAnswer,
  staticMounts,
} from "../../core/test/static-mounts.ts"
import { serve, serveStatic } from "../src/index.ts"

function assertEquals(actual: unknown, expected: unknown, name: string): void {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) throw new Error(`${name}: expected ${e}, got ${a}`)
}

Deno.test("serveStatic answers the shared mount matrix as every runtime does", async () => {
  const app = server()
    .get("/*", (c) => c.text(STATIC_MOUNTS_APP))
    .post("/*", (c) => c.text(STATIC_MOUNTS_APP))
  const running = await serve(app, {
    hostname: "127.0.0.1",
    port: 0,
    static: serveStatic(staticMounts()),
  })
  try {
    const base = `http://127.0.0.1:${running.port}`
    for (const [name, path, method, expected] of STATIC_MOUNT_CASES) {
      assertEquals(await staticMountAnswer(base, path, method, expected), expected, name)
    }
  } finally {
    await running.stop({ drainMs: 0 })
  }
})

Deno.test("serveStatic passes a request no mount takes on synchronously", () => {
  const handler = serveStatic(staticMounts())
  assertEquals(handler(new Request("http://x/elsewhere")), undefined, "no prefix")
  assertEquals(handler(new Request("http://x/x/shared.txt", { method: "POST" })), undefined, "POST")
})
