/**
 * Generated HTTP requests for the differential app.
 *
 * Each case aims at one route with that route's natural method and body most of the time, then
 * bends one or more parts of the request: the method, the path's encoding and dot segments, the
 * query keys, the headers and the body's framing. A case also says why it is not well-formed HTTP,
 * when it is not, so the oracle can tell a runtime's own parser refusing it from the app answering it.
 */
import fc from "fast-check"
import { deliversWholeBody, type Framing, type WireRequest } from "./wire.ts"

export const ROUTE_IDS = [
  "root",
  "user",
  "userPost",
  "files",
  "whoami",
  "headers",
  "search",
  "session",
  "itemsCreate",
  "itemsUpdate",
  "itemsPatch",
  "itemsDelete",
  "upload",
  "rawText",
  "rawJson",
  "query",
  "dav",
  "old",
  "go",
  "errorStatus",
  "errorConflict",
  "errorThrow",
  "errorReject",
  "errorContract",
  "private",
  "static",
  "unknown",
] as const
export type RouteId = (typeof ROUTE_IDS)[number]

/** Routes whose handler fails on the server by design: a 5xx there is the expected answer. */
export const SERVER_FAULT_ROUTES: ReadonlySet<RouteId> = new Set([
  "errorThrow",
  "errorReject",
  "errorContract",
])

export interface Case {
  readonly route: RouteId
  readonly request: WireRequest
  /**
   * Why a runtime's own HTTP parser may refuse these bytes before the app sees them: they are not
   * well-formed HTTP/1.1, or use something not every parser supports. Empty when every runtime must
   * hand the request to the app.
   */
  readonly refusable: readonly string[]
}

const isString = (value: unknown): value is string => typeof value === "string"
const isHeader = (value: unknown): value is [string, string] =>
  Array.isArray(value) && value.length === 2 && isString(value[0]) && isString(value[1])
const isRouteId = (value: unknown): value is RouteId => ROUTE_IDS.some((route) => route === value)

function framingOf(value: unknown): Framing {
  if (typeof value === "object" && value !== null && "kind" in value) {
    if (value.kind === "length" || value.kind === "none" || value.kind === "chunked")
      return { kind: value.kind }
    if (value.kind === "declared" && "value" in value && isString(value.value))
      return { kind: "declared", value: value.value }
  }
  throw new Error(`not a framing: ${JSON.stringify(value)}`)
}

function wireRequestOf(value: unknown): WireRequest {
  if (
    typeof value !== "object" ||
    value === null ||
    !("method" in value) ||
    !("target" in value) ||
    !("headers" in value) ||
    !("body" in value) ||
    !("framing" in value)
  )
    throw new Error("a request has method, target, headers, body and framing")
  const { method, target, headers, body, framing } = value
  if (!isString(method) || !isString(target) || !isString(body))
    throw new Error("a request's method, target and body are strings")
  if (!Array.isArray(headers) || !headers.every(isHeader))
    throw new Error("a request's headers are [name, value] pairs")
  return { method, target, headers, body, framing: framingOf(framing) }
}

/** A case from the JSON a failing run prints, as `--replay` takes it. */
export function parseCase(json: string): Case {
  const value: unknown = JSON.parse(json)
  if (
    typeof value !== "object" ||
    value === null ||
    !("route" in value) ||
    !("request" in value) ||
    !("refusable" in value)
  )
    throw new Error("a case has route, request and refusable")
  const { route, request, refusable } = value
  if (!isRouteId(route)) throw new Error(`unknown route ${String(route)}`)
  if (!Array.isArray(refusable) || !refusable.every(isString))
    throw new Error("a case's refusable reasons are strings")
  return { route, request: wireRequestOf(request), refusable }
}

/** Files the harness writes under `<publicDir>/static` before any runtime starts. */
export const STATIC_FILES: Readonly<Record<string, string | number>> = {
  "hello.txt": "hello differential\n",
  "data.json": '{"a":1}',
  "nested/page.html": "<p>nested</p>\n",
  ".secret": "dotfile",
  "space name.txt": "space\n",
  "ünï.txt": "unicode name\n",
  "empty.txt": "",
  // Past the 256 KiB snapshot cap: streamed, so it takes the no-ETag lane.
  "big.bin": 300 * 1024,
}

