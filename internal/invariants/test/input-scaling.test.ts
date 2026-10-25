/**
 * Every reader of bytes a client sends does work linear in their length. Each member reads hostile
 * shapes (a delimiter run ending in a character that breaks the match, deep nesting, many entries,
 * an opener never closed) at n and 16n
 * characters; the CPU time must grow about 16 times, not the 256 a quadratic reader shows. n grows
 * until one read costs milliseconds, so a quadratic reader costs seconds at 16n, and both sizes stay
 * under the reader's own cap, which would otherwise hide a quadratic below it. The ratio is of CPU
 * time, medians of interleaved runs, judged against 64: four times linear, a quarter of quadratic.
 *
 * The regex guard (`linear-regex.test.ts`) checks every pattern statically; this suite times the
 * readers themselves, so it also catches loops and patterns the analysis cannot see.
 */
import { describe, expect, test } from "bun:test"
import { type StandardSchemaV1, server } from "@nifrajs/core"
import { parseCookies } from "@nifrajs/core/cookies"
import { multipartBody } from "@nifrajs/core/multipart"
import { parseByteRange } from "@nifrajs/core/range"
import { ifRangeAllowsPartial, isNotModified } from "@nifrajs/core/static-file"
import { verifyWebhook } from "@nifrajs/core/webhook"
import { parse as parseWire } from "@nifrajs/core/wire"
import { respondGraphql } from "@nifrajs/graphql/http"
import { localeDetector } from "@nifrajs/i18n/detector"
import { lintPostgresStatement } from "@nifrajs/mcp-db/postgres"
import { basicAuth, compression } from "@nifrajs/middleware"
import { buildSchema } from "graphql"

/** Linear doubles nothing; quadratic multiplies the time by 256 at 16n. */
const LIMIT = 64
const MAX_INPUT = 1 << 20
const RUNS = 3
/** The server's default body limit: a larger body is refused before any parser reads it. */
const BODY_CAP = 1_000_000

type Shape = (n: number) => string

interface Reader {
  readonly name: string
  /** The longest input the reader parses before refusing it; both sizes stay under it. */
  readonly cap?: number
  readonly shapes: Readonly<Record<string, Shape>>
  readonly read: (input: string) => unknown
}

/** `unit` repeated to about `n` characters, between `head` and `tail`. */
const fill =
  (unit: string, head = "", tail = ""): Shape =>
  (n) =>
    head + unit.repeat(Math.max(1, Math.ceil((n - head.length - tail.length) / unit.length))) + tail

const cpu = (): number => {
  const used = process.cpuUsage()
  return used.user + used.system
}

/** The CPU clock's step: a batch must span many of them before its time means anything. */
const STEP_US = ((): number => {
  const start = cpu()
  let now = start
  while (now === start) now = cpu()
  return now - start
})()
const TARGET_US = Math.max(2_000, 50 * STEP_US)

async function cost(read: Reader["read"], input: string, reps: number): Promise<number> {
  const start = cpu()
  for (let i = 0; i < reps; i++) await read(input)
  return cpu() - start
}

const median = (values: readonly number[]): number =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0

/** CPU time at 16n over CPU time at n, with n (and the batch size) grown until n costs TARGET_US. */
async function growth(reader: Reader, shape: Shape): Promise<{ n: number; ratio: number }> {
  const most = Math.floor(Math.min(reader.cap ?? MAX_INPUT, MAX_INPUT) / 16)
  let n = 64
  let reps = 1
  await cost(reader.read, shape(n), 1)
  while (n * 2 <= most && (await cost(reader.read, shape(n), reps)) < TARGET_US) n *= 2
  while (reps < 1 << 14 && (await cost(reader.read, shape(n), reps)) < TARGET_US) reps *= 2
  const small: number[] = []
  const large: number[] = []
  for (let run = 0; run < RUNS; run++) {
    small.push(await cost(reader.read, shape(n), reps))
    large.push(await cost(reader.read, shape(16 * n), reps))
  }
  return { n, ratio: median(large) / Math.max(median(small), 1) }
}

const anything: StandardSchemaV1<unknown, unknown> = {
  "~standard": { version: 1, vendor: "invariants", validate: (value) => ({ value }) },
}

const app = server({ clientIp: { trustedHops: 1 } })
  .use(compression({ threshold: 0 }))
  .get("/p/:id", (c) => c.params.id.length)
  .get("/m/:a-:b", (c) => c.params.a.length)
  .get("/w/*", () => 1)
  .get("/q", { query: anything }, () => 1)
  .get("/ip", (c) => c.clientIp ?? null)
  .get("/text", () => new Response("x".repeat(2048), { headers: { "content-type": "text/plain" } }))
  .post("/f", { body: anything }, () => 1)
  .post("/j", { body: anything }, () => 1)
  .post(
    "/mp",
    { body: multipartBody(anything, { maxFields: 1 << 20, maxFieldBytes: 1 << 24 }) },
    () => 1,
  )
const localized = server()
  .use(localeDetector({ locales: ["en", "fr", "de"], defaultLocale: "en" }))
  .get("/", (c) => c.locale)
