/**
 * Secret detection for everything a client build publishes: a heuristic net under the zone rules,
 * not a guarantee. The zone rules keep backend code out of the browser; this catches a credential
 * typed straight into browser code, a library carrying one, and a server-only environment value that
 * reached the output some other way (a `define`, a prerendered page, a copied `public/` file).
 *
 * - Source rules run on the browser build's own modules before minification, while names still exist.
 * - Format rules and private-value matching also run on every emitted file, every `public/` file and
 *   every prerendered page and `_data.json`, source maps included.
 *
 * A finding never prints the value it found: only the rule, the location and a redacted preview.
 */
import { readdirSync, readFileSync, statSync } from "node:fs"
import { basename, isAbsolute, join, relative } from "node:path"
import type { ClientModuleGraph } from "../module-graph.ts"
import type { ZoneClassifier } from "../zones.ts"
import { isSensitiveFieldName } from "./output-guard.ts"
import type { ModuleSource } from "./zone-graph.ts"

export type SecretRule =
  /** A PEM private key block. */
  | "private-key"
  /** A URL carrying a password: `postgres://user:password@host`. */
  | "credential-url"
  /** A known secret token format: AWS, Stripe secret keys, GitHub, Slack, OpenAI, Anthropic, ... */
  | "key-format"
  /** A high-entropy string literal assigned to a secret-like name. Source files only. */
  | "assigned-secret"
  /** The value of a non-public build environment variable, raw or URL, base64, JSON or HTML encoded. */
  | "private-env-value"

const RULES: ReadonlySet<string> = new Set<SecretRule>([
  "private-key",
  "credential-url",
  "key-format",
  "assigned-secret",
  "private-env-value",
])

/**
 * One reviewed false positive. It names the rule, where the finding is and why it may ship: there is
 * no exemption by value, so a credential that turns up somewhere else still fails the build.
 */
export interface SecretExemption {
  readonly rule: SecretRule
  /** The finding's file as reported: app-relative for a source or `public/` file, output-relative for
   * an emitted file. */
  readonly file?: string
  /** For `private-env-value`: the variable whose value may ship. */
  readonly env?: string
  readonly reason: string
}

export interface SecretFinding {
  readonly rule: SecretRule
  /** The source module the match came from when it is known, else the published file. */
  readonly file: string
  readonly line: number
  /** The published file the match is in, when {@link file} names the module it came from. */
  readonly via?: string
  /** What matched, never the value: `"AWS access key id"`, `"value of DATABASE_URL (base64)"`. */
  readonly what: string
  /** The first characters and the length, enough to recognize a key without publishing it. */
  readonly preview: string
}

/** A module bundled into a published file. */
export interface SecretOrigin {
  /** As a finding names it: app-relative, or `node_modules/<package>/...`. */
  readonly name: string
  readonly path: string
}

export interface SecretScanFile {
  /** Where the file is, as a finding should name it. */
  readonly name: string
  readonly text: string
  /** A first-party source file: the assigned-secret rule applies. */
  readonly firstParty?: boolean
  /** For an emitted bundle: the modules in it, so a finding names the one a match came from (a
   * content-hashed file name is no place for an exemption). */
  readonly origins?: readonly SecretOrigin[]
}

export interface SecretScanInput {
  /** Source modules the browser build loaded, scanned before minification. */
  readonly sources?: readonly SecretScanFile[]
  /** Files that will be served: emitted bundles, maps, `public/` copies, prerendered pages. */
  readonly artifacts?: readonly SecretScanFile[]
  /** The build environment whose non-public values must not ship (default: none). */
  readonly env?: Readonly<Record<string, string | undefined>>
  /** The public-env prefix (default `"PUBLIC_"`); prefixed variables are public by declaration. */
  readonly publicEnvPrefix?: string
  readonly exemptions?: readonly SecretExemption[]
}

interface Match {
  readonly rule: SecretRule
  readonly index: number
  readonly text: string
  readonly what: string
  /** The environment variable a private-env-value match came from. */
  readonly env?: string
}

interface FormatRule {
  readonly what: string
  readonly pattern: RegExp
}

/** High-precision token formats. Publishable keys (Stripe `pk_`, Google `AIza`, Supabase anon JWTs)
 * are public by design and deliberately absent. */