interface Body {
  readonly contentTypes: readonly string[]
  readonly text: string
  readonly framing: Framing
  /** Why the framing is not well-formed, when it is not. */
  readonly malformed: string | undefined
}

interface Draft {
  readonly route: RouteId
  readonly method: string
  readonly path: string
  readonly query?: string
  readonly body?: Body
  readonly headers?: readonly (readonly [string, string])[]
}

const plainSegment = fc.stringMatching(/^[a-z0-9_-]{1,10}$/)
const unicodeText = fc.string({ unit: "grapheme", minLength: 1, maxLength: 6 })

/** A non-ASCII string sent as raw UTF-8: RFC 9112 does not allow it in a target, runtimes vary. */
const rawUnicode = unicodeText
  .map((text) => [...text].filter((char) => (char.codePointAt(0) ?? 0) > 0x7f).join(""))
  .filter((text) => text.length > 0)

const ODD_SEGMENTS = [
  ".",
  "..",
  "%2e",
  "%2E%2e",
  ".%2e",
  "...",
  "",
  "%2F",
  "a%2Fb",
  "%5C",
  "\\",
  "..\\",
  "%00",
  "%",
  "%zz",
  "%E0%A4%A",
  "%C0%AF",
  "%ED%A0%80",
  "%FF",
  "%25",
  "%252e",
  "%20",
  "+",
  ";x",
  "a;b=c",
  "@",
  ":",
  "!$&'()*+,=",
  "~",
  "{x}",
  '"q"',
  "`t`",
  "^",
  "<b>",
  "|",
  "[x]",
  "__proto__",
  "constructor",
] as const

const segment = fc.oneof(
  { weight: 6, arbitrary: plainSegment },
  { weight: 2, arbitrary: unicodeText.map(encodeURIComponent) },
  { weight: 1, arbitrary: rawUnicode },
  { weight: 3, arbitrary: fc.constantFrom(...ODD_SEGMENTS) },
)
const segments = fc.array(segment, { minLength: 1, maxLength: 4 })

const queryKey = fc.oneof(
  { weight: 4, arbitrary: fc.constantFrom("q", "page", "sort", "to", "tag") },
  {
    weight: 2,
    arbitrary: fc.constantFrom(
      "__proto__",
      "constructor",
      "prototype",
      "q[]",
      "q[0]",
      "a[b]",
      "__proto__[x]",
      "",
      "%",
      "%zz",
      "q%00",
      "Q",
      "+q",
      "q.x",
      "toString",
      "hasOwnProperty",
    ),
  },
  { weight: 1, arbitrary: plainSegment },
  { weight: 1, arbitrary: unicodeText.map(encodeURIComponent) },
)

const queryValue = fc.oneof(
  { weight: 3, arbitrary: plainSegment },
  { weight: 2, arbitrary: fc.integer({ min: -5, max: 200 }).map(String) },
  {
    weight: 3,
    arbitrary: fc.constantFrom(
      "",
      "asc",
      "desc",
      "ASC",
      "1e2",
      "0x10",
      "%201",
      "1.5",
      "NaN",
      "Infinity",
      "%",
      "%zz",
      "%E0%A4%A",
      "+",
      "a+b",
      "%2B",
      "//evil.example",
      "/ok",
      "/%5Cevil",
      "/\\evil",
      "https://evil.example",
      "/a%0d%0aset-cookie:x=1",
      "%00",
      "x".repeat(70),
    ),
  },
  { weight: 1, arbitrary: unicodeText.map(encodeURIComponent) },
)

const query = fc
  .tuple(
    fc.array(fc.tuple(queryKey, fc.option(queryValue, { nil: undefined })), { maxLength: 5 }),
    fc.constantFrom("&", "&", "&", "&&", ";"),
  )
  .map(([pairs, separator]) =>
    pairs.map(([key, value]) => (value === undefined ? key : `${key}=${value}`)).join(separator),
  )

const length = (text: string) => new TextEncoder().encode(text).length

