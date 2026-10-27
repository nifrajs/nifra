/**
 * One mount list and one request matrix for every runtime's `serveStatic`: Bun's
 * `@nifrajs/core/serve-static`, `@nifrajs/node`'s (on its native lane and as a Web handler) and
 * `@nifrajs/deno`'s, run on Deno. Two mounts share a prefix, the first falling through, so a file it
 * cannot serve reaches the second and a path neither takes reaches the app. The tree is
 * `fixtures/static-mounts/`, checked in so Deno's suite reads it with a read grant for that folder
 * alone. The file imports only types: each suite passes its own `serveStatic` the same list.
 */
import type { HashedFiles, ServeStaticOptions } from "../src/static-file.ts"

/** What the app answers a request no mount takes. */
export const STATIC_MOUNTS_APP = "answered by the app"

export function staticMounts(): readonly ServeStaticOptions[] {
  const root = new URL("./fixtures/static-mounts/", import.meta.url)
  return [
    {
      dir: new URL("./one/", root),
      prefix: "/x/",
      fallthrough: true,
      headers: { "X-Mount": "one", "Cache-Control": "no-store" },
    },
    {
      dir: new URL("./two/", root),
      prefix: "x",
      immutable: false,
      cacheControl: "public, max-age=60",
      allow: (_host, pathname) => pathname !== "/x/blocked.txt",
    },
    // The default prefix, `/assets`, with dotfiles served.
    { dir: new URL("./two/", root), dotfiles: "allow" },
  ]
}

const TEXT = "text/plain; charset=utf-8"
const IMMUTABLE = "public, max-age=31536000, immutable"

interface Served {
  readonly status: number
  readonly body: string
  /** Compared only for a served file: each runtime types a refusal's plain-text body its own way. */
  readonly headers?: Readonly<Record<string, string | null>>
}

/** Each case: a name, the request, and what every runtime answers, or `"app"` when no mount takes it. */
export const STATIC_MOUNT_CASES: readonly (readonly [
  name: string,
  path: string,
  method: "GET" | "HEAD" | "POST",
  expected: Served | "app",
])[] = [
  [
    "the first mount serves its file, with its own headers merged",
    "/x/shared.txt",
    "GET",
    {
      status: 200,
      body: "one",
      headers: { "content-type": TEXT, "cache-control": "no-store", "x-mount": "one" },
    },
  ],
  [
    "a file the first mount lacks reaches the second",
    "/x/only-two.txt",
    "GET",
    {
      status: 200,
      body: "only two",
      headers: { "content-type": TEXT, "cache-control": "public, max-age=60", "x-mount": null },
    },
  ],
  [
    "HEAD is answered as GET is, without a body",
    "/x/only-two.txt",
    "HEAD",
    {
      status: 200,
      body: "",
      headers: { "content-type": TEXT, "cache-control": "public, max-age=60", "x-mount": null },
    },
  ],
  [
    "a file neither has is the last mount's 404",
    "/x/missing.txt",
    "GET",
    { status: 404, body: "Not Found" },
  ],
  // An encoded `..` is resolved by every runtime's URL parser before a mount sees it; an encoded
  // backslash is not, and Windows would split on it.
  [
    "traversal passes the first mount and is refused by the second",
    "/x/a%5C..%5Cshared.txt",
    "GET",
    { status: 403, body: "Forbidden" },
  ],
  ["a malformed path is a 400", "/x/%ZZ", "GET", { status: 400, body: "Bad Request" }],
  [
    "a hidden file answers as a missing one",
    "/x/.hidden.txt",
    "GET",
    { status: 404, body: "Not Found" },
  ],
  ["a path `allow` refuses reaches the app, never the disk", "/x/blocked.txt", "GET", "app"],
  [
    "the default prefix is /assets, immutable",
    "/assets/only-two.txt",
    "GET",
    {
      status: 200,
      body: "only two",
      headers: { "content-type": TEXT, "cache-control": IMMUTABLE, "x-mount": null },
    },
  ],
  [
    'dotfiles: "allow" serves a hidden file',
    "/assets/.hidden.txt",
    "GET",
    {
      status: 200,
      body: "hidden",
      headers: { "content-type": TEXT, "cache-control": IMMUTABLE, "x-mount": null },
    },
  ],
  ["a directory is the app's", "/x/", "GET", "app"],
  ["a path no prefix covers is the app's", "/elsewhere/shared.txt", "GET", "app"],
  ["a prefix matches whole segments only", "/xy/shared.txt", "GET", "app"],
  ["only GET and HEAD are served", "/x/shared.txt", "POST", "app"],
]

