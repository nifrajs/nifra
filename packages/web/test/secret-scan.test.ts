import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { buildClient, prerenderRoutes } from "../src/build.ts"
import { buildClientVite } from "../src/build-vite.ts"
import {
  formatSecretFindings,
  type SecretExemption,
  type SecretScanInput,
  scanForSecrets,
} from "../src/internal/secret-scan.ts"
import type { RouteEntry } from "../src/manifest.ts"

// Every credential below is assembled at runtime, so this file never carries one a scanner (ours, or a
// host's push protection) would flag.
const join2 = (...parts: string[]): string => parts.join("")
const STRIPE = join2("sk_", "live_", "4eC39HqLyjWDarjtT1zdp7dc")
const AWS = join2("AKIA", "IOSFODNN7EXAMPLE")
const GITHUB = join2("ghp_", "16C7e42F292c6912E7710c838347Ae178B4a")
const PEM = join2(
  "-----BEGIN ",
  "PRIVATE KEY-----\n",
  "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7VJTUt9Us8cKj\n",
  "MzEfYyjiWA4R4/M2bS1GB4t7NXp98C3SC6dVMvDuictGeurT8jNbvJZHtCSuYEvu\n",
  "-----END ",
  "PRIVATE KEY-----",
)
const jwt = (payload: object): string =>
  [
    btoa(JSON.stringify({ alg: "HS256", typ: "JWT" })),
    btoa(JSON.stringify(payload)),
    "c2lnbmF0dXJlLWJ5dGVzLWhlcmUtMTIzNDU2",
  ]
    .join(".")
    .replaceAll("=", "")

const artifact = (text: string, input: Partial<SecretScanInput> = {}) =>
  scanForSecrets({ ...input, artifacts: [{ name: "assets/app.js", text }] })
const rules = (findings: readonly { rule: string; what: string }[]): string[] =>
  findings.map((finding) => `${finding.rule}: ${finding.what}`)

describe("format rules", () => {
  test("known secret formats are found; publishable ones are not", () => {
    const text = [
      `const a = "${STRIPE}"`,
      `const b = "${AWS}"`,
      `const c = "${GITHUB}"`,
      `const pk = "${join2("pk_", "live_", "51H8xQ2Lk3Jd9aZ")}"`,
      `const maps = "${join2("AIza", "SyD-9tSrke72PouQMnMX-a7eZSW0jkFMBWY")}"`,
    ].join("\n")
    expect(rules(artifact(text))).toEqual([
      "key-format: Stripe secret key",
      "key-format: AWS access key id",
      "key-format: GitHub token",
    ])
  })

  test("a private key needs a body; a parser's header constant is not one", () => {
    expect(rules(artifact(`const pem = ${JSON.stringify(PEM)}`))).toEqual([
      "private-key: private key",
    ])
    expect(artifact('const HEADER = "-----BEGIN PRIVATE KEY-----"')).toEqual([])
  })

  test("a URL with a password, but not a placeholder or a dev default", () => {
    const real = join2("postgres://app:", "Xk29vLq8Rt", "@db.internal:5432/app")
    expect(rules(artifact(`fetch("${real}")`))).toEqual(["credential-url: URL with a password"])
    for (const placeholder of [
      "postgres://user:password@localhost/db",
      "postgres://postgres:postgres@localhost/db",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a literal placeholder, as written in docs
      "redis://default:${REDIS_PASSWORD}@cache:6379",
      "mysql://root:<password>@localhost/db",
    ]) {
      expect(artifact(placeholder)).toEqual([])
    }
  })

  test("a service-role JWT is a key; an anon one is public by design", () => {
    expect(rules(artifact(`const k = "${jwt({ role: "service_role", iss: "x" })}"`))).toEqual([
      "key-format: service-role JWT",
    ])
    expect(artifact(`const k = "${jwt({ role: "anon", iss: "x" })}"`)).toEqual([])
  })

  test("an inline source map is decoded first", async () => {
    const { emittedScanFiles } = await import("../src/internal/secret-scan.ts")
    const map = btoa(JSON.stringify({ sourcesContent: [`const key = "${STRIPE}"`] }))
    const files = emittedScanFiles(
      "app.js",
      `x()\n//# sourceMappingURL=data:application/json;base64,${map}`,
    )
    expect(scanForSecrets({ artifacts: files }).map((finding) => finding.file)).toEqual([
      "app.js (inline source map)",
    ])
  })
})