/** How a body is framed: honestly most of the time, otherwise with a length that lies. */
function framingFor(
  text: string,
): fc.Arbitrary<{ framing: Framing; malformed: string | undefined }> {
  const actual = length(text)
  return fc.oneof(
    {
      weight: 16,
      arbitrary: fc.constant({ framing: { kind: "length" } as const, malformed: undefined }),
    },
    {
      weight: 2,
      arbitrary: fc.constant({ framing: { kind: "chunked" } as const, malformed: undefined }),
    },
    {
      weight: 3,
      arbitrary: fc
        .constantFrom(
          "0",
          String(actual + 10),
          String(Math.max(actual - 1, 0)),
          "4097",
          "99999999999999999999",
          "1e3",
          "-1",
          "+5",
          "0x10",
          `${actual}, ${actual}`,
          `${actual},${actual + 1}`,
          "",
        )
        .map((value) => ({
          framing: { kind: "declared", value } as const,
          malformed:
            String(Number(value)) === value && Number(value) >= 0
              ? undefined
              : "content-length syntax",
        })),
    },
  )
}

function body(
  contentTypes: fc.Arbitrary<readonly string[]>,
  text: fc.Arbitrary<string>,
): fc.Arbitrary<Body> {
  return fc.tuple(contentTypes, text).chain(([types, content]) =>
    framingFor(content).map(({ framing, malformed }) => ({
      contentTypes: types,
      text: content,
      framing,
      malformed,
    })),
  )
}

const JSON_TYPES = [
  "application/json",
  "application/json; charset=utf-8",
  "APPLICATION/JSON",
  "application/json;charset=UTF-8",
  "application/json; charset=utf-16",
  "application/json; charset=latin1",
  "application/vnd.api+json",
  "application/merge-patch+json",
  "text/json",
  "text/plain",
  "text/plain;charset=utf-8",
  "application/x-www-form-urlencoded",
  "multipart/form-data",
  "multipart/form-data; boundary=x",
  "application/octet-stream",
  "",
  "application/json, text/plain",
  "json",
] as const

/** Usually one JSON content type; sometimes none, a wrong one, or two of them. */
const jsonTypes = fc.oneof(
  { weight: 10, arbitrary: fc.constant(["application/json"]) },
  { weight: 4, arbitrary: fc.constantFrom(...JSON_TYPES).map((type) => [type]) },
  { weight: 1, arbitrary: fc.constant([]) },
  {
    weight: 1,
    arbitrary: fc
      .tuple(fc.constantFrom(...JSON_TYPES), fc.constantFrom(...JSON_TYPES))
      .map((pair) => [...pair]),
  },
)

const itemValue = fc.record(
  {
    name: fc.string({ minLength: 1, maxLength: 40 }),
    qty: fc.integer({ min: 0, max: 1000 }),
    tags: fc.array(fc.string({ maxLength: 20 }), { maxLength: 4 }),
  },
  { requiredKeys: ["name", "qty"] },
)

const BIG = [0, 1, 4095, 4096, 4097, 20_000, 70_000] as const

const MALFORMED_JSON = [
  "",
  "{",
  '{"name":',
  "{'name':'a','qty':1}",
  '{"name":"a","qty":1,}',
  "NaN",
  '﻿{"name":"a","qty":1}',
  "[".repeat(2000),
  '{"name":"a","qty":1e400}',
  '{"name":"\\ud800","qty":1}',
  '{"name":"a","name":"b","qty":1}',
  "null",
  "true",
  '"str"',
  '{"name":"a","qty":1}garbage',
  '{"name":"a","qty":1}{"name":"b","qty":2}',
  '{"__proto__":{"polluted":1},"name":"a","qty":1}',
  '{"constructor":{"prototype":{"polluted":1}},"name":"a","qty":1}',
  '{"name":"a\u0000","qty":1}',
  '{"name":"a","qty":"1"}',
  '{"name":"a","qty":-1}',
  '{"name":"a","qty":1.5}',
  '{"name":"","qty":1}',
  '{"name":"a","qty":1,"tags":["a","b","c","d","e"]}',
  '{"name":"a","qty":1,"extra":true}',
] as const

