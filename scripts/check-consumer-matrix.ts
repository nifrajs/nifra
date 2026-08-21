/**
 * Publish-consumer matrix - typecheck selected packages as an external consumer sees them.
 *
 * Monorepo and ordinary fresh-install checks can hide an undeclared dependency by hoisting a sibling's
 * dependency to the workspace/application root. This gate packs the would-be-published artifacts, serves
 * the frozen dependency closure from a loopback-only registry, and installs one target at a time with
 * npm's strict `nested` strategy. A declaration may therefore resolve only the target's declared
 * dependencies (or consumer-provided peers), never a transitive sibling that happened to be hoisted.
 *
 * Run `bun run build` first, then:
 *
 *   bun run check:consumers
 */
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, relative, resolve, sep } from "node:path"
import { $, Glob } from "bun"

const ROOT = resolve(import.meta.dir, "..")
const PACKAGES = join(ROOT, "packages")
const BUN_STORE = join(ROOT, "node_modules", ".bun")
const TSC = join(ROOT, "node_modules", "typescript", "bin", "tsc")
const AGENT_PRODUCT_PACKAGES = [
  "@nifrajs/agent-protocol",
  "@nifrajs/agent-app",
  "@nifrajs/pi",
  "@nifrajs/coding-agent",
  "@nifrajs/workbench",
] as const
const BARE_FRAMEWORK_TARGETS = new Set([
  "@nifrajs/core",
  "@nifrajs/client",
  "@nifrajs/web",
  "@nifrajs/schema",
])

interface Manifest {
  name: string
  version: string
  private?: boolean
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
}

interface Target {
  name: string
  entries: readonly string[]
  consumerDependencies?: Readonly<Record<string, string>>
  typeProbe?: string
  tsconfig?: {
    lib?: readonly string[]
    types?: readonly string[]
  }
}

