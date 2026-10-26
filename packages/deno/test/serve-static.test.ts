import { server } from "@nifrajs/core"
import {
  HASHED_FILES_EXPECTED,
  HASHED_FILES_REFUSAL,
  hashedFilesAnswers,
  hashedFilesRefusals,
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

Deno.test("a file that grows after its stat is sent at the stat's length, and the connection stays usable", async () => {
  // The one directory `test:deno` grants writes to.
  const dir = new URL("./.tmp-static-grow/", import.meta.url)
  await Deno.mkdir(dir, { recursive: true })
  const size = 2 * 1024 * 1024
  const file = new URL("./growing.bin", dir)
  await Deno.writeFile(file, new Uint8Array(size))
  const running = await serve(
    server().get("/*", (c) => c.text("app")),
    {
      hostname: "127.0.0.1",
      port: 0,
      static: serveStatic({ dir, prefix: "/" }),
    },
  )
  try {
    const base = `http://127.0.0.1:${running.port}`
    const response = await fetch(`${base}/growing.bin`)
    await Deno.writeFile(file, new Uint8Array(1024), { append: true })
    assertEquals(response.headers.get("content-length"), String(size), "declared length")
    assertEquals((await response.arrayBuffer()).byteLength, size, "bytes sent")
    const next = await fetch(`${base}/growing.bin`)
    assertEquals(
      [next.status, (await next.arrayBuffer()).byteLength],
      [200, size + 1024],
      "next request",
    )
  } finally {
    await running.stop()
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test("hashedFiles marks the files it names immutable, in each form it takes", async () => {
  for (const [form, answers] of Object.entries(await hashedFilesAnswers(serveStatic))) {
    assertEquals(answers, HASHED_FILES_EXPECTED, form)
  }
  for (const message of hashedFilesRefusals((options) =>
    Reflect.apply(serveStatic, undefined, [options]),
  )) {
    assertEquals(message?.includes(HASHED_FILES_REFUSAL), true, `refused: ${message}`)
  }
})