const jsonText = fc.oneof(
  { weight: 6, arbitrary: itemValue.map((value) => JSON.stringify(value)) },
  { weight: 4, arbitrary: fc.constantFrom(...MALFORMED_JSON) },
  {
    weight: 2,
    arbitrary: fc.jsonValue({ maxDepth: 3 }).map((value) => JSON.stringify(value) ?? "null"),
  },
  {
    weight: 1,
    arbitrary: fc.tuple(itemValue, fc.nat()).map(([value, cut]) => {
      const text = JSON.stringify(value)
      return text.slice(0, cut % Math.max(text.length, 1))
    }),
  },
  {
    weight: 1,
    arbitrary: fc.constantFrom(...BIG).map((size) => `{"name":"${"a".repeat(size)}","qty":1}`),
  },
)

const urlencodedText = fc.oneof(
  itemValue.map(
    (value) =>
      `name=${encodeURIComponent(value.name)}&qty=${value.qty}${(value.tags ?? []).map((tag) => `&tags=${encodeURIComponent(tag)}`).join("")}`,
  ),
  fc.constantFrom(
    "name=a&qty=abc",
    "name[]=a&qty=1",
    "__proto__[x]=1&name=a&qty=1",
    "name=a&qty=1&qty=2",
    "=&&=",
    "%zz=1",
    "name=%E0%A4%A&qty=1",
  ),
)

const anyBody = fc.oneof(
  { weight: 6, arbitrary: body(jsonTypes, jsonText) },
  {
    weight: 2,
    arbitrary: body(
      fc.constantFrom(
        ["application/x-www-form-urlencoded"],
        ["application/x-www-form-urlencoded; charset=utf-8"],
      ),
      urlencodedText,
    ),
  },
  {
    weight: 1,
    arbitrary: body(fc.constant(["text/plain"]), fc.string({ unit: "grapheme", maxLength: 40 })),
  },
)

/** A multipart body built part by part, with the ways a form goes wrong. */
const multipartBody: fc.Arbitrary<Body> = fc
  .record({
    boundary: fc.constantFrom(
      "differential",
      "----x",
      "a".repeat(70),
      "a".repeat(75),
      "with space",
      'q"uote',
    ),
    typeShape: fc.constantFrom(
      "normal",
      "normal",
      "normal",
      "quoted",
      "missing",
      "mismatched",
      "uppercase",
      "no-params",
    ),
    title: fc.option(fc.oneof(plainSegment, fc.string({ maxLength: 60 })), { nil: undefined }),
    file: fc.option(
      fc.record({
        name: fc.constantFrom("a.txt", "../../etc/passwd", 'a"b.txt', "ünï.txt", "", "a\\b.txt"),
        type: fc.constantFrom("text/plain", "application/octet-stream", "image/png", ""),
        size: fc.constantFrom(0, 1, 511, 512, 513, 5000),
      }),
      { nil: undefined },
    ),
    extras: fc.array(
      fc.constantFrom(
        "dup-title",
        "nameless",
        "proto",
        "array-name",
        "second-file",
        "no-disposition",
      ),
      { maxLength: 3 },
    ),
    closing: fc.constantFrom(
      "closed",
      "closed",
      "closed",
      "unclosed",
      "lf-only",
      "preamble",
      "epilogue",
    ),
  })
  .chain((shape) => {
    const eol = shape.closing === "lf-only" ? "\n" : "\r\n"
    const parts: string[] = []
    const field = (name: string, value: string) =>
      `Content-Disposition: form-data; name="${name}"${eol}${eol}${value}`
    if (shape.title !== undefined) parts.push(field("title", shape.title))
    if (shape.file !== undefined) {
      const typeLine = shape.file.type === "" ? "" : `${eol}Content-Type: ${shape.file.type}`
      parts.push(
        `Content-Disposition: form-data; name="file"; filename="${shape.file.name}"${typeLine}${eol}${eol}${"f".repeat(shape.file.size)}`,
      )
    }
    for (const extra of shape.extras) {
      if (extra === "dup-title") parts.push(field("title", "again"))
      else if (extra === "nameless") parts.push(`Content-Disposition: form-data${eol}${eol}x`)
      else if (extra === "proto") parts.push(field("__proto__", "x"))
      else if (extra === "array-name") parts.push(field("title[]", "x"))
      else if (extra === "second-file")
        parts.push(`Content-Disposition: form-data; name="file"; filename="b.txt"${eol}${eol}bb`)
      else parts.push(`Content-Type: text/plain${eol}${eol}x`)
    }
    let text = shape.closing === "preamble" ? `preamble${eol}` : ""
    for (const part of parts) text += `--${shape.boundary}${eol}${part}${eol}`
    if (shape.closing !== "unclosed") text += `--${shape.boundary}--${eol}`
    if (shape.closing === "epilogue") text += "epilogue"
    const typeHeader = {
      normal: `multipart/form-data; boundary=${shape.boundary}`,
      quoted: `multipart/form-data; boundary="${shape.boundary}"`,
      missing: "multipart/form-data",
      mismatched: "multipart/form-data; boundary=other",
      uppercase: `MULTIPART/FORM-DATA; BOUNDARY=${shape.boundary}`,
      "no-params": "multipart/form-data;",
    }[shape.typeShape]
    return framingFor(text).map(({ framing, malformed }) => ({
      contentTypes: [typeHeader],
      text,
      framing,
      malformed,
    }))
  })