const KEY_FORMATS: readonly FormatRule[] = [
  { what: "AWS access key id", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { what: "Stripe secret key", pattern: /\b[sr]k_(?:live|test)_[0-9A-Za-z]{16,}/g },
  { what: "Stripe webhook secret", pattern: /\bwhsec_[0-9A-Za-z+/=]{24,}/g },
  {
    what: "GitHub token",
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})/g,
  },
  { what: "Slack token", pattern: /\bxox[abeoprs]-[A-Za-z0-9-]{10,}/g },
  {
    what: "Slack webhook URL",
    pattern: /https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]{16,}/g,
  },
  {
    what: "OpenAI API key",
    pattern:
      /\bsk-(?:(?:proj|svcacct|admin)-[A-Za-z0-9_-]{40,}|[A-Za-z0-9]{20}T3BlbkFJ[A-Za-z0-9]{20})/g,
  },
  { what: "Anthropic API key", pattern: /\bsk-ant-(?:api|admin)\d{2}-[A-Za-z0-9_-]{80,}/g },
  { what: "SendGrid API key", pattern: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/g },
  { what: "Twilio API key", pattern: /\bSK[0-9a-f]{32}\b/g },
  { what: "Mailgun API key", pattern: /\bkey-[0-9a-f]{32}\b/g },
  { what: "npm token", pattern: /\bnpm_[A-Za-z0-9]{36}\b/g },
]

/** A PEM block with a body: a parser's bare `-----BEGIN PRIVATE KEY-----` constant is not a key. */
const PRIVATE_KEY =
  /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----[A-Za-z0-9+/=\s\\]{64,}?-----END/g

const CREDENTIAL_URL =
  /\b[a-z][a-z0-9+.-]{1,20}:\/\/([^\s/?#@:"'`<>\\]{1,64}):([^\s/?#@"'`<>\\]{3,128})@[^\s/?#"'`<>\\]+/gi

const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.(eyJ[A-Za-z0-9_-]{8,})\.[A-Za-z0-9_-]{16,}/g

const PLACEHOLDER =
  /^(?:user(?:name)?|pass(?:word)?|pwd|secret|admin|root|guest|test|demo|example|changeme|change-me|xxx+|\*+|\.\.\.+|my-?password|your-?password|<[^>]*>|\$\{[^}]*\}|\{\{[^}]*\}\}|%[A-Za-z_]+%?)$/i

/** A literal assigned to a name: `apiKey: "..."`, `const secret = '...'`. Template literals with an
 * interpolation are not literals. The lookbehind starts a name only where an identifier starts: a
 * match from inside a long word run backtracks the rest of that run, quadratic in its length. */
const ASSIGNED =
  /(?<![\w$])([A-Za-z_$][\w$]*)["']?\s*(?:[:=]|\?\?=|\|\|=)\s*(?:"([^"\\\r\n]{16,256})"|'([^'\\\r\n]{16,256})'|`([^`\\$\r\n]{16,256})`)/g

const EXTRA_SECRET_NAME =
  /(?:accesskey|signingkey|encryptionkey|masterkey|serviceaccountkey|connectionstring)$/

/** Values that look like keys but are public by design. */
const PUBLIC_VALUE =
  /^(?:AIza[0-9A-Za-z_-]{35}|pk_(?:live|test)_[0-9A-Za-z]+|6L[0-9A-Za-z_-]{38}|G-[A-Z0-9]{6,}|UA-\d+-\d+)$/

/** Shannon entropy in bits per character. */
function entropy(value: string): number {
  const counts = new Map<string, number>()
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1)
  let bits = 0
  for (const count of counts.values()) {
    const p = count / value.length
    bits -= p * Math.log2(p)
  }
  return bits
}

