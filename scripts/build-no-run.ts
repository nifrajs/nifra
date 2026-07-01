import { spawn } from "node:child_process"
import { readFile } from "node:fs/promises"
import { join } from "node:path"

const GROUPS = [
  ["core"],
  [
    "client",
    "cache",
    "testing",
    "schema",
    "middleware",
    "auth",
    "better-auth",
    "i18n",
    "image",
    "uploads",
    "storage",
    "node",
    "runner",
    "env",
    "cron",
    "jobs",
    "otel",
    "web",
    "cli",
    "create-nifra",
    "nifra",
  ],
  ["web-solid", "web-react", "web-vue", "web-preact", "web-svelte", "web-vanilla", "islets"],
]

interface PackageJson {
  readonly name?: string
  readonly scripts?: {
    readonly build?: string
  }
}

function runCmd(cmd: string, cwd: string): Promise<void> {
  const env = { ...process.env }
  const binPath = join(process.cwd(), "node_modules", ".bin")
  env.PATH = `${binPath}:${env.PATH}`
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, { shell: true, cwd, stdio: "inherit", env })
    p.on("close", (code) => {
      if (code === 0) resolve()
      else reject(new Error(`Command failed with exit code ${code}: ${cmd}`))
    })
  })
}

console.log("Starting custom monorepo build...")

for (const group of GROUPS) {
  await Promise.all(
    group.map(async (lib) => {
      const libPath = join(process.cwd(), "packages", lib)
      const pkgJsonPath = join(libPath, "package.json")
      const pkg = JSON.parse(await readFile(pkgJsonPath, "utf8")) as PackageJson
      let buildScript = pkg.scripts?.build
      if (typeof buildScript !== "string" || buildScript.trim() === "") {
        throw new Error(`${pkgJsonPath} is missing a build script`)
      }
      // Bypass the Bun CouldntReadCurrentDirectory bug by converting this repo-local helper call to
      // a direct Bun invocation inside each package.
      buildScript = buildScript.replace(
        "bun run ../../scripts/fix-dts.ts",
        "bun ../../scripts/fix-dts.ts",
      )
      console.log(`Building ${pkg.name ?? lib}...`)
      await runCmd(buildScript, libPath)
    }),
  )
}

console.log("All packages built successfully!")