describe("assigned secrets", () => {
  const source = (text: string, firstParty = true) =>
    scanForSecrets({ sources: [{ name: "frontend/config.ts", text, firstParty }] })

  test("a random literal assigned to a secret-like name, in first-party source only", () => {
    const text = 'export const config = { apiKey: "Zq8mW2vX9pLr4TbN7yKc3HdF" }'
    expect(rules(source(text))).toEqual(['assigned-secret: literal assigned to "apiKey"'])
    expect(source(text, false)).toEqual([])
    expect(artifact(text)).toEqual([])
  })

  test("labels, words and public keys are not secrets", () => {
    for (const text of [
      'const passwordLabel = "Enter your password"',
      'const tokenKey = "nifra_session_token"',
      `const apiKey = "${join2("AIza", "SyD-9tSrke72PouQMnMX-a7eZSW0jkFMBWY")}"`,
      'const clientSecret = "changeme"',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: source text holding an interpolation
      "const secret = `${prefix}Zq8mW2vX9pLr4TbN7yKc3HdF`",
    ]) {
      expect(source(text)).toEqual([])
    }
  })
})

describe("private environment values", () => {
  const VALUE = "Hunter2#Correct+Horse-9"
  const env = { DATABASE_PASSWORD: VALUE }
  const found = (text: string, more: Partial<SecretScanInput> = {}) =>
    rules(artifact(text, { env, ...more }))

  test("raw, URL-encoded, JSON-escaped, HTML-escaped and base64 forms", () => {
    expect(found(`x="${VALUE}"`)).toEqual(["private-env-value: value of DATABASE_PASSWORD"])
    expect(found(encodeURIComponent(VALUE))).toEqual([
      "private-env-value: value of DATABASE_PASSWORD (URL-encoded)",
    ])
    const quoted = 'Tr"ick\\y-Value-42'
    expect(
      rules(artifact(JSON.stringify({ v: quoted }), { env: { API_TOKEN: quoted } })),
    ).toContain("private-env-value: value of API_TOKEN (JSON-escaped)")
    const html = "Amp&ersand<Value>-77"
    expect(
      rules(artifact('<div title="Amp&amp;ersand&lt;Value&gt;-77">', { env: { API_TOKEN: html } })),
    ).toEqual(["private-env-value: value of API_TOKEN (HTML-escaped)"])
    // Inside a larger base64 blob the value lands at any of three byte alignments.
    for (const prefix of ["", "a", "ab", "abc"]) {
      const blob = btoa(`${prefix}${VALUE}-and-some-trailing-bytes`)
      expect(found(blob)).toEqual(["private-env-value: value of DATABASE_PASSWORD (base64)"])
    }
  })

  test("public, ambient and plain values are not secrets", () => {
    const text = "/Users/dev/app /usr/local/bin:/usr/bin abc1234def5678abc1234def5678abc1234def567"
    expect(
      artifact(text, {
        env: {
          PUBLIC_API_URL: "https://api.example.com",
          HOME: "/Users/dev/app",
          PATH: "/usr/local/bin:/usr/bin",
          GITHUB_SHA: "abc1234def5678abc1234def5678abc1234def567",
          SITE_NAME: "my-app",
        },
      }),
    ).toEqual([])
    // The same value under a public name is public by declaration.
    expect(
      artifact("https://api.example.com/v1", {
        env: {
          API_URL_SECRET: "https://api.example.com",
          PUBLIC_API_URL: "https://api.example.com",
        },
      }),
    ).toEqual([])
  })

  test("an unnamed value that looks random still counts", () => {
    const value = "Zq8mW2vX9pLr4TbN7yKc3HdF"
    expect(rules(artifact(value, { env: { UPSTREAM: value } }))).toEqual([
      "private-env-value: value of UPSTREAM",
    ])
    expect(artifact(value, { env: { UPSTREAM: value }, publicEnvPrefix: "UP" })).toEqual([])
  })
})

