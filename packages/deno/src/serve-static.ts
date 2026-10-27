/**
 * `serveStatic()` on Deno's own file API: the same mounts Bun's `@nifrajs/core/serve-static` and
 * `@nifrajs/node` take, answered the same way. Deno's `node:fs` took 1.2-2.1x the instructions per
 * file request, so this reader opens, stats, seeks and streams with `Deno.*`.
 */
// @ts-types="./node-crypto.d.ts"
import { createHash } from "node:crypto"
import { parseByteRange } from "./generated/range.ts"
import {
  CONTENT_SNAPSHOT_MAX,
  contentTags,
  type FileVersion,
  isHiddenPath,
  matchStatic,
  planStatic,
  type ServeStaticOptions,
  type StaticMount,
  staticMountOf,
} from "./generated/static-file.ts"

// One per process: the tag of a file served from any mount is remembered by its real path. A stat
// costs Deno more than hashing a snapshot of up to 24 KiB, so only a larger one is restatted.
const TAGS = contentTags(createHash, { rehashMax: 24 * 1024 })

const READ_CHUNK = 64 * 1024

// Only a label for a URL: Deno resolves the mount's `dir` itself, and files are read under its real path.
function rootOf(dir: string | URL): string {
  return typeof dir === "string" ? dir : dir.href
}

/** The path of an absolute URL, as sent, without its query or fragment. */
function pathOf(url: string): string {
  const start = url.indexOf("/", url.indexOf("//") + 2)
  if (start === -1) return "/"
  let end = start
  while (end < url.length) {
    const code = url.charCodeAt(end)
    if (code === 63 /* '?' */ || code === 35 /* '#' */) break
    end++
  }
  return url.slice(start, end)
}

/** The host of an absolute URL, as `new URL(url).host` would give it. */
function hostOf(url: string): string {
  const start = url.indexOf("//") + 2
  let end = start
  while (end < url.length) {
    const code = url.charCodeAt(end)
    if (code === 47 /* '/' */ || code === 63 /* '?' */ || code === 35 /* '#' */) break
    end++
  }
  return url.slice(start, end)
}

function refusalOf(status: 400 | 403 | 404): Response {
  return new Response(status === 400 ? "Bad Request" : status === 403 ? "Forbidden" : "Not Found", {
    status,
  })
}

// Deno reports a field the platform does not keep as null; NaN never matches a remembered version.
function versionOf(info: Deno.FileInfo): FileVersion {
  return {
    dev: info.dev,
    ino: info.ino ?? Number.NaN,
    size: info.size,
    mtimeMs: info.mtime?.getTime() ?? Number.NaN,
    ctimeMs: info.ctime?.getTime() ?? Number.NaN,
  }
}

/** `length` bytes of `file` from its current position; fewer when it shrank since its stat. */
async function readFrom(file: Deno.FsFile, length: number): Promise<Uint8Array<ArrayBuffer>> {
  const bytes = new Uint8Array(length)
  let filled = 0
  while (filled < length) {
    const read = await file.read(bytes.subarray(filled))
    if (read === null || read === 0) break
    filled += read
  }
  return filled === length ? bytes : bytes.subarray(0, filled)
}

/** `length` bytes of `file` from its current position as a stream that closes it once done. */
function streamFrom(file: Deno.FsFile, length: number): ReadableStream<Uint8Array> {
  let left = length
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const chunk = new Uint8Array(Math.min(left, READ_CHUNK))
      const read = await file.read(chunk)
      if (read === null || read === 0) {
        file.close()
        controller.close()
        return
      }
      controller.enqueue(chunk.subarray(0, read))
      left -= read
      if (left <= 0) {
        file.close()
        controller.close()
      }
    },
    cancel: () => file.close(),
  })
}

interface DenoMount extends StaticMount {
  readonly dir: string | URL
  /** The directory's real path, resolved on first use and again after a miss, so one made later serves. */
  realRoot: Promise<string | undefined> | undefined
}

/**
 * The answer for `rel` under `mount`, or `undefined` when the mount falls through on a file it cannot
 * serve.
 */