const TARGETS: readonly Target[] = [
  {
    name: "@nifrajs/agent-protocol",
    entries: ["@nifrajs/agent-protocol"],
    tsconfig: { lib: ["ES2022", "DOM", "DOM.Iterable"] },
  },
  {
    // The presentation SDK is a browser seam: it uses the Web fetch/SSE globals a DOM lib supplies and
    // resolves its only internal dependency (the protocol) transitively from its own declaration.
    name: "@nifrajs/agent-app",
    entries: ["@nifrajs/agent-app"],
    tsconfig: { lib: ["ES2022", "DOM", "DOM.Iterable"] },
  },
  {
    name: "@nifrajs/pi",
    entries: ["@nifrajs/pi"],
    consumerDependencies: {
      "@types/bun": "^1.3.0",
      "@types/node": "^25.0.0",
      "undici-types": "^7.0.0",
    },
    tsconfig: { lib: ["ES2022", "DOM", "DOM.Iterable"], types: ["bun", "node"] },
  },
  {
    name: "@nifrajs/coding-agent",
    entries: [
      "@nifrajs/coding-agent",
      "@nifrajs/coding-agent/extensions",
      "@nifrajs/coding-agent/verification",
      "@nifrajs/coding-agent/rpc",
    ],
    consumerDependencies: {
      "@types/bun": "^1.3.0",
      "@types/node": "^25.0.0",
      "undici-types": "^7.0.0",
    },
    tsconfig: { lib: ["ES2022", "DOM", "DOM.Iterable"], types: ["bun", "node"] },
  },
  { name: "@nifrajs/core", entries: ["@nifrajs/core", "@nifrajs/core/server"] },
  { name: "@nifrajs/client", entries: ["@nifrajs/client"] },
  { name: "@nifrajs/web", entries: ["@nifrajs/web", "@nifrajs/web/client"] },
  {
    name: "@nifrajs/web-react",
    entries: ["@nifrajs/web-react", "@nifrajs/web-react/router"],
    // React publishes runtime declarations through DefinitelyTyped; a TypeScript consumer supplies them.
    consumerDependencies: { "@types/react": "^19.0.0", "@types/react-dom": "^19.0.0" },
    typeProbe: "type RouterSearchProbe = ReturnType<typeof entry1.useSearch>",
  },
  {
    name: "@nifrajs/web-solid",
    entries: ["@nifrajs/web-solid", "@nifrajs/web-solid/router"],
    consumerDependencies: {
      "@types/bun": "^1.3.0",
      "@types/node": "^25.0.0",
      "undici-types": "^7.0.0",
    },
    typeProbe: "type RouterSearchProbe = ReturnType<typeof entry1.useSearch>",
  },
  {
    name: "@nifrajs/web-vue",
    entries: ["@nifrajs/web-vue", "@nifrajs/web-vue/router"],
    consumerDependencies: { "@babel/types": "^7.0.0" },
    typeProbe: "type RouterSearchProbe = ReturnType<typeof entry1.useSearch>",
  },
  {
    name: "@nifrajs/web-preact",
    entries: ["@nifrajs/web-preact", "@nifrajs/web-preact/router"],
    typeProbe: "type RouterSearchProbe = ReturnType<typeof entry1.useSearch>",
  },
  {
    name: "@nifrajs/web-svelte",
    entries: ["@nifrajs/web-svelte", "@nifrajs/web-svelte/router"],
    consumerDependencies: {
      "@types/bun": "^1.3.0",
      "@types/node": "^25.0.0",
      "undici-types": "^7.0.0",
    },
    typeProbe: "type RouterSearchProbe = ReturnType<typeof entry1.useSearch>",
  },
  {
    name: "@nifrajs/node",
    entries: ["@nifrajs/node"],
    consumerDependencies: { "@types/node": "^25.0.0", ws: "^8.21.0" },
    typeProbe: "type RouterSearchProbe = Parameters<typeof entry0.serve>[1]",
    tsconfig: { types: ["node"] },
  },
  {
    name: "@nifrajs/edge",
    entries: ["@nifrajs/edge"],
    typeProbe: "type RouterSearchProbe = Parameters<typeof entry0.server>[0]",
  },
  {
    name: "@nifrajs/aws-lambda",
    entries: ["@nifrajs/aws-lambda"],
    typeProbe: "type RouterSearchProbe = ReturnType<typeof entry0.handle>",
  },
  {
    name: "@nifrajs/proxy",
    entries: ["@nifrajs/proxy", "@nifrajs/proxy/undici"],
    consumerDependencies: { "@types/node": "^25.0.0", undici: "^8.10.0" },
    typeProbe: "type RouterSearchProbe = Parameters<typeof entry0.createProxy>[0]",
    tsconfig: { types: ["node"] },
  },
  {
    name: "@nifrajs/workers",
    entries: ["@nifrajs/workers"],
    consumerDependencies: { "@cloudflare/workers-types": "^5.20260818.1" },
    typeProbe:
      'type RouterSearchProbe = ReturnType<typeof entry0.createWebSocketHub<import("@cloudflare/workers-types").DurableObjectNamespace>>',
    tsconfig: { lib: ["ES2022"], types: ["@cloudflare/workers-types"] },
  },
] as const

/**
 * Public packages without a useful isolated consumer probe yet. Keeping this explicit makes a newly
 * published package fail the matrix until somebody chooses: add a target, or document why this package
 * is proven by another gate / has no library consumer surface.
 */