const rawTextBody = body(
  fc.constantFrom(["text/plain"], ["application/octet-stream"], [], ["application/json"]),
  fc.oneof(
    { weight: 4, arbitrary: fc.string({ unit: "grapheme", maxLength: 60 }) },
    { weight: 1, arbitrary: fc.constantFrom(...BIG).map((size) => "t".repeat(size)) },
  ),
)

const STATIC_PATHS = [
  "hello.txt",
  "data.json",
  "nested/page.html",
  "nested%2Fpage.html",
  "nested/../hello.txt",
  ".secret",
  "space%20name.txt",
  "space name.txt",
  "%C3%BCn%C3%AF.txt",
  "empty.txt",
  "big.bin",
  "missing.txt",
  "HELLO.TXT",
  "hello.txt/",
  "hello.txt%00.html",
  "..%2fapp.ts",
  "%2e%2e/%2e%2e/package.json",
  "..%5Capp.ts",
  "nested/",
  "nested",
] as const

const STATIC_HEADERS: readonly (readonly [string, string])[] = [
  ["range", "bytes=0-3"],
  ["range", "bytes=-5"],
  ["range", "bytes=5-"],
  ["range", "bytes=0-0,2-3"],
  ["range", "bytes=0-1,1-2"],
  ["range", "bytes=99999-"],
  ["range", "bytes=abc"],
  ["range", "items=0-1"],
  ["if-none-match", "*"],
  ["if-none-match", '"nope"'],
  ["if-modified-since", "Thu, 01 Jan 2099 00:00:00 GMT"],
  ["if-modified-since", "Thu, 01 Jan 1970 00:00:00 GMT"],
  ["if-modified-since", "not a date"],
  ["if-range", '"nope"'],
  ["accept-encoding", "gzip"],
]

const pathOf = (...parts: readonly string[]) => `/${parts.join("/")}`

