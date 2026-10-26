/**
 * `@nifrajs/deno`'s `serveStatic` against a race only a shim can time: `Deno.open` follows links, so
 * a directory swapped for a link to somewhere outside the root, after the containment check and
 * before the open, would redirect the read. The reader must notice that the opened file is not the
 * one its real path names. Run on Bun over a `node:fs` shim of the `Deno` calls the reader makes,
 * which is what lets the swap land between them.
 */
import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { open, realpath, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Readable } from "node:stream"
import { fileURLToPath } from "node:url"

// Loaded by URL: the reader calls the Deno namespace, which the root program has no types for.
const READER = new URL("../../../packages/deno/src/serve-static.ts", import.meta.url).href
type Handler = (request: Request) => Promise<Response | undefined> | undefined
const { serveStatic }: { serveStatic: (mounts: { dir: string }) => Handler } = await import(READER)

/** The slice of Deno's file API the reader uses, over `node:fs`. */
const denoFiles = {
  SeekMode: { Start: 0 },
  realPath: (path: URL | string) => realpath(path instanceof URL ? fileURLToPath(path) : path),
  stat: async (path: string) => {
    const named = await stat(path)
    return { dev: named.dev, ino: named.ino }
  },
  async open(path: string) {
    const handle = await open(path, "r")
    let position = 0
    return {
      stat: async () => {
        const opened = await handle.stat()
        return {
          isFile: opened.isFile(),
          size: opened.size,
          mtime: opened.mtime,
          ctime: opened.ctime,
          dev: opened.dev,
          ino: opened.ino,
        }
      },
      seek: async (offset: number) => {
        position = offset
      },
      read: async (into: Uint8Array) => {
        const { bytesRead } = await handle.read(into, 0, into.length, position)
        position += bytesRead
        return bytesRead === 0 ? null : bytesRead
      },
      get readable() {
        return Readable.toWeb(handle.createReadStream({ start: position }))
      },
      close: () => {
        handle.close().catch(() => {})
      },
    }
  },
}

const DENO = Object.getOwnPropertyDescriptor(globalThis, "Deno")

afterEach(() => {
  if (DENO === undefined) Reflect.deleteProperty(globalThis, "Deno")
  else Object.defineProperty(globalThis, "Deno", DENO)
})

test("a file reached through a directory swapped for a link after its check is refused", async () => {
  const root = mkdtempSync(join(tmpdir(), "nifra-static-swap-"))
  const dir = join(root, "static")
  mkdirSync(join(dir, "assets/chunks"), { recursive: true })
  writeFileSync(join(dir, "assets/chunks/app.js"), "app")
  mkdirSync(join(root, "outside"))
  writeFileSync(join(root, "outside/app.js"), "secret")
  let swap = false
  // `chunks` becomes a link to a directory outside the root after the containment check passed and
  // before the file is opened.
  const racing = {
    ...denoFiles,
    open(path: string) {
      if (swap) {
        swap = false
        renameSync(join(dir, "assets/chunks"), join(dir, "assets/chunks-old"))
        symlinkSync(join(root, "outside"), join(dir, "assets/chunks"))
      }
      return denoFiles.open(path)
    },
  }
  Object.defineProperty(globalThis, "Deno", { value: racing, configurable: true, writable: true })
  try {
    const files = serveStatic({ dir: join(dir, "assets") })
    const get = () => files(new Request("http://app.test/assets/chunks/app.js"))
    expect(await (await get())?.text()).toBe("app")
    swap = true
    const swapped = await get()
    expect(swapped?.status).toBe(404)
    expect(await swapped?.text()).toBe("Not Found")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