const SKIPS: Readonly<Record<string, string>> = Object.freeze({
  "@nifrajs/a2a": "A2A protocol adapter; covered by package and conformance tests",
  "@nifrajs/ag-ui": "AG-UI protocol adapter; covered by package and conformance tests",
  "@nifrajs/agent-telemetry":
    "agent-facing telemetry tooling; covered by package tests and corpus gates",
  "@nifrajs/agent": "agent runtime with provider-specific setup; covered by package tests",
  "@nifrajs/auth": "auth integration package; covered by package and contract tests",
  "@nifrajs/better-auth": "Better Auth integration package; covered by package tests",
  "@nifrajs/cache": "storage-backed cache implementations; covered by certification profiles",
  "@nifrajs/cli": "CLI/MCP tooling, not a library consumer seam",
  "@nifrajs/content": "content indexing package; covered by package tests and content benchmarks",
  "create-nifra": "scaffolding executable; covered by the cold-start gate",
  "@nifrajs/cron": "cron scheduling helpers; covered by package tests",
  "@nifrajs/deno": "proven on the real Deno runtime by test:deno and check:deno-tarball",
  "@nifrajs/devtools": "development tooling; covered by package tests",
  "@nifrajs/env": "environment helpers; covered by package tests",
  "@nifrajs/events": "event delivery abstractions; covered by certification profiles",
  "@nifrajs/graphql":
    "GraphQL-over-HTTP and graphql-ws subscription integration; covered by package tests",
  "@nifrajs/i18n": "i18n integration package; covered by package tests",
  "@nifrajs/image": "image helpers; covered by package tests",
  "@nifrajs/island-trigger": "browser build integration; covered by adapter typecheck and build",
  "@nifrajs/islets": "browser build integration; covered by adapter typecheck and build",
  "@nifrajs/jobs": "job-store abstractions; covered by certification profiles",
  "@nifrajs/mcp-db": "MCP database tooling; covered by package tests",
  "@nifrajs/mcp": "MCP server tooling; covered by package tests and corpus gates",
  "@nifrajs/middleware": "middleware package; covered by package and contract tests",
  "@nifrajs/mock": "test-only mock adapter; covered by package tests",
  nifra: "unscoped convenience re-export; publication gate covers its manifest",
  "@nifrajs/otel": "OpenTelemetry integration package; covered by package tests",
  "@nifrajs/prompt": "prompt tooling; covered by package tests and corpus gates",
  "@nifrajs/runner": "development runner; covered by package tests",
  "@nifrajs/schema": "schema package; covered by package and documentation tests",
  "@nifrajs/skills": "agent skill assets; no runtime library consumer seam",
  "@nifrajs/storage": "storage adapter abstractions; covered by certification profiles",
  "@nifrajs/testing": "test helper package; covered by its own contract and certification tests",
  "@nifrajs/ts-plugin": "TypeScript compiler plugin; covered by plugin build and tests",
  "@nifrajs/uploads": "upload helpers; covered by package tests",
  "@nifrajs/web-vanilla":
    "browser adapter with no additional declaration seam beyond build/typecheck",
})

function readManifest(path: string): Manifest {
  return JSON.parse(readFileSync(path, "utf8")) as Manifest
}

function packageInstallPath(root: string, name: string): string {
  return join(root, "node_modules", ...name.split("/"))
}

async function packInto(packageDir: string, destination: string): Promise<string> {
  const before = new Set(readdirSync(destination))
  const result = await $`bun pm pack --destination ${destination}`.cwd(packageDir).nothrow().quiet()
  const packed = readdirSync(destination).find((file) => !before.has(file) && file.endsWith(".tgz"))
  if (result.exitCode !== 0 || packed === undefined) {
    throw new Error(`bun pm pack failed for ${packageDir} (exit ${result.exitCode})`)
  }
  return packed
}

async function packInstalledInto(
  packageDir: string,
  destination: string,
  cache: string,
): Promise<string> {
  const before = new Set(readdirSync(destination))
  const packHere = (dir: string) =>
    $`npm pack --ignore-scripts --pack-destination ${destination} --cache ${cache}`
      .cwd(dir)
      .nothrow()
      .quiet()
  const packedName = () =>
    readdirSync(destination).find((file) => !before.has(file) && file.endsWith(".tgz"))

  // Fast path: pack the installed payload directly. `--ignore-scripts` normally skips the `prepare`/
  // `prepack` scripts a published dependency still carries from its source repo.
  let result = await packHere(packageDir)
  let packed = packedName()

  // Fallback: some CI npm builds run those scripts (`tshy`, `pnpm run build`, `npm run build:main`, …)
  // even under --ignore-scripts - the flag is honoured on a dev machine, which is what made this a
  // Linux-only failure - and the build tools are absent, so the pack dies. The installed payload is
  // already built, so pack a copy with its `scripts` stripped: with no script there is nothing for any
  // npm to run. node_modules is excluded (npm never packs it) so the store's symlinks are not copied.
  if (result.exitCode !== 0 || packed === undefined) {
    const staging = mkdtempSync(join(tmpdir(), "nifra-extpack-"))
    try {
      const copy = join(staging, "package")
      cpSync(packageDir, copy, {
        recursive: true,
        filter: (src) => !relative(packageDir, src).split(sep).includes("node_modules"),
      })
      const manifestPath = join(copy, "package.json")
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>
      delete manifest.scripts
      writeFileSync(manifestPath, JSON.stringify(manifest))
      result = await packHere(copy)
      packed = packedName()
    } finally {
      rmSync(staging, { recursive: true, force: true })
    }
  }

  if (result.exitCode !== 0 || packed === undefined) {
    throw new Error(`npm pack failed for ${packageDir} (exit ${result.exitCode})`)
  }
  return packed
}

