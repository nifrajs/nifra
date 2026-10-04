/** Validate the portable Nifra Agent Plugins package without requiring network access. */

const packageRoot = "plugins/nifra"
const pluginSchema = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json"
const mcpSchema = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json"
const strict = Bun.argv.includes("--strict")
const failures: string[] = []
const warnings: string[] = []

const readJson = async (relativePath: string): Promise<Record<string, unknown>> => {
  const path = `${packageRoot}/${relativePath}`
  try {
    return JSON.parse(await Bun.file(path).text()) as Record<string, unknown>
  } catch (error) {
    failures.push(`${path}: missing or invalid JSON (${String(error)})`)
    return {}
  }
}

const exists = async (relativePath: string): Promise<boolean> =>
  Bun.file(`${packageRoot}/${relativePath}`).exists()

const manifest = await readJson("plugin.json")
const mcp = await readJson("mcp.json")
const openai = (manifest.extensions as Record<string, unknown> | undefined)?.["com.openai"] as
  | Record<string, unknown>
  | undefined
const listing = openai?.interface as Record<string, unknown> | undefined
const review = openai?.review as Record<string, unknown> | undefined
const publication = openai?.publication as Record<string, unknown> | undefined

const requireString = (value: unknown, label: string): string | undefined => {
  if (typeof value !== "string" || value.trim() === "") {
    failures.push(`${label}: expected a non-empty string`)
    return undefined
  }
  return value
}

const requireHttpsUrl = (value: unknown, label: string): void => {
  const text = requireString(value, label)
  if (text === undefined) return
  try {
    const url = new URL(text)
    if (url.protocol !== "https:") failures.push(`${label}: must use HTTPS`)
    if (url.hostname === "example.com") failures.push(`${label}: placeholder domain is not allowed`)
  } catch {
    failures.push(`${label}: invalid URL`)
  }
}

const requireFile = async (relativePath: string, label: string): Promise<void> => {
  if (!(await exists(relativePath)))
    failures.push(`${label}: missing ${packageRoot}/${relativePath}`)
}

requireString(manifest.$schema, "plugin.json $schema")
requireString(manifest.name, "plugin.json name")
requireString(manifest.version, "plugin.json version")
requireString(manifest.description, "plugin.json description")
if (manifest.name !== "nifra") failures.push('plugin.json name must be "nifra"')
if (manifest.$schema !== pluginSchema) failures.push(`plugin.json $schema must be ${pluginSchema}`)
if (manifest.license !== "MIT") failures.push('plugin.json license must be "MIT"')

if (mcp.$schema !== mcpSchema) failures.push(`mcp.json $schema must be ${mcpSchema}`)

if (openai === undefined) failures.push("plugin.json extensions.com.openai is required")
if (listing === undefined) failures.push("plugin.json extensions.com.openai.interface is required")
if (review === undefined) failures.push("plugin.json extensions.com.openai.review is required")

const lengthLimits: Record<string, number> = {
  displayName: 30,
  shortDescription: 30,
  longDescription: 4000,
  developerName: 80,
}
for (const [field, limit] of Object.entries(lengthLimits)) {
  const value = requireString(listing?.[field], `plugin.json interface.${field}`)
  if (value !== undefined && value.length > limit) {
    failures.push(`plugin.json interface.${field}: ${value.length} characters exceeds ${limit}`)
  }
}

for (const field of ["websiteURL", "supportURL", "privacyPolicyURL", "termsOfServiceURL"]) {
  requireHttpsUrl(listing?.[field], `plugin.json interface.${field}`)
}
for (const field of ["logo", "composerIcon"]) {
  const value = requireString(listing?.[field], `plugin.json interface.${field}`)
  if (value !== undefined) {
    if (!value.startsWith("./"))
      failures.push(`plugin.json interface.${field}: path must start with ./`)
    await requireFile(value.slice(2), `plugin.json interface.${field}`)
  }
}

const prompts = listing?.defaultPrompt
if (!Array.isArray(prompts) || prompts.length !== 3) {
  failures.push("plugin.json interface.defaultPrompt: expected exactly three prompts")
} else {
  for (const [index, prompt] of prompts.entries()) {
    if (typeof prompt !== "string" || prompt.trim() === "") {
      failures.push(`plugin.json interface.defaultPrompt[${index}]: expected non-empty text`)
    } else if (prompt.length > 128) {
      failures.push(`plugin.json interface.defaultPrompt[${index}]: exceeds 128 characters`)
    }
  }
}

const mcpServers = mcp.mcpServers as Record<string, unknown> | undefined
if (mcpServers === undefined || Object.keys(mcpServers).length !== 1) {
  failures.push("mcp.json mcpServers: expected exactly one server")
} else {
  const [name = ""] = Object.keys(mcpServers)
  const server = mcpServers[name] as Record<string, unknown> | undefined
  if (name !== "nifra") failures.push('mcp.json server name must be "nifra"')
  if (server?.type !== "streamable-http")
    failures.push('mcp.json nifra.type must be "streamable-http"')
  const endpoint = requireString(server?.url, "mcp.json nifra.url")
  if (endpoint !== undefined) {
    try {
      const url = new URL(endpoint)
      if (url.protocol !== "https:") failures.push("mcp.json nifra.url must use HTTPS")
      if (url.hostname !== "mcp.nifra.dev" || url.pathname !== "/openai") {
        failures.push("mcp.json nifra.url must be https://mcp.nifra.dev/openai")
      }
    } catch {
      failures.push("mcp.json nifra.url: invalid URL")
    }
  }
}

const cases = review?.test_cases as Record<string, unknown> | undefined
const positive = cases?.positive
const negative = cases?.negative
if (!Array.isArray(positive) || positive.length !== 5) {
  failures.push("review.test_cases.positive: expected exactly five cases")
}
if (!Array.isArray(negative) || negative.length !== 3) {
  failures.push("review.test_cases.negative: expected exactly three cases")
}

for (const [kind, values] of [
  ["positive", positive],
  ["negative", negative],
] as const) {
  if (!Array.isArray(values)) continue
  for (const [index, value] of values.entries()) {
    if (typeof value !== "object" || value === null) {
      failures.push(`review.test_cases.${kind}[${index}]: expected an object`)
      continue
    }
    const item = value as Record<string, unknown>
    for (const field of ["description", "prompt", "expected_behavior"]) {
      requireString(item[field], `review.test_cases.${kind}[${index}].${field}`)
    }
    if (kind === "positive")
      requireString(item.tools_triggered, `review.test_cases.positive[${index}].tools_triggered`)
  }
}

const demoUrl = openai?.review && (openai.review as Record<string, unknown>).demo_recording_url
if (demoUrl === undefined) {
  warnings.push(
    "review.demo_recording_url is missing; an accessible walkthrough is required before MCP review",
  )
  if (strict) failures.push("review.demo_recording_url is required in --strict mode")
} else {
  requireHttpsUrl(demoUrl, "review.demo_recording_url")
}

if (publication?.release_notes !== undefined)
  requireString(publication.release_notes, "publication.release_notes")
const serialized = JSON.stringify(manifest)
for (const forbidden of ["test_credentials", "reviewer_instructions", "example.com"]) {
  if (serialized.includes(forbidden))
    failures.push(`plugin.json contains forbidden placeholder or private field: ${forbidden}`)
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`✗ ${failure}`)
  process.exit(1)
}
for (const warning of warnings) console.warn(`⚠ ${warning}`)
console.log(
  `✓ OpenAI plugin package is structurally valid (${String(manifest.version)}; ${strict ? "strict" : "local"} mode)`,
)

export {}
