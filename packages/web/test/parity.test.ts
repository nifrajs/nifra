import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  assertDevelopmentProductionParity,
  assertIdentityParity,
  collectDevelopmentParityInput,
  collectIdentityParity,
  formatIdentityParityFindings,
  identityParityBasis,
  identityParityHeadline,
} from "../src/internal/parity.ts"

const devInput = (over: Partial<Parameters<typeof assertDevelopmentProductionParity>[0]> = {}) => ({
  routes: { index: 1 },
  publicFiles: [] as readonly string[],
  css: [] as readonly string[],
  ...over,
})

test("identityParityHeadline pluralizes on the finding count", () => {
  expect(identityParityHeadline(1)).toBe("1 primary package finding")
  expect(identityParityHeadline(2)).toBe("2 primary package findings")
})

// The dev `--allow-duplicate-identity` warning and the hard failure share this formatter, so a change
// to one keeps the same detail (package, cause, versions, resolved paths) in the other.
test("formatIdentityParityFindings renders package, cause, versions and paths", () => {
  const rendered = formatIdentityParityFindings([
    {
      package: "react",
      cause: "duplicate-path",
      copies: [
        { version: "19.2.7", path: "apps/web/node_modules/react", importers: ["apps/web"] },
        { version: "19.2.7", path: "node_modules/react", importers: ["."] },
      ],
      versions: ["19.2.7"],
      explanation: "react is loaded from more than one physical path",
      remediation: "Align dependency ranges and reinstall from the workspace root",
      deduplicated: false,
    },
  ])
  expect(rendered).toContain("- react [duplicate-path]:")
  expect(rendered).toContain("versions: 19.2.7;")
  expect(rendered).toContain("apps/web/node_modules/react")
  expect(rendered).toContain("node_modules/react")
})

test("identity parity does not sweep a sibling repo reached through a store symlink", async () => {
  // The regression: a dependency symlinked into ANOTHER project's package store (bun's `.bun/…`, an
  // `npm link` target) used to be treated as a linked source checkout, so the scan walked up to that
  // project's `.git` and reported its entire unrelated dependency tree as this project's duplicates -
  // permanent findings in a repo the developer is not working in. The store copy itself is still
  // recorded (it is what this project loads); only the walk above it is refused.
  const ground = await mkdtemp(join(tmpdir(), "nifra-parity-store-"))
  try {
    const root = join(ground, "project")
    const other = join(ground, "other")
    const stored = join(other, "node_modules", ".bun", "react@19.2.6", "node_modules", "react")
    await mkdir(join(root, ".git"), { recursive: true })
    await mkdir(join(root, "node_modules", "@nifrajs", "core"), { recursive: true })
    await mkdir(join(other, ".git"), { recursive: true })
    await mkdir(join(other, "node_modules", "@nifrajs", "core"), { recursive: true })
    await mkdir(stored, { recursive: true })
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        name: "project",
        dependencies: { react: "19.2.6", "@nifrajs/core": "2.0.0" },
      }),
    )
    await writeFile(
      join(root, "node_modules", "@nifrajs", "core", "package.json"),
      JSON.stringify({ name: "@nifrajs/core", version: "2.0.0" }),
    )
    await writeFile(
      join(stored, "package.json"),
      JSON.stringify({ name: "react", version: "19.2.6" }),
    )
    // The sibling repo's own stale copy: reachable only by walking ABOVE the store path.
    await writeFile(
      join(other, "node_modules", "@nifrajs", "core", "package.json"),
      JSON.stringify({ name: "@nifrajs/core", version: "1.12.0" }),
    )
    await symlink(stored, join(root, "node_modules", "react"))

    const result = await collectIdentityParity(root)
    expect(result.findings.map((finding) => finding.package)).not.toContain("@nifrajs/core")
    // Only one physical react is reachable, so it is not a duplicate either.
    expect(result.findings).toHaveLength(0)
  } finally {
    await rm(ground, { recursive: true, force: true })
  }
})