const guarded = server()
  .use(basicAuth({ username: "u", password: "p" }))
  .get("/", () => 1)
const schema = buildSchema("type Query { hello: String, me: Query }")

const get = (url: string, headers?: Record<string, string>) =>
  app.fetch(new Request(`http://x${url}`, headers === undefined ? undefined : { headers }))
const post = (path: string, type: string, body: string) =>
  app.fetch(
    new Request(`http://x${path}`, { method: "POST", headers: { "content-type": type }, body }),
  )
const BOUNDARY = "b0undary"
const multipart = (body: string) => post("/mp", `multipart/form-data; boundary=${BOUNDARY}`, body)

const READERS: readonly Reader[] = [
  {
    name: "route path",
    shapes: {
      "encoded slashes in a param": fill("%2F", "/p/"),
      "bad escapes in a param": fill("%", "/p/", "x"),
      "a mixed segment of separators": fill("-", "/m/", "x"),
      "a deep wildcard": fill("a/", "/w/", "x"),
      "a run of slashes": fill("/", "", "x"),
      "dot segments": fill("./", "/", "x"),
      "an unmatched deep path": fill("/a"),
    },
    read: (path) => get(path),
  },
  {
    name: "query string",
    shapes: {
      "many pairs": fill("a=1&", "/q?"),
      "a run of separators": fill("&", "/q?", "x"),
      "a run of equals": fill("=", "/q?", "x"),
      "bad escapes": fill("%", "/q?a=", "x"),
      "bracketed keys": fill("a[", "/q?", "x"),
    },
    read: (url) => get(url),
  },
  {
    name: "urlencoded body",
    cap: BODY_CAP,
    shapes: {
      "many pairs": fill("a=1&"),
      "a run of separators": fill("&", "", "x"),
      "bad escapes": fill("%", "a=", "x"),
      "escaped plus signs": fill("%2B+"),
    },
    read: (body) => post("/f", "application/x-www-form-urlencoded", body),
  },
  {
    name: "JSON body",
    cap: BODY_CAP,
    shapes: {
      "many keys": (n) =>
        `{${Array.from({ length: Math.max(1, Math.floor(n / 8)) }, (_, i) => `"k${i}":0`).join(",")}}`,
      "a long array": fill("0,", "[", "0]"),
      "escapes in a string": fill("\\u0041", '"', '"'),
      "repeated proto keys": fill('"__proto__":0,', "{", '"a":0}'),
    },
    read: (body) => post("/j", "application/json", body),
  },
  {
    name: "content-type parameters",
    shapes: {
      "many parameters": fill(";a=b", "application/json"),
      "a run of semicolons": fill(";", "application/json", "x"),
      "an open quote": fill('"', "application/json;a=", "x"),
    },
    read: (type) => post("/j", type, "{}"),
  },
  {
    name: "multipart body",
    cap: BODY_CAP,
    shapes: {
      "many parts": fill(
        `--${BOUNDARY}\r\ncontent-disposition: form-data; name="a"\r\n\r\nx\r\n`,
        "",
        `--${BOUNDARY}--\r\n`,
      ),
      "CRLF runs in a part": fill(
        "\r\n",
        `--${BOUNDARY}\r\ncontent-disposition: form-data; name="a"\r\n\r\n`,
        `\r\n--${BOUNDARY}--\r\n`,
      ),
      "near-miss boundaries": fill(
        `\r\n--${BOUNDARY.slice(0, -1)}`,
        `--${BOUNDARY}\r\ncontent-disposition: form-data; name="a"\r\n\r\n`,
        `\r\n--${BOUNDARY}--\r\n`,
      ),
      "a long header line": fill(
        "; a=b",
        `--${BOUNDARY}\r\ncontent-disposition: form-data; name="a"`,
        `\r\n\r\nx\r\n--${BOUNDARY}--\r\n`,
      ),
    },
    read: (body) => multipart(body),
  },
  {
    name: "Cookie header",
    shapes: {
      "many pairs": fill("a=b; "),
      "a run of semicolons": fill(";", "", "x"),
      "a run of equals": fill("=", "", "x"),
      "open quotes": fill('"', "a=", "x"),
      "bad escapes": fill("%", "a=", "x"),
      "a name with no value": fill("a", "", ";"),
    },
    read: (header) => parseCookies(header),
  },
  {
    name: "Range header",
    cap: 16 * 1024,
    shapes: {
      "many ranges": fill("0-1,", "bytes="),
      "spaces before a bad tail": fill(" ", "bytes=", "x"),
      "a run of dashes": fill("-", "bytes=", "x"),
      "a long number": fill("1", "bytes=", "-"),
    },
    read: (value) => parseByteRange(value, 1_000_000_000),
  },
  {
    name: "If-None-Match and If-Range",
    shapes: {
      "many tags": fill('"a", '),
      "weak prefixes": fill("W/", "", "x"),
      "a run of commas": fill(",", "", "x"),
      "open quotes": fill('"', "", "x"),
    },
    read: (value) => [
      isNotModified(value, null, '"etag"', undefined),
      ifRangeAllowsPartial(value, '"etag"', undefined),
    ],
  },
  {
    name: "Accept-Language",
    shapes: {
      "many weighted tags": fill("en;q=0.1, "),
      "a run of dashes": fill("-", "", "x"),
      "a run of semicolons": fill(";", "en", "x"),
      "many wildcards": fill("*,", "", "x"),
    },
    read: (value) =>
      localized.fetch(new Request("http://x/", { headers: { "accept-language": value } })),
  },
  {
    name: "Accept-Encoding",
    shapes: {
      "many weighted codings": fill("gzip;q=0.5, "),
      "a run of commas": fill(",", "", "x"),
      "a run of semicolons": fill(";", "gzip", "x"),
    },
    read: (value) => get("/text", { "accept-encoding": value }),
  },
  {
    name: "X-Forwarded-For",
    shapes: {
      "many hops": fill("1.1.1.1, "),
      "a run of commas": fill(",", "", "x"),
      "a long IPv6 run": fill("::", "", "x"),
    },
    read: (value) => get("/ip", { "x-forwarded-for": value }),
  },
  {
    name: "Authorization: Basic",
    shapes: {
      "long credentials": fill("QUFB", "Basic "),
      "a run of spaces": fill(" ", "Basic", "x"),
      "padding runs": fill("=", "Basic QQ", "x"),
    },
    read: (value) => guarded.fetch(new Request("http://x/", { headers: { authorization: value } })),
  },
  {
    name: "webhook signature",
    shapes: {
      "many signatures": fill("v1=00,", "t=1,"),
      "a long signature": fill("ab", "t=1,v1="),
      "a run of commas": fill(",", "t=1", "x"),
    },
    read: (value) =>
      verifyWebhook(
        new Request("http://x/", {
          method: "POST",
          headers: { "stripe-signature": value },
          body: "{}",
        }),
        "s".repeat(40),
        { provider: "stripe", toleranceSeconds: 1e12 },
      ),
  },
  {
    name: "wire value",
    shapes: {
      "a long array": fill("0,", "[", "0]"),
      "escapes in a string": fill("\\u0041", '"', '"'),
      "deep arrays": (n) => `${"[".repeat(n / 2)}${"]".repeat(n / 2)}`,
    },
    read: (text) => {
      try {
        return parseWire(text)
      } catch {
        return undefined
      }
    },
  },
  {
    name: "SQL statement",
    shapes: {
      "open parens": fill("(", "SELECT ", "x"),
      "an unterminated string": fill("a", "SELECT '"),
      "open block comments": fill("/*", "SELECT 1 ", "x"),
      "dollar quotes": fill("$a$", "SELECT ", "x"),
      "open identifiers": fill('"', "SELECT ", "x"),
      "line comments": fill("--\n", "SELECT 1 "),
      "many columns": fill("1,", "SELECT ", "1"),
    },
    read: (sql) => lintPostgresStatement(sql),
  },
  {
    name: "GraphQL document",
    cap: 1_000_000,
    shapes: {
      "many aliases": fill("a: hello ", "{ ", "}"),
      "open braces": fill("{", "query ", "x"),
      "a long comment": fill("#", "{ hello }\n"),
      "escapes in a string": fill("\\u0041", '{ hello(x: "', '") }'),
    },
    read: (query) =>
      respondGraphql(
        new Request("http://x/graphql", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ query }),
        }),
        { schema, maxBodyBytes: 1 << 24 },
      ),
  },
]