/** Random-looking: long, unbroken, mixed character classes, high entropy. Excludes paths and URLs. */
function looksRandom(value: string, minLength: number): boolean {
  if (value.length < minLength || /\s/.test(value)) return false
  if (/^(?:[/~.]|[A-Za-z]:[\\/])/.test(value) || /^[a-z][a-z0-9+.-]*:\/\//i.test(value))
    return false
  const classes =
    Number(/[a-z]/.test(value)) +
    Number(/[A-Z]/.test(value)) +
    Number(/[0-9]/.test(value)) +
    Number(/[^A-Za-z0-9]/.test(value))
  return classes >= 2 && entropy(value) >= 3.5
}

function jwtRole(payload: string): unknown {
  try {
    const json = atob(payload.replaceAll("-", "+").replaceAll("_", "/"))
    return (JSON.parse(json) as { role?: unknown }).role
  } catch {
    return undefined
  }
}

function formatMatches(text: string): Match[] {
  const matches: Match[] = []
  for (const { what, pattern } of KEY_FORMATS) {
    for (const found of text.matchAll(pattern)) {
      matches.push({ rule: "key-format", index: found.index, text: found[0], what })
    }
  }
  for (const found of text.matchAll(JWT)) {
    // A Supabase-style service key: a JWT whose role bypasses row-level security.
    if (jwtRole(found[1] ?? "") === "service_role") {
      matches.push({
        rule: "key-format",
        index: found.index,
        text: found[0],
        what: "service-role JWT",
      })
    }
  }
  for (const found of text.matchAll(PRIVATE_KEY)) {
    matches.push({ rule: "private-key", index: found.index, text: found[0], what: "private key" })
  }
  for (const found of text.matchAll(CREDENTIAL_URL)) {
    const user = found[1] ?? ""
    const password = found[2] ?? ""
    if (PLACEHOLDER.test(password) || password === user || /[${}<>*]/.test(password)) continue
    matches.push({
      rule: "credential-url",
      index: found.index,
      text: found[0],
      what: "URL with a password",
    })
  }
  return matches
}

function assignedMatches(text: string): Match[] {
  const matches: Match[] = []
  for (const found of text.matchAll(ASSIGNED)) {
    const name = found[1] ?? ""
    if (!isSensitiveFieldName(name) && !EXTRA_SECRET_NAME.test(name.toLowerCase())) continue
    const value = found[2] ?? found[3] ?? found[4] ?? ""
    if (PUBLIC_VALUE.test(value) || PLACEHOLDER.test(value) || !looksRandom(value, 16)) continue
    matches.push({
      rule: "assigned-secret",
      index: found.index + found[0].indexOf(value),
      text: value,
      what: `literal assigned to "${name}"`,
    })
  }
  return matches
}

// Environment variables a shell, an OS or a CI system sets: none is an app secret unless its name
// says so (`GITHUB_TOKEN`, `VERCEL_OIDC_TOKEN`).
const AMBIENT_ENV =
  /^(?:PATH|HOME|PWD|OLDPWD|SHELL|USER|LOGNAME|TMPDIR|TMP|TEMP|LANG|LANGUAGE|EDITOR|VISUAL|PAGER|HOSTNAME|SHLVL|DISPLAY|MANPATH|INFOPATH|COLORTERM|COMMAND_MODE|_|(?:LC|NPM|npm|BUN|NODE|XPC|TERM|__CF|HOMEBREW|SSH|GPG|ITERM|VSCODE|JAVA|ANDROID|CONDA|PYENV|NVM|ZSH|GITHUB|RUNNER|CI|VERCEL|CF_PAGES|NETLIFY|RENDER|RAILWAY|FLY|CLAUDE|CLAUDECODE|GIT|DENO|PNPM|YARN)(?:_.*)?)$/

const SECRET_ENV_TOKENS: ReadonlySet<string> = new Set([
  "SECRET",
  "SECRETS",
  "TOKEN",
  "PASSWORD",
  "PASSWD",
  "PASS",
  "PRIVATE",
  "CREDENTIAL",
  "CREDENTIALS",
  "APIKEY",
  "KEY",
  "DSN",
  "SALT",
  "PEPPER",
  "WEBHOOK",
])
const CONNECTION_ENV =
  /(?:DATABASE|DB|REDIS|MONGO(?:DB)?|POSTGRES(?:QL)?|PG|MYSQL|AMQP|RABBITMQ)_?(?:URL|URI)$|CONNECTION_?STRING/

const secretEnvName = (name: string): boolean =>
  CONNECTION_ENV.test(name.toUpperCase()) ||
  name
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .some((token) => SECRET_ENV_TOKENS.has(token))

function base64Variants(value: string): string[] {
  const bytes = new TextEncoder().encode(value)
  const variants: string[] = []
  // A value inside a larger encoded blob lands at one of three byte alignments. Keep only the
  // characters the value's own bytes determine: none that mix in a neighbour or the padding.
  for (const shift of [0, 1, 2]) {
    const shifted = new Uint8Array(shift + bytes.length)
    shifted.set(bytes, shift)
    let binary = ""
    for (const byte of shifted) binary += String.fromCharCode(byte)
    const encoded = btoa(binary)
    const core = encoded.slice(shift === 0 ? 0 : shift + 1, Math.floor(shifted.length / 3) * 4)
    if (core.length >= 8) {
      variants.push(core)
      const url = core.replaceAll("+", "-").replaceAll("/", "_")
      if (url !== core) variants.push(url)
    }
  }
  return variants
}

interface EnvNeedle {
  readonly env: string
  readonly form: string
  readonly needle: string
}

/** The non-public values a build must not publish, in every encoding a page or bundle carries. */
function envNeedles(
  env: Readonly<Record<string, string | undefined>>,
  prefix: string,
): EnvNeedle[] {
  const publicValues = new Set<string>()
  if (prefix !== "") {
    for (const [name, value] of Object.entries(env)) {
      if (name.startsWith(prefix) && value !== undefined) publicValues.add(value)
    }
  }
  const needles: EnvNeedle[] = []
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || value.length < 8 || (prefix !== "" && name.startsWith(prefix))) {
      continue
    }
    // The same value published under a public name is public by declaration.
    if (publicValues.has(value)) continue
    const named = secretEnvName(name)
    if (!named && AMBIENT_ENV.test(name)) continue
    const credentialUrl = /^[a-z][a-z0-9+.-]*:\/\/[^/@\s]+:[^/@\s]+@/i.test(value)
    if (!named && !credentialUrl && !looksRandom(value, 20)) continue
    const forms: [string, string][] = [["raw", value]]
    const add = (form: string, encoded: string): void => {
      if (encoded !== value && !forms.some(([, existing]) => existing === encoded)) {
        forms.push([form, encoded])
      }
    }
    add("URL-encoded", encodeURIComponent(value))
    add("JSON-escaped", JSON.stringify(value).slice(1, -1))
    add(
      "HTML-escaped",
      value
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;"),
    )
    for (const encoded of base64Variants(value)) add("base64", encoded)
    for (const [form, needle] of forms) needles.push({ env: name, form, needle })
  }
  return needles
}