test("shared identity parity resolves a workspace from an app subdirectory", async () => {
  const root = await mkdtemp(join(tmpdir(), "nifra-parity-"))
  try {
    const app = join(root, "apps", "web")
    const packageDir = join(root, "packages", "kit")
    await mkdir(join(app, "node_modules", "react"), { recursive: true })
    await mkdir(join(packageDir, "node_modules", "react"), { recursive: true })
    await mkdir(join(root, "node_modules", "react"), { recursive: true })
    await mkdir(join(root, ".git"), { recursive: true })
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ private: true, workspaces: ["apps/*", "packages/*"] }),
    )
    await writeFile(
      join(app, "package.json"),
      JSON.stringify({ name: "web", dependencies: { react: "19.2.7" } }),
    )
    await writeFile(
      join(packageDir, "package.json"),
      JSON.stringify({ name: "kit", dependencies: { react: "19.2.7" } }),
    )
    for (const path of [
      join(app, "node_modules", "react"),
      join(packageDir, "node_modules", "react"),
      join(root, "node_modules", "react"),
    ]) {
      await writeFile(
        join(path, "package.json"),
        JSON.stringify({ name: "react", version: "19.2.7" }),
      )
    }
    const appPackage = JSON.parse(await readFile(join(app, "package.json"), "utf8")) as Record<
      string,
      unknown
    >
    const result = await collectIdentityParity(app, appPackage)
    // The scan is anchored on the workspace that GOVERNS the requested directory, never on the
    // directory itself - that single basis is what stops doctor and the build guard from answering
    // the same question differently.
    expect(result.requestedRoot).toContain(join("apps", "web"))
    expect(result.workspaceRoot).not.toBe(result.requestedRoot)
    expect(result.findings).toHaveLength(1)
    expect(result.findings[0]?.package).toBe("react")
    expect(result.findings[0]?.copies).toHaveLength(3)
    expect(result.findings[0]?.cause).toBe("duplicate-path")
    expect(result.findings[0]?.versions).toEqual(["19.2.7"])
    // Undeclared, so the finding is fatal and its remediation offers both routes out: one physical
    // path, or a declaration nifra can enforce.
    expect(result.findings[0]?.deduplicated).toBe(false)
    expect(result.findings[0]?.remediation).toContain("single physical path")
    expect(result.findings[0]?.remediation).toContain("singleCopy")
    expect(result.deduplicated).toHaveLength(0)
    // Every copy sits under an install root the workspace owns, so one reinstall is the whole fix -
    // and the message has to say that rather than leaving the developer to infer it from paths.
    expect(result.findings[0]?.topology).toContain("3 paths under 3 install roots")
    expect(result.findings[0]?.topology).toContain("all install roots are inside the scanned root")
    expect(identityParityBasis(result)).toContain("the workspace governing")
    // Two of the three copies belong to packages `apps/web` does not import. That is the accepted
    // cost of a workspace-wide gate, and the finding has to say so - otherwise a build failing on a
    // sibling app's node_modules reads as the tool checking the wrong project.
    const scope = result.findings[0]?.scope ?? ""
    expect(scope).toContain("2 of these copies are outside apps/web")
    expect(scope).toContain("fails every build in the workspace")
    expect(scope).toContain("scoping to it would miss the case this check exists for")
    expect(formatIdentityParityFindings(result.findings)).toContain("scope:")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("a scan that hit its limit fails the gate instead of passing as clean", async () => {
  // Enough dependency names to exhaust the link-probe budget before a single one is examined. The
  // scan therefore finds nothing - and "nothing" from a scan that stopped early is not a clean bill:
  // the duplicate this gate exists to catch can be sitting in the part it never reached.
  const root = await mkdtemp(join(tmpdir(), "nifra-parity-truncated-"))
  try {
    const dependencies: Record<string, string> = {}
    for (let i = 0; i < 4_200; i++) dependencies[`pkg-${i}`] = "1.0.0"
    const manifest = { name: "app", version: "1.0.0", dependencies }
    await writeFile(join(root, "package.json"), JSON.stringify(manifest))
    const result = await collectIdentityParity(root, manifest as unknown as Record<string, unknown>)
    expect(result.truncated).toBe(true)
    expect(result.findings).toHaveLength(0)
    // Every reporting surface prints the basis, so the partial scan is visible there too.
    expect(identityParityBasis(result)).toContain("PARTIAL")
    await expect(
      assertIdentityParity(root, manifest as unknown as Record<string, unknown>),
    ).rejects.toThrow(/identity parity inconclusive - scan limit reached/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("development parity counts a Svelte <style> block as css without a css import", async () => {
  const root = await mkdtemp(join(tmpdir(), "nifra-parity-sfc-"))
  try {
    const routesDir = join(root, "routes")
    await mkdir(routesDir, { recursive: true })
    await writeFile(
      join(routesDir, "index.svelte"),
      '<div id="page">hi</div>\n<style>\n  #page { color: #ff3e00; }\n</style>\n',
    )
    const input = collectDevelopmentParityInput(routesDir, false)
    expect(input.css).toEqual(["css:present"])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("development parity reports no css for a style-free route", async () => {
  const root = await mkdtemp(join(tmpdir(), "nifra-parity-nocss-"))
  try {
    const routesDir = join(root, "routes")
    await mkdir(routesDir, { recursive: true })
    await writeFile(
      join(routesDir, "index.tsx"),
      "export default function Index() {\n  return null\n}\n",
    )
    const input = collectDevelopmentParityInput(routesDir, false)
    expect(input.css).toEqual([])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("parity passes when production emits non-JS assets (svg, woff2)", () => {
  expect(() =>
    assertDevelopmentProductionParity(devInput(), {
      entry: "/assets/entry.js",
      assets: [
        "/assets/entry.js",
        "/assets/index-a1b2.js",
        "/assets/logo-c3d4.svg",
        "/assets/font-e5f6.woff2",
      ],
      routes: { index: ["/assets/index-a1b2.js"] },
    }),
  ).not.toThrow()
})

test("parity passes when production ships css the dev scanner missed", () => {
  expect(() =>
    assertDevelopmentProductionParity(devInput({ css: [] }), {
      entry: "/assets/entry.js",
      assets: ["/assets/entry.js", "/assets/index-a1b2.js", "/assets/app-c3d4.css"],
      routes: { index: ["/assets/index-a1b2.js"] },
      css: ["/assets/app-c3d4.css"],
    }),
  ).not.toThrow()
})

test("parity fails when the dev scanner found css but production ships none", () => {
  expect(() =>
    assertDevelopmentProductionParity(devInput({ css: ["css:present"], sourceRoot: "/app/src" }), {
      entry: "/assets/entry.js",
      assets: ["/assets/entry.js", "/assets/index-a1b2.js"],
      routes: { index: ["/assets/index-a1b2.js"] },
    }),
  ).toThrow(/css: production ships \[\(none\)\].*\/app\/src/s)
})

test("a module-graph failure names the symmetric difference, not both full sets", () => {
  expect(() =>
    assertDevelopmentProductionParity(devInput({ routes: { index: 1 } }), {
      entry: "/assets/entry.js",
      assets: ["/assets/entry.js", "/assets/about-a1b2.js"],
      routes: { about: ["/assets/about-a1b2.js"] },
    }),
  ).toThrow(/module-graph:.*only in production=\["about"\]/s)
})

test("development parity reports css for a dynamic import of a stylesheet", async () => {
  const root = await mkdtemp(join(tmpdir(), "nifra-parity-dynimport-"))
  try {
    const routesDir = join(root, "routes")
    await mkdir(routesDir, { recursive: true })
    await writeFile(
      join(routesDir, "index.tsx"),
      'export default async function Index() {\n  await import("./page.css")\n  return null\n}\n',
    )
    expect(collectDevelopmentParityInput(routesDir, false).css).toEqual(["css:present"])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("development parity reports css for a require of a stylesheet", async () => {
  const root = await mkdtemp(join(tmpdir(), "nifra-parity-require-"))
  try {
    const routesDir = join(root, "routes")
    await mkdir(routesDir, { recursive: true })
    await writeFile(
      join(routesDir, "index.tsx"),
      'require("./page.css")\nexport default function Index() {\n  return null\n}\n',
    )
    expect(collectDevelopmentParityInput(routesDir, false).css).toEqual(["css:present"])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("development parity stays silent on a bare package styles subpath (unreachable without a resolver)", async () => {
  const root = await mkdtemp(join(tmpdir(), "nifra-parity-subpath-"))
  try {
    const routesDir = join(root, "routes")
    await mkdir(routesDir, { recursive: true })
    await writeFile(
      join(routesDir, "index.tsx"),
      'import "styles-fixture/styles"\nexport default function Index() {\n  return null\n}\n',
    )
    // The scanner cannot see an `exports` subpath that does not end in a stylesheet extension. That is
    // the passing direction now (dev empty, prod css) - a scanner miss, not a build failure.
    expect(collectDevelopmentParityInput(routesDir, false).css).toEqual([])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("identity remediation is cause-specific (duplicate-path does not just say reinstall)", () => {
  const rendered = formatIdentityParityFindings([
    {
      package: "@nifrajs/core",
      cause: "duplicate-path",
      copies: [
        { version: "2.14.1", path: "node_modules/@nifrajs/core", importers: ["."] },
        {
          version: "2.14.1",
          path: "../server/node_modules/@nifrajs/core",
          importers: ["../server"],
        },
      ],
      versions: ["2.14.1"],
      explanation: "@nifrajs/core is loaded from more than one physical path",
      remediation:
        'Deduplicate so @nifrajs/core resolves to a single physical path, or declare it single-copy: add "nifra": { "singleCopy": ["@nifrajs/core"] } to package.json and preload "@nifrajs/core/single-copy/register" from bunfig.toml.',
      deduplicated: false,
    },
  ])
  expect(rendered).toContain("resolves to a single physical path")
  expect(rendered).toContain("singleCopy")
})

/**
 * A two-repository fixture: an app, and a package it consumes by symlink from a checkout the app's
 * install does not own. Each side has its own react at the same version - the state `link:` produces
 * and no reinstall collapses.
 */
const linkedRepos = async (
  label: string,
  over: { readonly appPackage?: Record<string, unknown>; readonly bunfig?: string } = {},
) => {
  const ground = await mkdtemp(join(tmpdir(), `nifra-single-copy-${label}-`))
  const app = join(ground, "app")
  const sibling = join(ground, "sibling")
  await mkdir(join(app, ".git"), { recursive: true })
  await mkdir(join(app, "node_modules", "react"), { recursive: true })
  await mkdir(join(app, "node_modules", "@example"), { recursive: true })
  await mkdir(join(sibling, ".git"), { recursive: true })
  await mkdir(join(sibling, "node_modules", "react"), { recursive: true })
  await mkdir(join(sibling, "packages", "ui"), { recursive: true })
  await writeFile(
    join(app, "package.json"),
    JSON.stringify({
      name: "app",
      dependencies: { react: "19.2.8", "@example/ui": "link:../sibling/packages/ui" },
      ...over.appPackage,
    }),
  )
  if (over.bunfig !== undefined) await writeFile(join(app, "bunfig.toml"), over.bunfig)
  await writeFile(
    join(sibling, "packages", "ui", "package.json"),
    JSON.stringify({ name: "@example/ui", peerDependencies: { react: ">=19" } }),
  )
  await writeFile(
    join(app, "node_modules", "react", "package.json"),
    JSON.stringify({ name: "react", version: "19.2.8" }),
  )
  await writeFile(
    join(sibling, "node_modules", "react", "package.json"),
    JSON.stringify({ name: "react", version: "19.2.8" }),
  )
  await symlink(join(sibling, "packages", "ui"), join(app, "node_modules", "@example", "ui"))
  return { ground, app, sibling }
}

test("a linked sibling repo's second react is fatal when nothing is declared", async () => {
  const { ground, app } = await linkedRepos("undeclared")
  try {
    const result = await collectIdentityParity(app)
    expect(result.findings.map((finding) => finding.package)).toEqual(["react"])
    expect(result.deduplicated).toHaveLength(0)
    expect(result.singleCopy.declared).toEqual([])
    // The sibling checkout is a SEPARATE install root: reinstalling here cannot collapse it, and a
    // message that only listed two paths left that conclusion to be reverse-engineered.
    const topology = result.findings[0]?.topology ?? ""
    expect(topology).toContain("2 paths under 2 install roots")
    expect(topology).toContain("outside the scanned root")
    expect(topology).toContain("reinstalling here cannot remove it")
    expect(formatIdentityParityFindings(result.findings)).toContain("topology:")
    // The scanned root IS the requested one here, so there is no scope surprise to explain and the
    // note stays off. It appears only where the answer would otherwise look like the wrong project.
    expect(result.findings[0]?.scope).toBeUndefined()
  } finally {
    await rm(ground, { recursive: true, force: true })
  }
})

test("declaring a package single-copy moves its duplicate out of the failing set", async () => {
  const { ground, app } = await linkedRepos("declared", {
    appPackage: { nifra: { singleCopy: ["react", "@nifrajs/*"] } },
    bunfig:
      'preload = ["@nifrajs/core/single-copy/register"]\n[test]\npreload = ["@nifrajs/core/single-copy/register"]\n',
  })
  try {
    const result = await collectIdentityParity(app)
    // The copies are still REPORTED - they exist, and the guarantee now rests on a declaration that a
    // future edit could delete. What changes is that they no longer stop a build.
    expect(result.findings).toHaveLength(0)
    expect(result.deduplicated.map((finding) => finding.package)).toEqual(["react"])
    expect(result.deduplicated[0]?.deduplicated).toBe(true)
    expect(result.singleCopy.registration.run).toBe(true)
    expect(result.singleCopy.registration.test).toBe(true)
    expect(result.deduplicated[0]?.remediation).toContain("enforced")
  } finally {
    await rm(ground, { recursive: true, force: true })
  }
})

test("a declaration without the bunfig preload says which phase is still uncovered", async () => {
  const { ground, app } = await linkedRepos("no-preload", {
    appPackage: { nifra: { singleCopy: true } },
  })
  try {
    const result = await collectIdentityParity(app)
    expect(result.deduplicated).toHaveLength(1)
    expect(result.singleCopy.registration.run).toBe(false)
    // The build injects the resolver itself, so bundled output is fine; `bun test` is not, and the
    // remediation has to name that gap rather than reporting a clean bill of health.
    expect(result.deduplicated[0]?.remediation).toContain("bunfig.toml")
    expect(result.deduplicated[0]?.remediation).toContain("bun test")
  } finally {
    await rm(ground, { recursive: true, force: true })
  }
})

test("a declaration never covers a version skew", async () => {
  const ground = await mkdtemp(join(tmpdir(), "nifra-single-copy-skew-"))
  try {
    const app = join(ground, "app")
    const sibling = join(ground, "sibling")
    await mkdir(join(app, ".git"), { recursive: true })
    await mkdir(join(app, "node_modules", "react"), { recursive: true })
    await mkdir(join(app, "node_modules", "@example"), { recursive: true })
    await mkdir(join(sibling, ".git"), { recursive: true })
    await mkdir(join(sibling, "node_modules", "react"), { recursive: true })
    await mkdir(join(sibling, "packages", "ui"), { recursive: true })
    await writeFile(
      join(app, "package.json"),
      JSON.stringify({
        name: "app",
        dependencies: { react: "19.2.8", "@example/ui": "link:../sibling/packages/ui" },
        nifra: { singleCopy: ["react"] },
      }),
    )
    await writeFile(
      join(sibling, "packages", "ui", "package.json"),
      JSON.stringify({ name: "@example/ui", peerDependencies: { react: ">=19" } }),
    )
    await writeFile(
      join(app, "node_modules", "react", "package.json"),
      JSON.stringify({ name: "react", version: "19.2.8" }),
    )
    await writeFile(
      join(sibling, "node_modules", "react", "package.json"),
      JSON.stringify({ name: "react", version: "19.2.7" }),
    )
    await symlink(join(sibling, "packages", "ui"), join(app, "node_modules", "@example", "ui"))
    const result = await collectIdentityParity(app)
    // Redirecting across versions would serve 19.2.8 to a package that asked for 19.2.7 - a loud
    // install problem turned into a quiet behavioural one. The skew stays fatal.
    expect(result.deduplicated).toHaveLength(0)
    expect(result.findings.map((finding) => finding.cause)).toEqual(["version-skew"])
  } finally {
    await rm(ground, { recursive: true, force: true })
  }
})