/** Send `path` to `base` and read the answer in the shape {@link STATIC_MOUNT_CASES} expects. */
export async function staticMountAnswer(
  base: string,
  path: string,
  method: "GET" | "HEAD" | "POST",
  expected: Served | "app",
): Promise<Served | "app"> {
  const response = await fetch(base + path, { method })
  const body = await response.text()
  if (expected === "app")
    return response.status === 200 && body === STATIC_MOUNTS_APP
      ? "app"
      : { status: response.status, body }
  if (expected.headers === undefined) return { status: response.status, body }
  const headers: Record<string, string | null> = {}
  for (const name of Object.keys(expected.headers)) headers[name] = response.headers.get(name)
  return { status: response.status, body, headers }
}

type StaticHandler = (request: Request) => Promise<Response | undefined> | undefined

/** Each form `hashedFiles` takes, each naming `/only-two.txt` alone. */
const HASHED_FILES_FORMS: Readonly<Record<string, HashedFiles>> = {
  paths: ["/only-two.txt"],
  patterns: [/only-two/],
  // Asked twice: a global RegExp must not keep `lastIndex` between paths.
  global: [/only-two/g],
  predicate: (path) => path === "/only-two.txt",
}

/** What {@link hashedFilesAnswers} reads for every form: the named file twice, then another. */
export const HASHED_FILES_EXPECTED = [IMMUTABLE, IMMUTABLE, "no-cache"]

/** Values `hashedFiles` refuses with a TypeError carrying {@link HASHED_FILES_REFUSAL}. */
export const HASHED_FILES_REFUSED: readonly unknown[] = [
  new Map([["/only-two.txt", false]]),
  [1],
  7,
]
export const HASHED_FILES_REFUSAL = "hashedFiles must be paths, an array of RegExps, or a function"

/** The `cache-control` each form of `hashedFiles` gives, by form, through the suite's `serveStatic`. */
export async function hashedFilesAnswers(
  serveStatic: (options: ServeStaticOptions) => StaticHandler,
): Promise<Record<string, (string | null | undefined)[]>> {
  const dir = new URL("./fixtures/static-mounts/two/", import.meta.url)
  const answers: Record<string, (string | null | undefined)[]> = {}
  for (const [name, hashedFiles] of Object.entries(HASHED_FILES_FORMS)) {
    const handler = serveStatic({ dir, prefix: "/", hashedFiles, cacheControl: "no-cache" })
    const cacheOf = async (path: string) =>
      (await handler(new Request(`http://x${path}`)))?.headers.get("cache-control")
    answers[name] = [
      await cacheOf("/only-two.txt"),
      await cacheOf("/only-two.txt"),
      await cacheOf("/shared.txt"),
    ]
  }
  return answers
}

/** The message each refused `hashedFiles` value throws, or `undefined` when one is accepted. */
export function hashedFilesRefusals(
  serveStatic: (options: unknown) => unknown,
): (string | undefined)[] {
  const dir = new URL("./fixtures/static-mounts/two/", import.meta.url)
  return HASHED_FILES_REFUSED.map((hashedFiles) => {
    try {
      serveStatic({ dir, hashedFiles })
      return undefined
    } catch (error) {
      return error instanceof TypeError ? error.message : String(error)
    }
  })
}