function envMatches(text: string, needles: readonly EnvNeedle[]): Match[] {
  const matches: Match[] = []
  for (const { env, form, needle } of needles) {
    const index = text.indexOf(needle)
    if (index === -1) continue
    matches.push({
      rule: "private-env-value",
      index,
      text: needle,
      what: `value of ${env}${form === "raw" ? "" : ` (${form})`}`,
      env,
    })
  }
  return matches
}

const lineOf = (text: string, index: number): number => {
  let line = 1
  for (let i = text.indexOf("\n"); i !== -1 && i < index; i = text.indexOf("\n", i + 1)) line++
  return line
}

const preview = (match: Match): string =>
  match.rule === "private-env-value"
    ? `${match.text.length} chars`
    : `${match.text.slice(0, 4)}... (${match.text.length} chars)`

/** Refuse an exemption that does not name its rule, its location and its reason. */
export function assertSecretExemptions(exemptions: readonly SecretExemption[]): void {
  exemptions.forEach((exemption, i) => {
    const where = `secretExemptions[${i}]`
    if (!RULES.has(exemption.rule)) {
      throw new Error(
        `[nifra/web] ${where}.rule must be one of ${[...RULES].join(", ")}; got ${JSON.stringify(exemption.rule)}`,
      )
    }
    if (typeof exemption.reason !== "string" || exemption.reason.trim() === "") {
      throw new Error(`[nifra/web] ${where} needs a reason: why this may reach the browser`)
    }
    const file = typeof exemption.file === "string" && exemption.file !== ""
    const env = typeof exemption.env === "string" && exemption.env !== ""
    if (!file && !(env && exemption.rule === "private-env-value")) {
      throw new Error(
        `[nifra/web] ${where} must name a file${exemption.rule === "private-env-value" ? " or an env variable" : ""}; an exemption covers one location, never a value everywhere`,
      )
    }
  })
}

/**
 * Scan what a build publishes. Sources are scanned first: a match there is reported at its source
 * location, and the same text in an emitted file (where names are hashed) is not reported again,
 * exempted or not.
 */
