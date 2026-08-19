/**
 * Agent-surface manifest gate.
 *
 * The skills bundle is published three ways from one source of truth - as the npm package
 * `@nifrajs/skills`, as a Pi skills directory, and as the Claude Code plugin `nifra` served by the
 * repository-root marketplace. Each surface reads a different manifest, so nothing links them: the
 * plugin version drifted a full major behind the package before this gate existed, and a skill whose
 * frontmatter `name` stops matching its directory is silently unloadable rather than an error.
 *
 * What is asserted here is the seam, not the content: one version across the manifests, one launch
 * config for the MCP server the skills tell the agent to prefer, and loadable frontmatter on every
 * bundled skill. The skill bodies themselves are prose and stay unchecked.
 */

const failures: string[] = []
const read = async (path: string): Promise<Record<string, unknown>> =>
  JSON.parse(await Bun.file(path).text()) as Record<string, unknown>

const PACKAGE_DIR = "packages/skills"
const pkg = await read(`${PACKAGE_DIR}/package.json`)
const plugin = await read(`${PACKAGE_DIR}/.claude-plugin/plugin.json`)
const marketplace = await read(".claude-plugin/marketplace.json")

// One version. The plugin is fetched from the repository tree, so its manifest is the only thing a
// Claude Code install reads - a stale literal there pins users to a bundle that no longer exists.
if (plugin.version !== pkg.version) {
  failures.push(
    `plugin.json version ${String(plugin.version)} != @nifrajs/skills ${String(pkg.version)}`,
  )
}

const entries = Array.isArray(marketplace.plugins) ? marketplace.plugins : []
const entry = entries.find(
  (candidate): candidate is Record<string, unknown> =>
    typeof candidate === "object" &&
    candidate !== null &&
    (candidate as { name?: unknown }).name === plugin.name,
)
if (entry === undefined) {
  failures.push(`marketplace.json has no entry for plugin "${String(plugin.name)}"`)
} else {
  // The marketplace `version` field OVERRIDES plugin.json. An override that must always equal what it
  // overrides is a drift target with no upside, so the entry carries no version at all.
  if ("version" in entry) {
    failures.push("marketplace.json entry pins a version - remove it and let plugin.json own it")
  }
  if (entry.source !== `./${PACKAGE_DIR}`) {
    failures.push(`marketplace.json entry source ${String(entry.source)} != ./${PACKAGE_DIR}`)
  }
}

// The whole design of these skills is "ask the MCP server instead of recalling a signature", so an
// install that does not bring the server up leaves every skill pointing at nothing.
const servers = (plugin.mcpServers ?? {}) as Record<string, { command?: unknown; args?: unknown }>
const nifraServer = servers.nifra
if (nifraServer === undefined) {
  failures.push("plugin.json declares no `nifra` MCP server")
} else {
  const args = Array.isArray(nifraServer.args) ? nifraServer.args.map(String) : []
  if (nifraServer.command !== "bunx" || args.at(-1) !== "mcp") {
    failures.push("plugin.json `nifra` server does not launch `bunx ... mcp`")
  }
  // Deliberately unpinned: a plugin is installed once and opened against many projects, so the CLI has
  // to be whichever one that project resolves. Version skew is reported by the server's own drift note.
  const spec = args.find((arg) => arg.startsWith("@nifrajs/cli"))
  if (spec !== "@nifrajs/cli") {
    failures.push(`plugin.json pins ${String(spec)} - the plugin CLI spec must stay unpinned`)
  }
}

// `files` decides what npm ships; dropping either entry publishes a package with no skills in it.
const files = Array.isArray(pkg.files) ? pkg.files.map(String) : []
for (const required of ["skills", ".claude-plugin"]) {
  if (!files.includes(required)) failures.push(`package.json files is missing "${required}"`)
}

// Frontmatter is what an agent sees before it decides to load a skill. A name that does not match the
// directory, or a missing description, makes the skill unaddressable rather than merely undocumented.
let skillCount = 0
for (const entryPath of new Bun.Glob("*/SKILL.md").scanSync(`${PACKAGE_DIR}/skills`)) {
  skillCount++
  const dir = entryPath.split("/")[0]
  const source = await Bun.file(`${PACKAGE_DIR}/skills/${entryPath}`).text()
  const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(source)?.[1]
  if (frontmatter === undefined) {
    failures.push(`${entryPath}: no YAML frontmatter`)
    continue
  }
  const name = /^name:\s*(\S+)\s*$/m.exec(frontmatter)?.[1]
  const description = /^description:\s*(\S.*)$/m.exec(frontmatter)?.[1]
  if (name !== dir)
    failures.push(`${entryPath}: frontmatter name ${String(name)} != directory ${dir}`)
  if (description === undefined) failures.push(`${entryPath}: frontmatter has no description`)
}
if (skillCount === 0) failures.push(`${PACKAGE_DIR}/skills contains no SKILL.md bundles`)

if (failures.length > 0) {
  for (const failure of failures) console.error(`✗ ${failure}`)
  process.exit(1)
}
console.log(
  `✓ plugin manifest: ${skillCount} skills at v${String(pkg.version)}, MCP server wired, marketplace entry resolves`,
)
