/**
 * Wraps `changeset version` and keeps the two hardcoded CLI version constants in sync.
 * The CLI is tsc-built (reads no package.json at runtime) and mcp-http.ts runs on the edge
 * (no fs), so they hardcode the version. `check:publish` enforces they match — this script
 * ensures the "Version Packages" PR updates them automatically alongside package.json.
 */
import { execSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"

execSync("changeset version", { stdio: "inherit" })

const { version } = JSON.parse(readFileSync("packages/cli/package.json", "utf8")) as {
  version: string
}

const constants: Array<{ file: string; re: RegExp }> = [
  { file: "packages/cli/src/cli.ts", re: /(CLI_VERSION\s*=\s*)"[^"]+"/ },
  { file: "packages/cli/src/mcp-http.ts", re: /(const VERSION\s*=\s*)"[^"]+"/ },
  // The pinned @nifrajs/cli version in the generated .mcp.json launch command.
  { file: "packages/create-nifra/src/agent-files.ts", re: /(MCP_CLI_VERSION\s*=\s*)"[^"]+"/ },
]

for (const { file, re } of constants) {
  const src = readFileSync(file, "utf8")
  writeFileSync(file, src.replace(re, `$1"${version}"`))
  console.log(`✓ ${file} → ${version}`)
}
