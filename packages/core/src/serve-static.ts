/**
 * `serveStatic()` for Bun's `listen({ static })`: files on disk under URL prefixes, with the same
 * mounts `@nifrajs/node` and `@nifrajs/deno` take. Which request a mount takes and how it answers is
 * `./static-file.ts`; this module only reads the file, through node:fs, which Bun runs natively.
 *
 * A subpath rather than part of `listen()`, so an app that serves no files bundles no file reader.
 */
import { createHash } from "node:crypto"
import { type FileHandle, realpath } from "node:fs/promises"
import { isAbsolute, relative, resolve, sep } from "node:path"
import { Readable } from "node:stream"
import { fileURLToPath } from "node:url"
import { openResolved } from "./open-resolved.ts"
import { parseByteRange } from "./range.ts"
import { pathnameOf } from "./server/http.ts"
import {
  CONTENT_SNAPSHOT_MAX,
  contentTags,
  isHiddenPath,
  matchStatic,
  planStatic,
  type ServeStaticOptions,
  type StaticMount,
  staticMountsOf,
} from "./static-file.ts"

export type { HashedFiles, ServeStaticOptions } from "./static-file.ts"
export { IMMUTABLE, ONE_DAY } from "./static-file.ts"

// Bun.serve drops the declared length of any stream body and sends it chunked, and a Bun.file body
// would need this descriptor open for a send nothing reports the end of. So on Bun a body up to 1 MiB
// is read whole: a slow client then holds ~1 MB, against ~0.6 MB through Bun's stream sink.
const BUFFERED_BODY_MAX = typeof Bun === "undefined" ? CONTENT_SNAPSHOT_MAX : 1024 * 1024

// One per process: the tag of a file served from any mount is remembered by its real path.
const TAGS = contentTags(createHash)

function rootOf(dir: string | URL): string {
  return resolve(typeof dir === "string" ? dir : fileURLToPath(dir))
}

/** The host of an absolute URL, as `new URL(url).host` would give it, without parsing the rest. */
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

/** `length` bytes of `handle` from `start`; fewer when the file shrank since its stat. */
async function readPinned(
  handle: FileHandle,
  start: number,
  length: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const bytes = new Uint8Array(length)
  let offset = 0
  while (offset < length) {
    const { bytesRead } = await handle.read(bytes, offset, length - offset, start + offset)
    if (bytesRead === 0) break
    offset += bytesRead
  }
  return offset === length ? bytes : bytes.subarray(0, offset)
}

interface BunMount extends StaticMount {
  /** The directory's real path, resolved on first use and again after a miss, so one made later serves. */
  realRoot: Promise<string | undefined> | undefined
}

/**
 * The answer for `rel` under `mount`, or `undefined` when the mount falls through on a file it cannot
 * serve.
 */
async function readStatic(
  mount: BunMount,
  rel: string,
  immutable: boolean,
  request: Request,
): Promise<Response | undefined> {
  const missing = (status: 403 | 404 = 404): Response | undefined =>
    mount.fallthrough ? undefined : refusalOf(status)
  const file = resolve(mount.root, rel)
  // A drive or root in the decoded name (`C:/x` on Windows) leaves the directory without a `..`.
  const contained = relative(mount.root, file)
  if (contained.startsWith("..") || isAbsolute(contained)) return missing(403)
  // Containment is checked on the RESOLVED name and that name is what opens, so a link swapped inside
  // the tree after the check cannot redirect the read; openResolved refuses a name that gained a link.
  mount.realRoot ??= realpath(mount.root).catch(() => undefined)
  const [realRoot, realFile] = await Promise.all([
    mount.realRoot,
    realpath(file).catch(() => undefined),
  ])
  if (realRoot === undefined) mount.realRoot = undefined
  if (
    realRoot === undefined ||
    realFile === undefined ||
    (realFile !== realRoot && !realFile.startsWith(realRoot + sep))
  ) {
    return missing()
  }
  // A visible name linking to a dotfile inside the directory answers as a missing file does.
  if (
    mount.denyDotfiles &&
    realFile !== realRoot &&
    isHiddenPath(realFile.slice(realRoot.length + 1))
  ) {
    return missing()
  }
  let handle: FileHandle | undefined
  try {
    try {
      handle = await openResolved(realFile)
    } catch {
      return missing()
    }
    const opened = handle
    const stat = await opened.stat()
    if (!stat.isFile()) return missing()
    const method = request.method === "HEAD" ? "HEAD" : "GET"
    let whole: Uint8Array<ArrayBuffer> | undefined
    const plan = await planStatic(
      mount,
      immutable,
      { method, header: (name) => request.headers.get(name) },
      {
        path: realFile,
        version: stat,
        readWhole: async () => {
          whole = await readPinned(opened, 0, stat.size)
          return whole
        },
        restat: () => opened.stat(),
        tags: TAGS,
        parseRange: parseByteRange,
      },
    )
    if (!plan.body) return new Response(null, { status: plan.status, headers: plan.headers })
    const { start, length, headers } = plan
    if (length <= BUFFERED_BODY_MAX) {
      const body =
        whole === undefined
          ? await readPinned(opened, start, length)
          : whole.subarray(start, start + length)
      headers["content-length"] = String(body.byteLength)
      return new Response(body, { status: plan.status, headers })
    }
    const stream = opened.createReadStream({ start, end: start + length - 1 })
    // createReadStream owns closing the descriptor after EOF or abort.
    handle = undefined
    // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: node:stream/web's ReadableStream is the global one on Bun; only the declarations differ.
    const body = Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>
    return new Response(body, { status: plan.status, headers })
  } catch {
    // Unreadable under the prefix: a 404 (not an SSR 404 page), unless the mount falls through.
    return missing()
  } finally {
    await handle?.close().catch(() => {})
  }
}

function serveFrom(
  mounts: readonly BunMount[],
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
 * The `static` handler for files on disk, for Bun's `listen()`: each mount serves a directory under a
 * URL prefix, and the first mount whose prefix (and `files`, when set) takes a GET or HEAD path
 * answers it. A request no mount takes returns `undefined` synchronously and reaches the app. The
 * same mounts work with `@nifrajs/node`'s and `@nifrajs/deno`'s `serveStatic`.
 *
 * Files up to 256 KiB carry a strong `ETag` from the exact bytes served. Larger files stream with no
 * tag and a weak date, so an `If-Range` gets the whole file rather than a range spliced from two
 * versions.
 *
 * @example
 * ```ts
 * import { serveStatic } from "@nifrajs/core/serve-static"
 *
 * app.listen(3000, { static: serveStatic({ dir: new URL("./assets/", import.meta.url) }) })
 * ```
 */
export function serveStatic(
  mounts: ServeStaticOptions | readonly ServeStaticOptions[],
): (request: Request) => Promise<Response | undefined> | undefined {
  const states: readonly BunMount[] = staticMountsOf(mounts, rootOf).map((mount) => ({
    ...mount,
    realRoot: undefined,
  }))
  return (request) => {
    const method = request.method
    if (method !== "GET" && method !== "HEAD") return undefined
    const url = request.url
    return serveFrom(states, 0, request, pathnameOf(url), () => hostOf(url))
  }
}