describe("exemptions and reports", () => {
  const exempt = (exemptions: SecretExemption[]) =>
    scanForSecrets({
      sources: [{ name: "frontend/a.ts", text: `const k = "${STRIPE}"`, firstParty: true }],
      artifacts: [{ name: "assets/a-123.js", text: `var k="${STRIPE}";var d="${AWS}"` }],
      exemptions,
    })

  test("a source finding is reported at the source, once", () => {
    expect(exempt([]).map((finding) => `${finding.file}: ${finding.what}`)).toEqual([
      "assets/a-123.js: AWS access key id",
      "frontend/a.ts: Stripe secret key",
    ])
  })

  test("an exemption covers its rule at its file, and the same text in the bundle", () => {
    const reason = "a documented test-mode fixture"
    const findings = exempt([{ rule: "key-format", file: "frontend/a.ts", reason }])
    expect(findings.map((finding) => finding.what)).toEqual(["AWS access key id"])
    // The wrong rule, or another file, covers nothing.
    expect(exempt([{ rule: "credential-url", file: "frontend/a.ts", reason }])).toHaveLength(2)
    expect(exempt([{ rule: "key-format", file: "frontend/b.ts", reason }])).toHaveLength(2)
  })

  test("an environment value is exempted by its variable", () => {
    const env = { SIGNING_KEY: "Zq8mW2vX9pLr4TbN7yKc3HdF" }
    const text = env.SIGNING_KEY
    expect(artifact(text, { env })).toHaveLength(1)
    expect(
      artifact(text, {
        env,
        exemptions: [
          { rule: "private-env-value", env: "SIGNING_KEY", reason: "a public demo key" },
        ],
      }),
    ).toEqual([])
  })

  test("an exemption must name its rule, its location and its reason", () => {
    const scan = (exemption: unknown) => () =>
      artifact("", { exemptions: [exemption as SecretExemption] })
    expect(scan({ rule: "key-format", file: "a.ts", reason: " " })).toThrow("needs a reason")
    expect(scan({ rule: "key-format", reason: "why" })).toThrow("must name a file")
    expect(scan({ rule: "key-format", env: "X", reason: "why" })).toThrow("must name a file")
    expect(scan({ rule: "everything", file: "a.ts", reason: "why" })).toThrow("rule must be one of")
  })

  test("a bundle finding names the module it came from", () => {
    const dir = mkdtempSync(`${import.meta.dir}/.tmp-secret-origin-`)
    try {
      const file = join(dir, "vendor.js")
      writeFileSync(file, `// a vendored helper\nexport const k = "${STRIPE}"\n`)
      const [finding] = scanForSecrets({
        artifacts: [
          {
            name: "assets/vendor-9f8e.js",
            text: `var k="${STRIPE}"`,
            origins: [{ name: "node_modules/helper/vendor.js", path: file }],
          },
        ],
      })
      expect(finding).toMatchObject({
        file: "node_modules/helper/vendor.js",
        line: 2,
        via: "assets/vendor-9f8e.js",
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("the report never prints the value", () => {
    const message = formatSecretFindings(artifact(`"${STRIPE}" "${AWS}"`)) ?? ""
    expect(message).toContain("Stripe secret key [key-format] sk_l... (32 chars)")
    expect(message).not.toContain(STRIPE)
    expect(message).not.toContain(AWS)
    const env = formatSecretFindings(
      artifact("Hunter2!Correct-Horse-9", { env: { DB_PASS: "Hunter2!Correct-Horse-9" } }),
    )
    expect(env).toContain("value of DB_PASS [private-env-value] 23 chars")
    expect(env).not.toContain("Hunter2")
  })
})

// Real builds: the scan fails them before anything is written.
const TMP = `${import.meta.dir}/.tmp-secret-build-`
let root: string
const write = (path: string, text: string): void => {
  const file = join(root, path)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text)
}
const options = (extra: object = {}) => ({
  routesDir: join(root, "routes"),
  outDir: join(root, "dist"),
  clientModule: join(root, "frontend/client-stub.ts"),
  publicDir: join(root, "public"),
  minify: false,
  ...extra,
})
async function failure(run: () => Promise<unknown>): Promise<string> {
  try {
    await run()
  } catch (error) {
    return (error as Error).message
  }
  throw new Error("the build passed")
}

beforeEach(() => {
  root = mkdtempSync(TMP)
  write("frontend/client-stub.ts", "export function mountRouter() {}\n")
  write("routes/index.tsx", "export default function Home() { return null }\n")
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe("client builds", () => {
  test("Bun: a key in browser source fails the build, naming the source, and writes nothing", async () => {
    write("frontend/pay.ts", `export const stripe = "${STRIPE}"\n`)
    write(
      "routes/index.tsx",
      'import { stripe } from "../frontend/pay.ts"\nexport default () => stripe\n',
    )
    const message = await failure(() => buildClient(options()))
    expect(message).toContain("frontend/pay.ts:1 Stripe secret key [key-format]")
    expect(existsSync(join(root, "dist")) ? readdirSync(join(root, "dist")) : []).toEqual([])
    const exemptions: SecretExemption[] = [
      { rule: "key-format", file: "frontend/pay.ts", reason: "test fixture" },
    ]
    await buildClient(options({ secretExemptions: exemptions }))
  })

  test("Bun: a public/ file and a define both count", async () => {
    write("public/.env", `DATABASE_URL=${join2("postgres://app:", "Xk29vLq8Rt", "@db:5432/app")}\n`)
    expect(await failure(() => buildClient(options()))).toContain(
      "public/.env:1 URL with a password [credential-url]",
    )
    rmSync(join(root, "public"), { recursive: true })
    const name = "NIFRA_TEST_SESSION_SECRET"
    process.env[name] = "Zq8mW2vX9pLr4TbN7yKc3HdF"
    try {
      write("routes/index.tsx", "export default () => __SESSION__\n")
      const message = await failure(() =>
        buildClient(options({ define: { __SESSION__: JSON.stringify(process.env[name]) } })),
      )
      expect(message).toContain(`value of ${name} [private-env-value]`)
    } finally {
      delete process.env[name]
    }
  })

  test("Vite: the same scan, with public/ included", async () => {
    write("public/keys.txt", `${AWS}\n`)
    const message = await failure(() => buildClientVite({ ...options(), root }))
    expect(message).toContain("public/keys.txt:1 AWS access key id [key-format]")
    rmSync(join(root, "public"), { recursive: true })
    write("shared/config.ts", 'export const config = { apiKey: "Zq8mW2vX9pLr4TbN7yKc3HdF" }\n')
    write(
      "routes/index.tsx",
      'import { config } from "../shared/config.ts"\nexport default () => config.apiKey\n',
    )
    expect(await failure(() => buildClientVite({ ...options(), root }))).toContain(
      'shared/config.ts:1 literal assigned to "apiKey" [assigned-secret]',
    )
  }, 60_000)
})

describe("prerender", () => {
  test("a page carrying a private value is never written", async () => {
    const out = join(root, "out")
    const route = {
      id: "/",
      pattern: "/",
      file: "index.tsx",
      layoutIds: [],
      load: async () => ({ default: () => null, prerender: true }),
    } as unknown as RouteEntry
    const app = {
      fetch: () => new Response("<p>Zq8mW2vX9pLr4TbN7yKc3HdF</p>", { status: 200 }),
    }
    const message = await failure(() =>
      prerenderRoutes({
        app,
        routes: [route],
        outDir: out,
        secrets: { env: { SESSION_SECRET: "Zq8mW2vX9pLr4TbN7yKc3HdF" } },
      }),
    )
    expect(message).toContain("index.html:1 value of SESSION_SECRET [private-env-value]")
    expect(existsSync(join(out, "index.html"))).toBe(false)
  })
})