describe("input scaling", () => {
  for (const reader of READERS) {
    test(
      `${reader.name}: hostile shapes cost time linear in their length`,
      async () => {
        const superLinear: string[] = []
        for (const [label, shape] of Object.entries(reader.shapes)) {
          let { n, ratio } = await growth(reader, shape)
          // A linear reader crosses the limit only on a noisy run; a quadratic one crosses it twice.
          if (ratio >= LIMIT) ({ n, ratio } = await growth(reader, shape))
          if (ratio >= LIMIT) superLinear.push(`${label}: ${ratio.toFixed(0)}x at n=${n}`)
        }
        expect(superLinear).toEqual([])
      },
      { timeout: 120_000 },
    )
  }
})

test(
  "the harness calls a quadratic reader super-linear, under its cap too, and a linear one linear",
  async () => {
    const run = fill("/", "", "x")
    const quadratic: Reader = {
      name: "planted",
      shapes: {},
      read: (input) => input.replace(/\/+$/, ""),
    }
    const capped: Reader = { ...quadratic, cap: 32 * 1024 }
    const linear: Reader = {
      name: "control",
      shapes: {},
      read: (input) => input.lastIndexOf("x"),
    }
    expect((await growth(quadratic, run)).ratio).toBeGreaterThanOrEqual(LIMIT)
    expect((await growth(capped, run)).ratio).toBeGreaterThanOrEqual(LIMIT)
    expect((await growth(linear, run)).ratio).toBeLessThan(LIMIT)
  },
  { timeout: 120_000 },
)