const drafts: fc.Arbitrary<Draft> = fc.oneof(
  fc.constant<Draft>({ route: "root", method: "GET", path: "/" }),
  segment.map((id): Draft => ({ route: "user", method: "GET", path: pathOf("users", id) })),
  fc.tuple(segment, segment).map(
    ([id, post]): Draft => ({
      route: "userPost",
      method: "GET",
      path: pathOf("users", id, "posts", post),
    }),
  ),
  segments.map(
    (rest): Draft => ({ route: "files", method: "GET", path: pathOf("files", ...rest) }),
  ),
  fc.constant<Draft>({ route: "whoami", method: "GET", path: "/whoami" }),
  fc
    .array(fc.constantFrom("0", "9", "10", "-1", "abc", "1.5", " 3 ", "", "١"), { maxLength: 2 })
    .map(
      (values): Draft => ({
        route: "headers",
        method: "GET",
        path: "/headers",
        headers: values.map((value) => ["x-count", value] as const),
      }),
    ),
  query.map((text): Draft => ({ route: "search", method: "GET", path: "/search", query: text })),
  fc.constant<Draft>({ route: "session", method: "GET", path: "/session" }),
  anyBody.map(
    (value): Draft => ({ route: "itemsCreate", method: "POST", path: "/items", body: value }),
  ),
  fc.tuple(segment, anyBody, fc.boolean()).map(
    ([id, value, taken]): Draft => ({
      route: "itemsUpdate",
      method: "PUT",
      path: pathOf("items", id),
      body: taken
        ? {
            ...value,
            text: '{"name":"taken","qty":1}',
            framing: { kind: "length" },
            malformed: undefined,
          }
        : value,
    }),
  ),
  fc
    .tuple(
      segment,
      body(
        jsonTypes,
        fc.oneof(
          fc.integer({ min: -2, max: 5 }).map((qty) => `{"qty":${qty}}`),
          jsonText,
        ),
      ),
    )
    .map(
      ([id, value]): Draft => ({
        route: "itemsPatch",
        method: "PATCH",
        path: pathOf("items", id),
        body: value,
      }),
    ),
  segment.map(
    (id): Draft => ({ route: "itemsDelete", method: "DELETE", path: pathOf("items", id) }),
  ),
  multipartBody.map(
    (value): Draft => ({ route: "upload", method: "POST", path: "/upload", body: value }),
  ),
  rawTextBody.map(
    (value): Draft => ({ route: "rawText", method: "POST", path: "/raw/text", body: value }),
  ),
  body(jsonTypes, jsonText).map(
    (value): Draft => ({ route: "rawJson", method: "POST", path: "/raw/json", body: value }),
  ),
  body(
    jsonTypes,
    fc.oneof(
      plainSegment.map((q) => JSON.stringify({ q })),
      jsonText,
    ),
  ).map((value): Draft => ({ route: "query", method: "QUERY", path: "/query", body: value })),
  segments.map(
    (rest): Draft => ({ route: "dav", method: "PROPFIND", path: pathOf("dav", ...rest) }),
  ),
  segments.map((rest): Draft => ({ route: "old", method: "GET", path: pathOf("old", ...rest) })),
  queryValue.map((to): Draft => ({ route: "go", method: "GET", path: "/go", query: `to=${to}` })),
  fc
    .oneof(
      fc.integer({ min: 395, max: 505 }).map(String),
      fc.constantFrom("4e2", "0x1a0", "418.0", " 418", "-418", "%34%31%38"),
    )
    .map(
      (code): Draft => ({
        route: "errorStatus",
        method: "GET",
        path: pathOf("error", "status", code),
      }),
    ),
  fc.constant<Draft>({ route: "errorConflict", method: "GET", path: "/error/conflict" }),
  fc.constant<Draft>({ route: "errorThrow", method: "GET", path: "/error/throw" }),
  fc.constant<Draft>({ route: "errorReject", method: "GET", path: "/error/reject" }),
  fc.constant<Draft>({ route: "errorContract", method: "GET", path: "/error/contract" }),
  fc
    .constantFrom(
      "Bearer differential",
      "bearer differential",
      "Bearer  differential",
      "Bearer",
      "",
      "Basic eDp5",
    )
    .map(
      (auth): Draft => ({
        route: "private",
        method: "GET",
        path: "/private/me",
        headers: auth === "" ? [] : [["authorization", auth]],
      }),
    ),
  fc
    .tuple(
      fc.constantFrom(...STATIC_PATHS),
      fc.option(fc.constantFrom(...STATIC_HEADERS), { nil: undefined }),
    )
    .map(
      ([file, header]): Draft => ({
        route: "static",
        method: "GET",
        path: `/static/${file}`,
        headers: header === undefined ? [] : [header],
      }),
    ),
  segments.map((parts): Draft => ({ route: "unknown", method: "GET", path: pathOf(...parts) })),
)

const METHODS = {
  standard: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  unusual: [
    "QUERY",
    "PROPFIND",
    "MKCOL",
    "PURGE",
    "M-SEARCH",
    "get",
    "Get",
    "FOO_BAR",
    "X",
    "TRACE",
    "M".repeat(40),
  ],
  invalid: ["GE(T", "G T"],
} as const

const methodChoice = fc.oneof(
  { weight: 12, arbitrary: fc.constant<string | undefined>(undefined) },
  { weight: 3, arbitrary: fc.constantFrom<string | undefined>(...METHODS.standard) },
  { weight: 1, arbitrary: fc.constantFrom<string | undefined>(...METHODS.unusual) },
  { weight: 1, arbitrary: fc.constantFrom<string | undefined>(...METHODS.invalid, "CONNECT") },
)