export function scanForSecrets(input: SecretScanInput): SecretFinding[] {
  const exemptions = input.exemptions ?? []
  assertSecretExemptions(exemptions)
  const needles = envNeedles(input.env ?? {}, input.publicEnvPrefix ?? "PUBLIC_")
  const seen = new Set<string>()
  const findings: SecretFinding[] = []
  const exempt = (file: string, match: Match): boolean =>
    exemptions.some(
      (exemption) =>
        exemption.rule === match.rule &&
        (exemption.file === file || (match.env !== undefined && exemption.env === match.env)),
    )
  const originTexts = new Map<string, string | undefined>()
  const originText = (origin: SecretOrigin): string | undefined => {
    if (!originTexts.has(origin.path)) {
      let text: string | undefined
      try {
        text = readFileSync(origin.path, "utf8")
      } catch {
        text = undefined
      }
      originTexts.set(origin.path, text)
    }
    return originTexts.get(origin.path)
  }
  const scan = (file: SecretScanFile, isSource: boolean): void => {
    const matches = [
      ...formatMatches(file.text),
      ...(isSource && file.firstParty === true ? assignedMatches(file.text) : []),
      ...envMatches(file.text, needles),
    ]
    for (const match of matches) {
      const key = `${match.rule}\0${match.text}`
      if (!isSource && seen.has(key)) continue
      seen.add(key)
      let at = { name: file.name, text: file.text, index: match.index }
      for (const origin of file.origins ?? []) {
        const text = originText(origin)
        const index = text?.indexOf(match.text) ?? -1
        if (text !== undefined && index !== -1) {
          at = { name: origin.name, text, index }
          break
        }
      }
      if (exempt(at.name, match) || (at.name !== file.name && exempt(file.name, match))) continue
      findings.push({
        rule: match.rule,
        file: at.name,
        line: lineOf(at.text, at.index),
        ...(at.name === file.name ? {} : { via: file.name }),
        what: match.what,
        preview: preview(match),
      })
    }
  }
  for (const file of input.sources ?? []) scan(file, true)
  for (const file of input.artifacts ?? []) scan(file, false)
  return findings.sort(
    (a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.rule.localeCompare(b.rule),
  )
}

const AUTH_SCHEME = /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{16,}/g
const CREDENTIAL_HEADER =
  /\b(cookie|set-cookie|authorization|proxy-authorization|x-api-key|api-key)(["']?\s*(?:=>|:|=)\s*["'`]?)[^"'`\r\n,}]{8,}/gi

/**
 * A scrubber for text a dev tool hands to a person or an agent: logs, error messages, stacks,
 * codeframes. Broader than the build scan because a log line is not a published artifact: every JWT
 * (a session token is a credential), an `Authorization`/`Cookie` value, and every non-public env
 * value in each encoding the build scan matches. Each hit becomes `[redacted:<what>]`.
 */
export function createRedactor(
  env: Readonly<Record<string, string | undefined>>,
  publicEnvPrefix = "PUBLIC_",
): (text: string) => string {
  const needles = envNeedles(env, publicEnvPrefix).sort((a, b) => b.needle.length - a.needle.length)
  return (text) => {
    if (text.length < 8) return text
    let out = text
    for (const { env: name, needle } of needles) {
      if (out.includes(needle)) out = out.replaceAll(needle, `[redacted:${name}]`)
    }
    out = out.replace(PRIVATE_KEY, "[redacted:private key]")
    for (const { what, pattern } of KEY_FORMATS) out = out.replace(pattern, `[redacted:${what}]`)
    out = out.replace(JWT, "[redacted:JWT]")
    out = out.replace(CREDENTIAL_URL, (match, user: string, password: string) =>
      PLACEHOLDER.test(password) || password === user
        ? match
        : match.replace(`:${password}@`, ":[redacted]@"),
    )
    out = out.replace(AUTH_SCHEME, "$1 [redacted]")
    return out.replace(CREDENTIAL_HEADER, "$1$2[redacted]")
  }
}

/** The build environment: Bun's, else Node's. */
export const buildEnvironment = (): Readonly<Record<string, string | undefined>> =>
  (typeof Bun !== "undefined" ? Bun.env : undefined) ?? process.env

/** Scan and throw the build-failing message on any finding. */
export function assertNoSecrets(input: SecretScanInput): void {
  const message = formatSecretFindings(scanForSecrets(input))
  if (message !== undefined) throw new Error(message)
}

/** The build-failing message for secret findings, or `undefined` when there are none. */
export function formatSecretFindings(findings: readonly SecretFinding[]): string | undefined {
  if (findings.length === 0) return undefined
  const lines = findings.map(
    (finding) =>
      `  - ${finding.file}:${finding.line}${finding.via === undefined ? "" : ` (in ${finding.via})`} ${finding.what} [${finding.rule}] ${finding.preview}`,
  )
  return [
    "[nifra/web] the build would publish what looks like a credential:",
    ...lines,
    "Keep credentials on the server: read them from the environment in a route's backend half or under",
    "backend/, and rotate any that were committed. A reviewed false positive is exempted in",
    'nifra.config.ts: export const secretExemptions = [{ rule, file, reason: "why it may ship" }].',
  ].join("\n")
}

const INLINE_MAP =
  /\/[/*]# sourceMappingURL=data:application\/json;(?:charset=[^;,]+;)?base64,([A-Za-z0-9+/=]+)/

/** A published file's text, or `undefined` for a binary one (a NUL byte in its first 8 KB). */
export function textOf(bytes: Uint8Array): string | undefined {
  if (bytes.subarray(0, 8192).includes(0)) return undefined
  return new TextDecoder().decode(bytes)
}

/** An emitted bundle, plus its inline source map decoded: base64 would hide a key from every rule. */
export function emittedScanFiles(
  name: string,
  text: string,
  origins?: readonly SecretOrigin[],
): SecretScanFile[] {
  const files: SecretScanFile[] = [{ name, text, ...(origins ? { origins } : {}) }]
  const inline = INLINE_MAP.exec(text)?.[1]
  if (inline !== undefined) {
    try {
      files.push({ name: `${name} (inline source map)`, text: atob(inline) })
    } catch {
      // An unreadable inline map is the output accounting's finding, not this scan's.
    }
  }
  return files
}

/** How a finding names a module: app-relative inside the app, from `node_modules/` for a package. */
export function originName(appRoot: string, file: string): string {
  const rel = relative(appRoot, file).replaceAll("\\", "/")
  if (!rel.startsWith("../") && !isAbsolute(rel)) return rel
  const at = file.replaceAll("\\", "/").lastIndexOf("/node_modules/")
  return at === -1 ? file : file.replaceAll("\\", "/").slice(at + 1)
}

/**
 * The scan's view of a client graph: the first-party browser modules as sources, and for each emitted
 * file (by basename) the modules bundled into it.
 */
export function graphScanInput(
  graph: ClientModuleGraph,
  sourceOf: (id: string) => ModuleSource,
  classifier: ZoneClassifier,
): { sources: SecretScanFile[]; originsOf: (outputName: string) => SecretOrigin[] } {
  const sources: SecretScanFile[] = []
  const fileOf = (id: string): string | undefined => {
    const source = sourceOf(id)
    return source.kind === "file" ? source.file : undefined
  }
  for (const id of Object.keys(graph.modules)) {
    const file = fileOf(id)
    if (file === undefined) continue
    const zone = classifier.classify(file).zone
    if (zone !== "route-frontend" && zone !== "frontend" && zone !== "shared") continue
    let text: string
    try {
      text = readFileSync(file, "utf8")
    } catch {
      continue
    }
    sources.push({ name: originName(classifier.appRoot, file), text, firstParty: true })
  }
  const byOutput = new Map<string, SecretOrigin[]>()
  for (const [output, chunk] of Object.entries(graph.chunks)) {
    const origins = chunk.modules
      .map(fileOf)
      .filter((file): file is string => file !== undefined)
      .map((path) => ({ name: originName(classifier.appRoot, path), path }))
    byOutput.set(basename(output), origins)
  }
  return { sources, originsOf: (outputName) => byOutput.get(basename(outputName)) ?? [] }
}

/** Every file under a `public/` directory, named as the app sees it (`public/robots.txt`). */
export function publicScanFiles(dir: string, label: string): SecretScanFile[] {
  const files: SecretScanFile[] = []
  for (const entry of readdirSync(dir, { recursive: true }) as string[]) {
    const path = join(dir, entry)
    let bytes: Uint8Array
    try {
      if (!statSync(path).isFile()) continue
      bytes = readFileSync(path)
    } catch {
      continue
    }
    const text = textOf(bytes)
    if (text !== undefined) {
      files.push({ name: `${label}/${entry.replaceAll("\\", "/")}`, text })
    }
  }
  return files
}