async function readStatic(
  mount: DenoMount,
  rel: string,
  immutable: boolean,
  request: Request,
): Promise<Response | undefined> {
  const missing = (): Response | undefined => (mount.fallthrough ? undefined : refusalOf(404))
  mount.realRoot ??= Deno.realPath(mount.dir).catch(() => undefined)
  const realRoot = await mount.realRoot
  if (realRoot === undefined) {
    mount.realRoot = undefined
    return missing()
  }
  const separator = realRoot.includes("\\") ? "\\" : "/"
  let file: Deno.FsFile | undefined
  try {
    const real = await Deno.realPath(`${realRoot}${separator}${rel}`)
    // A link out of the directory, or a visible name linking to a dotfile inside it, answers as a
    // missing file does: unlike a `..` in the request, the name exists, and a distinct status would
    // say so.
    if (!real.startsWith(realRoot + separator)) return missing()
    if (mount.denyDotfiles && isHiddenPath(real.slice(realRoot.length + 1))) return missing()
    file = await Deno.open(real)
    // Deno.open follows links, so a directory swapped for one after the check above redirects it.
    // The opened file must be the one at `real`, which must still resolve to itself.
    const [info, named, again] = await Promise.all([
      file.stat(),
      Deno.stat(real),
      Deno.realPath(real),
    ])
    if (info.dev !== named.dev || info.ino !== named.ino || again !== real || !info.isFile) {
      file.close()
      return missing()
    }
    const opened = file
    let whole: Uint8Array<ArrayBuffer> | undefined
    const plan = await planStatic(
      mount,
      immutable,
      {
        method: request.method === "HEAD" ? "HEAD" : "GET",
        header: (name) => request.headers.get(name),
      },
      {
        path: real,
        version: versionOf(info),
        readWhole: async () => {
          whole = await readFrom(opened, info.size)
          return whole
        },
        restat: async () => versionOf(await opened.stat()),
        tags: TAGS,
        parseRange: parseByteRange,
      },
    )
    if (!plan.body) {
      opened.close()
      return new Response(null, { status: plan.status, headers: plan.headers })
    }
    const { start, length, headers } = plan
    if (whole !== undefined) {
      opened.close()
      const body = whole.subarray(start, start + length)
      headers["content-length"] = String(body.byteLength)
      return new Response(body, { status: plan.status, headers })
    }
    // Untagged by this read: a file past the snapshot size, or one a mount's own `etag` names.
    // Unbounded, yet a file that grew since its stat sends no more: Deno.serve stops at the
    // content-length. Any JS between this stream and the socket costs 1.4x the instructions.
    if (plan.status === 200) return new Response(opened.readable, { status: 200, headers })
    if (length <= CONTENT_SNAPSHOT_MAX) {
      await opened.seek(start, Deno.SeekMode.Start)
      const body = await readFrom(opened, length)
      opened.close()
      headers["content-length"] = String(body.byteLength)
      return new Response(body, { status: 206, headers })
    }
    await opened.seek(start, Deno.SeekMode.Start)
    return new Response(streamFrom(opened, length), { status: 206, headers })
  } catch {
    try {
      file?.close()
    } catch {
      // Already closed by the stream that failed.
    }
    // Missing or unreadable under the prefix: a 404 (not an SSR 404 page), unless the mount falls through.
    return missing()
  }
}

function serveFrom(
  mounts: readonly DenoMount[],
  from: number,
  request: Request,
  path: string,
  host: () => string,
): Promise<Response | undefined> | undefined {
  for (let i = from; i < mounts.length; i++) {
    const mount = mounts[i]
    if (mount === undefined) break
    const matched = matchStatic(mount, path, host)
    if (matched === "pass") continue
    // matchStatic passes what a falling-through mount refuses, so a status here is always answered.
    if ("status" in matched) return Promise.resolve(refusalOf(matched.status))
    return readStatic(mount, matched.rel, matched.immutable, request).then(
      (response) => response ?? serveFrom(mounts, i + 1, request, path, host),
    )
  }
  return undefined
}

/**
 * The `static` handler for files on disk: each mount serves a directory under a URL prefix, and the
 * first mount whose prefix (and `files`, when set) takes a GET or HEAD path answers it. A request no
 * mount takes returns `undefined` synchronously and reaches the app. The same mounts work with Bun's
 * `@nifrajs/core/serve-static` and `@nifrajs/node`.
 *
 * Files up to 256 KiB carry a strong `ETag` from the exact bytes served. Larger files stream with no
 * tag and a weak date, so an `If-Range` gets the whole file rather than a range spliced from two
 * versions.
 *
 * @example
 * ```ts
 * await serve(app, { port: 3000, static: serveStatic({ dir: new URL("./assets/", import.meta.url) }) })
 * ```
 */
export function serveStatic(
  mounts: ServeStaticOptions | readonly ServeStaticOptions[],
): (request: Request) => Promise<Response | undefined> | undefined {
  const list: readonly ServeStaticOptions[] = "dir" in mounts ? [mounts] : mounts
  const states: readonly DenoMount[] = list.map((options) => ({
    ...staticMountOf(options, rootOf(options.dir)),
    dir: options.dir,
    realRoot: undefined,
  }))
  return (request) => {
    const method = request.method
    if (method !== "GET" && method !== "HEAD") return undefined
    const url = request.url
    return serveFrom(states, 0, request, pathOf(url), () => hostOf(url))
  }
}