const decoration = fc.constantFrom(
  "none",
  "none",
  "none",
  "none",
  "trailing-slash",
  "double-slash-lead",
  "double-slash-mid",
  "dot-prefix",
  "dotdot-prefix",
  "fragment",
  "absolute-form",
)

function decorate(path: string, how: string): string {
  switch (how) {
    case "trailing-slash":
      return `${path}/`
    case "double-slash-lead":
      return `/${path}`
    case "double-slash-mid": {
      const second = path.indexOf("/", 1)
      return second === -1 ? `${path}//` : `${path.slice(0, second)}/${path.slice(second)}`
    }
    case "dot-prefix":
      return `/.${path}`
    case "dotdot-prefix":
      return `/x/..${path}`
    case "fragment":
      return `${path}#frag`
    case "absolute-form":
      return `http://127.0.0.1${path}`
    default:
      return path
  }
}

const hostChoice = fc.oneof(
  { weight: 14, arbitrary: fc.constant<readonly string[]>(["127.0.0.1"]) },
  {
    weight: 1,
    arbitrary: fc.constantFrom<readonly string[]>(
      [],
      ["127.0.0.1", "127.0.0.1"],
      ["127.0.0.1", "example.com"],
      ["example.com"],
      ["x/users/7#"],
      ["127.0.0.1:99999"],
      [""],
      ["[::1]"],
      ["a b"],
      ["ü.example"],
    ),
  },
)

const COOKIES = [
  "session=abc",
  "session=abc; visits=3",
  "session=a; session=b",
  "visits=abc; session=s",
  "session=%E0%A4%A",
  "session=",
  "=x",
  'session="quoted"',
  "session=a%3Bb",
  "Session=x",
  "session=abc;;visits=1",
  `session=${"c".repeat(5000)}`,
] as const

const extraHeader = fc.oneof(
  {
    weight: 3,
    arbitrary: fc
      .oneof(plainSegment, fc.constantFrom("café", "日本", "a\tb", " pad ", ""))
      .map((value) => [["x-caller", value]] as const),
  },
  { weight: 1, arbitrary: fc.constant([["x-block", "1"]] as const) },
  {
    weight: 3,
    arbitrary: fc.constantFrom(...COOKIES).map((value) => [["cookie", value]] as const),
  },
  {
    weight: 1,
    arbitrary: fc.constant([
      ["cookie", "session=one"],
      ["cookie", "visits=2"],
    ] as const),
  },
  { weight: 1, arbitrary: fc.constant([["expect", "100-continue"]] as const) },
  {
    weight: 1,
    arbitrary: fc
      .constantFrom("gzip", "br", "identity", "*;q=0")
      .map((value) => [["accept-encoding", value]] as const),
  },
  { weight: 1, arbitrary: fc.constant([["x-http-method-override", "DELETE"]] as const) },
  { weight: 1, arbitrary: fc.constant([["origin", "https://evil.example"]] as const) },
  { weight: 1, arbitrary: fc.constant([["content-encoding", "gzip"]] as const) },
  { weight: 1, arbitrary: fc.constant([["transfer-encoding", "chunked"]] as const) },
  {
    weight: 1,
    arbitrary: fc.constantFrom("bad header", "x-ä", "x(y)").map((name) => [[name, "1"]] as const),
  },
  {
    weight: 1,
    arbitrary: fc
      .constantFrom("a\u0001b", "a\u007fb")
      .map((value) => [["x-caller", value]] as const),
  },
  {
    weight: 1,
    arbitrary: fc
      .constantFrom(9000, 17_000, 70_000)
      .map((size) => [["x-big", "b".repeat(size)]] as const),
  },
  {
    weight: 1,
    arbitrary: fc
      .constantFrom(60, 101, 130)
      .map((count) => Array.from({ length: count }, (_, at) => [`x-many-${at}`, "1"] as const)),
  },
)

function someCode(text: string, test: (code: number) => boolean): boolean {
  for (let at = 0; at < text.length; at++) if (test(text.charCodeAt(at))) return true
  return false
}

export const nonAscii = (text: string): boolean => someCode(text, (code) => code > 0x7f)