const packageByName = new Map<string, { dir: string; manifest: Manifest }>()
for (const entry of readdirSync(PACKAGES, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue
  const dir = join(PACKAGES, entry.name)
  const manifestPath = join(dir, "package.json")
  if (!existsSync(manifestPath)) continue
  const manifest = readManifest(manifestPath)
  if (manifest.private !== true && manifest.name && manifest.version) {
    packageByName.set(manifest.name, { dir, manifest })
  }
}

const targetNames = new Set(TARGETS.map((target) => target.name))
const skipNames = new Set(Object.keys(SKIPS))
const unclassified = [...packageByName.keys()].filter(
  (name) => !targetNames.has(name) && !skipNames.has(name),
)
const staleSkips = [...skipNames].filter(
  (name) => !packageByName.has(name) || targetNames.has(name),
)
if (unclassified.length > 0 || staleSkips.length > 0) {
  if (unclassified.length > 0)
    console.error(`✗ public packages missing from consumer matrix: ${unclassified.join(", ")}`)
  if (staleSkips.length > 0)
    console.error(
      `✗ consumer matrix skips no longer match public packages: ${staleSkips.join(", ")}`,
    )
  process.exit(1)
}

// Pack only the internal dependency closure needed by the matrix. Traversing source manifests decides
// what exists; the later nested install decides what each target is actually allowed to resolve.
const needed = new Set(TARGETS.map(({ name }) => name))
const queue = [...needed]
while (queue.length > 0) {
  const name = queue.pop()
  if (name === undefined) break
  const pkg = packageByName.get(name)
  if (pkg === undefined)
    throw new Error(`consumer matrix target/dependency ${name} has no public package`)
  for (const block of [pkg.manifest.dependencies, pkg.manifest.optionalDependencies]) {
    for (const dependency of Object.keys(block ?? {})) {
      if (!packageByName.has(dependency) || needed.has(dependency)) continue
      needed.add(dependency)
      queue.push(dependency)
    }
  }
}

// External packages are served from the versions installed by the root frozen lockfile. Walking their
// dependency closure lets isolated consumers resolve normally through a registry protocol without any
// public network access or accidental use of a newer release.
const externalNeeded = new Set<string>()
const externalQueue: string[] = []
function enqueueExternal(name: string): void {
  if (packageByName.has(name) || externalNeeded.has(name)) return
  externalNeeded.add(name)
  externalQueue.push(name)
}
function enqueueExternalFrom(manifest: Manifest): void {
  for (const dependency of Object.keys(manifest.dependencies ?? {})) enqueueExternal(dependency)
  for (const dependency of Object.keys(manifest.optionalDependencies ?? {}))
    enqueueExternal(dependency)
  for (const dependency of Object.keys(manifest.peerDependencies ?? {})) {
    if (manifest.peerDependenciesMeta?.[dependency]?.optional !== true) enqueueExternal(dependency)
  }
}
for (const name of needed) {
  const pkg = packageByName.get(name)
  if (pkg !== undefined) enqueueExternalFrom(pkg.manifest)
}
for (const target of TARGETS) {
  for (const dependency of Object.keys(target.consumerDependencies ?? {}))
    enqueueExternal(dependency)
}

type ExternalPackage = { dir: string; manifest: Manifest; filename?: string }
const externalByName = new Map<string, Map<string, ExternalPackage>>()
while (externalQueue.length > 0) {
  const name = externalQueue.pop()
  if (name === undefined) break
  const manifests = await Array.fromAsync(
    new Glob(`*/node_modules/${name}/package.json`).scan(BUN_STORE),
  )
  if (manifests.length === 0) {
    // Optional/platform packages may legitimately be absent from this frozen install. Required packages
    // will fail the isolated install with a precise package name if their absence matters.
    continue
  }
  const versions = new Map<string, ExternalPackage>()
  for (const relativeManifest of manifests) {
    const manifestPath = join(BUN_STORE, relativeManifest)
    const manifest = readManifest(manifestPath)
    if (!versions.has(manifest.version)) {
      versions.set(manifest.version, { dir: resolve(manifestPath, ".."), manifest })
      enqueueExternalFrom(manifest)
    }
  }
  externalByName.set(name, versions)
}

if (!existsSync(TSC)) {
  console.error("✗ TypeScript is not installed; run `bun install` before check:consumers")
  process.exit(1)
}

let failures = 0
const NEGATIVE_TARGET = "@nifrajs/workers"
// This MUST be outside the checkout. A consumer below ROOT can climb to the workspace's hoisted
// node_modules and recreate the false green this gate exists to prevent.
const work = mkdtempSync(join(realpathSync(tmpdir()), "nifra-consumer-matrix-"))
try {
  const originalTarballs = join(work, "packed")
  const negativeTarballs = join(work, "negative")
  const externalTarballs = join(work, "external")
  const npmCache = join(work, "npm-cache")
  await $`mkdir -p ${originalTarballs} ${negativeTarballs} ${externalTarballs} ${npmCache}`.quiet()

  console.log("=== publish-consumer matrix: pack dependency closure ===")
  const filenameByName = new Map<string, string>()
  const packedManifestByName = new Map<string, Manifest>()
  for (const name of [...needed].sort()) {
    const pkg = packageByName.get(name)
    if (pkg === undefined) continue
    try {
      const filename = await packInto(pkg.dir, originalTarballs)
      filenameByName.set(name, filename)
      packedManifestByName.set(
        name,
        JSON.parse(
          await $`tar -xzOf ${join(originalTarballs, filename)} package/package.json`.text(),
        ) as Manifest,
      )
    } catch (error) {
      failures += 1
      console.error(`✗ ${name}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // Build a mutation artifact for the exact bug this gate exists to catch: web-react without its direct
  // core dependency. It keeps web (and therefore web's transitive core) so only a truly isolated consumer
  // fails. The normal matrix must pass; this one mutation must fail at tsc, not install time.
  let negativeAdapterFilename: string | undefined
  const adapterFilename = filenameByName.get(NEGATIVE_TARGET)
  if (adapterFilename !== undefined) {
    const stage = join(work, "negative-stage")
    await $`mkdir -p ${stage}`.quiet()
    const extracted = await $`tar -xzf ${join(originalTarballs, adapterFilename)} -C ${stage}`
      .nothrow()
      .quiet()
    if (extracted.exitCode !== 0) {
      failures += 1
      console.error(`✗ negative control: could not extract ${NEGATIVE_TARGET}`)
    } else {
      const manifestPath = join(stage, "package", "package.json")
      const manifest = readManifest(manifestPath)
      delete manifest.dependencies?.["@nifrajs/core"]
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
      try {
        negativeAdapterFilename = await packInto(join(stage, "package"), negativeTarballs)
      } catch (error) {
        failures += 1
        console.error(
          `✗ negative control: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
  }

  console.log("\n=== publish-consumer matrix: pack frozen external dependency closure ===")
  for (const [name, versions] of [...externalByName].sort(([a], [b]) => a.localeCompare(b))) {
    for (const [version, pkg] of versions) {
      try {
        pkg.filename = await packInstalledInto(pkg.dir, externalTarballs, npmCache)
      } catch (error) {
        failures += 1
        console.error(
          `✗ ${name}@${version}: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
  }

  let registryOrigin = ""
  const registry = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const pathname = new URL(request.url).pathname.slice(1)
      if (pathname.startsWith("tarballs/")) {
        const filename = decodeURIComponent(pathname.slice("tarballs/".length))
        if (!/^[A-Za-z0-9._+-]+\.tgz$/.test(filename)) {
          return new Response("not found", { status: 404 })
        }
        for (const directory of [externalTarballs, originalTarballs]) {
          const file = Bun.file(join(directory, filename))
          if (file.size > 0) {
            return new Response(file, { headers: { "content-type": "application/octet-stream" } })
          }
        }
        return new Response("not found", { status: 404 })
      }
      const name = decodeURIComponent(pathname)
      const internal = packedManifestByName.get(name)
      const internalFilename = filenameByName.get(name)
      if (internal !== undefined && internalFilename !== undefined) {
        const version = internal.version
        return Response.json({
          name,
          "dist-tags": { latest: version },
          versions: {
            [version]: {
              ...internal,
              dist: {
                tarball: `${registryOrigin}/tarballs/${encodeURIComponent(internalFilename)}`,
              },
            },
          },
        })
      }
      const packages = externalByName.get(name)
      if (packages === undefined) return new Response("not found", { status: 404 })
      const versions: Record<string, Manifest & { dist: { tarball: string } }> = {}
      for (const [version, pkg] of packages) {
        if (pkg.filename === undefined) continue
        versions[version] = {
          ...pkg.manifest,
          dist: { tarball: `${registryOrigin}/tarballs/${encodeURIComponent(pkg.filename)}` },
        }
      }
      const latest = Object.keys(versions).sort().at(-1)
      if (latest === undefined) return new Response("not found", { status: 404 })
      return Response.json({
        name,
        "dist-tags": { latest },
        versions,
      })
    },
  })
  registryOrigin = registry.url.origin

  console.log("\n=== publish-consumer matrix: isolated installs + external typecheck ===")
  try {
    for (const target of TARGETS) {
      const packedPkg = packedManifestByName.get(target.name)
      const filename = filenameByName.get(target.name)
      if (packedPkg === undefined || filename === undefined) {
        failures += 1
        console.error(`✗ ${target.name}: no packed artifact`)
        continue
      }

      const consumer = join(
        work,
        "consumers",
        target.name.replaceAll("/", "__").replaceAll("@", ""),
      )
      await $`mkdir -p ${consumer}`.quiet()
      const dependencies: Record<string, string> = {
        [target.name]: `file:${join(originalTarballs, filename)}`,
      }
      // Required peers are the consumer's responsibility. Supply them explicitly at the consumer root;
      // optional peers remain absent, which also proves the package's main declaration surface tolerates it.
      for (const [peer, range] of Object.entries(packedPkg.peerDependencies ?? {})) {
        if (packedPkg.peerDependenciesMeta?.[peer]?.optional === true) continue
        dependencies[peer] = range
      }
      Object.assign(dependencies, target.consumerDependencies)
      writeFileSync(
        join(consumer, "package.json"),
        `${JSON.stringify({ private: true, type: "module", dependencies }, null, 2)}\n`,
      )
      writeFileSync(
        join(consumer, "consumer.ts"),
        `${target.entries.map((entry, index) => `import * as entry${index} from ${JSON.stringify(entry)}`).join("\n")}\n${target.typeProbe === undefined ? "" : `${target.typeProbe}\ndeclare const routerSearchProbe: RouterSearchProbe\nvoid routerSearchProbe\n`}const publicEntries = [${target.entries.map((_, index) => `entry${index}`).join(", ")}]\nvoid publicEntries\n`,
      )
      writeFileSync(
        join(consumer, "tsconfig.json"),
        `${JSON.stringify(
          {
            compilerOptions: {
              lib: target.tsconfig?.lib ?? ["ES2022", "DOM", "DOM.Iterable"],
              module: "NodeNext",
              moduleResolution: "NodeNext",
              noEmit: true,
              skipLibCheck: false,
              strict: true,
              target: "ES2022",
              types: target.tsconfig?.types ?? [],
            },
            include: ["consumer.ts"],
          },
          null,
          2,
        )}\n`,
      )

      const install =
        await $`npm install --install-strategy=nested --ignore-scripts --no-audit --no-fund --package-lock=false --legacy-peer-deps --cache ${npmCache} --registry ${registryOrigin}`
          .cwd(consumer)
          .nothrow()
          .quiet()
      if (install.exitCode !== 0) {
        failures += 1
        console.error(`✗ ${target.name}: nested npm install failed (exit ${install.exitCode})`)
        console.error(install.stderr.toString())
        continue
      }

      const installedTarget = packageInstallPath(consumer, target.name)
      if (BARE_FRAMEWORK_TARGETS.has(target.name)) {
        const unexpected = AGENT_PRODUCT_PACKAGES.filter((name) =>
          existsSync(packageInstallPath(consumer, name)),
        )
        if (unexpected.length > 0) {
          failures += 1
          console.error(
            `✗ ${target.name}: bare consumer unexpectedly includes ${unexpected.join(", ")}`,
          )
          continue
        }
      }
      const declaredInternal = Object.keys(packedPkg.dependencies ?? {}).filter((name) =>
        packageByName.has(name),
      )
      const missingIsolated = declaredInternal.filter(
        (name) => !existsSync(packageInstallPath(installedTarget, name)),
      )
      if (missingIsolated.length > 0) {
        failures += 1
        console.error(`✗ ${target.name}: isolated install is missing ${missingIsolated.join(", ")}`)
        continue
      }

      const typecheck = await $`bun ${TSC} --project tsconfig.json --pretty false`
        .cwd(consumer)
        .nothrow()
        .quiet()
      if (typecheck.exitCode !== 0) {
        failures += 1
        console.error(`✗ ${target.name}: external consumer typecheck failed`)
        console.error(typecheck.stdout.toString())
        console.error(typecheck.stderr.toString())
      } else {
        console.log(
          `✓ ${target.name}: public entry${target.entries.length > 1 ? " + subpath" : ""}`,
        )
        // Install and typecheck the mutation artifact separately. A failure to install is not accepted as
        // proof: the intended signal is the unresolved core/server declaration at the consumer boundary.
        if (target.name === NEGATIVE_TARGET) {
          if (negativeAdapterFilename === undefined) {
            failures += 1
            console.error("✗ negative control: mutated adapter artifact is absent")
          } else {
            const negativeConsumer = `${consumer}-missing-core`
            await $`mkdir -p ${negativeConsumer}`.quiet()
            writeFileSync(
              join(negativeConsumer, "package.json"),
              `${JSON.stringify(
                {
                  private: true,
                  type: "module",
                  dependencies: {
                    ...dependencies,
                    [target.name]: `file:${join(negativeTarballs, negativeAdapterFilename)}`,
                  },
                },
                null,
                2,
              )}\n`,
            )
            writeFileSync(
              join(negativeConsumer, "consumer.ts"),
              readFileSync(join(consumer, "consumer.ts"), "utf8"),
            )
            writeFileSync(
              join(negativeConsumer, "tsconfig.json"),
              readFileSync(join(consumer, "tsconfig.json"), "utf8"),
            )
            const negativeInstall =
              await $`npm install --install-strategy=nested --ignore-scripts --no-audit --no-fund --package-lock=false --legacy-peer-deps --cache ${npmCache} --registry ${registryOrigin}`
                .cwd(negativeConsumer)
                .nothrow()
                .quiet()
            if (negativeInstall.exitCode !== 0) {
              failures += 1
              console.error("✗ negative control: mutated adapter failed to install")
            } else {
              const negativeTypecheck = await $`bun ${TSC} --project tsconfig.json --pretty false`
                .cwd(negativeConsumer)
                .nothrow()
                .quiet()
              const diagnostics =
                negativeTypecheck.stdout.toString() + negativeTypecheck.stderr.toString()
              if (
                negativeTypecheck.exitCode === 0 ||
                !diagnostics.includes("@nifrajs/core/server")
              ) {
                failures += 1
                console.error(
                  `✗ negative control did not report the missing @nifrajs/core declaration${diagnostics === "" ? "" : `:\n${diagnostics}`}`,
                )
              } else {
                console.log(
                  `✓ negative control: omitted direct core fails ${NEGATIVE_TARGET} external typecheck`,
                )
              }
            }
          }
        }
      }
    }
  } finally {
    registry.stop(true)
  }
} finally {
  rmSync(work, { recursive: true, force: true })
}

if (failures > 0) {
  console.error(`\n${failures} publish-consumer matrix check(s) failed`)
  process.exit(1)
}
console.log("\n✓ publish-consumer matrix passes with only declared dependencies visible")