const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/

/** The methods llhttp parses. Node answers 400 to any other token and Bun.serve drops the connection. */
const LLHTTP_METHODS = new Set(
  "DELETE GET HEAD POST PUT CONNECT OPTIONS TRACE COPY LOCK MKCOL MOVE PROPFIND PROPPATCH SEARCH UNLOCK BIND REBIND UNBIND ACL REPORT MKACTIVITY CHECKOUT MERGE M-SEARCH NOTIFY SUBSCRIBE UNSUBSCRIBE PATCH PURGE MKCALENDAR LINK UNLINK SOURCE QUERY".split(
    " ",
  ),
)

function refusableReasons(
  request: WireRequest,
  hosts: readonly string[],
  bodyMalformed?: string,
): string[] {
  const reasons: string[] = []
  if (!TOKEN.test(request.method)) reasons.push("method token")
  else if (!LLHTTP_METHODS.has(request.method)) reasons.push("method outside llhttp")
  if (request.method === "CONNECT") reasons.push("CONNECT with origin-form")
  if (/[^\x21-\x7e]/.test(request.target)) reasons.push("target bytes")
  if (hosts.length !== 1) reasons.push("host count")
  else if (
    !/^[a-z0-9.-]+(?::\d{1,5})?$|^\[[0-9a-f:]+\](?::\d{1,5})?$/i.test(hosts[0] ?? "") ||
    Number(hosts[0]?.split(":")[1] ?? 0) > 65_535
  )
    reasons.push("host value")
  let headBytes = 0
  let lengths = 0
  let chunked = request.framing.kind === "chunked"
  for (const [name, value] of request.headers) {
    headBytes += name.length + value.length + 4
    if (!TOKEN.test(name)) reasons.push("header name")
    if (someCode(value, (code) => (code < 0x20 && code !== 0x09) || code === 0x7f))
      reasons.push("header value control")
    if (nonAscii(value)) reasons.push("header value non-ascii")
    if (name.toLowerCase() === "content-length") lengths++
    if (name.toLowerCase() === "transfer-encoding") chunked = true
  }
  if (headBytes > 8000) reasons.push("large head")
  if (request.headers.length > 100) reasons.push("header count")
  if (request.framing.kind === "declared" || request.framing.kind === "length") lengths++
  if (lengths > 0 && chunked) reasons.push("content-length with transfer-encoding")
  const encodings = request.headers.filter(
    ([name]) => name.toLowerCase() === "transfer-encoding",
  ).length
  if (encodings + (request.framing.kind === "chunked" ? 1 : 0) > 1)
    reasons.push("transfer-encoding twice")
  if (lengths > 1) reasons.push("content-length count")
  if (bodyMalformed !== undefined) reasons.push(bodyMalformed)
  if (!deliversWholeBody(request)) reasons.push("body shorter than its framing")
  return [...new Set(reasons)]
}

export const caseArbitrary: fc.Arbitrary<Case> = fc
  .record({
    draft: drafts,
    method: methodChoice,
    decoration,
    query: fc.option(query, { nil: undefined, freq: 6 }),
    hosts: hostChoice,
    extras: fc.array(extraHeader, { maxLength: 3 }),
  })
  .map(({ draft, method, decoration: how, query: extraQuery, hosts, extras }): Case => {
    const chosenMethod = method ?? draft.method
    const queryText = draft.query ?? extraQuery
    const fragment = how === "fragment"
    let target = decorate(draft.path, fragment ? "none" : how)
    if (queryText !== undefined) target += `?${queryText}`
    if (fragment) target += "#frag"
    const headers: (readonly [string, string])[] = hosts.map((host) => ["Host", host] as const)
    for (const type of draft.body?.contentTypes ?? []) headers.push(["Content-Type", type])
    for (const pair of draft.headers ?? []) headers.push(pair)
    for (const group of extras) for (const pair of group) headers.push(pair)
    const request: WireRequest = {
      method: chosenMethod,
      target,
      headers,
      body: draft.body?.text ?? "",
      framing: draft.body?.framing ?? { kind: "none" },
    }
    return {
      route: draft.route,
      request,
      refusable: refusableReasons(request, hosts, draft.body?.malformed),
    }
  })
