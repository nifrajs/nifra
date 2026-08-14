import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  assertDevelopmentProductionParity,
  collectDevelopmentParityInput,
  collectIdentityParity,
  formatIdentityParityFindings,
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
    },
  ])
  expect(rendered).toContain("- react [duplicate-path]:")
  expect(rendered).toContain("versions: 19.2.7;")
  expect(rendered).toContain("apps/web/node_modules/react")
  expect(rendered).toContain("node_modules/react")
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
    const result = await collectIdentityParity(app, appPackage, { useWorkspaceRoot: true })
    expect(result.findings).toHaveLength(1)
    expect(result.findings[0]?.package).toBe("react")
    expect(result.findings[0]?.copies).toHaveLength(3)
    expect(result.findings[0]?.cause).toBe("duplicate-path")
    expect(result.findings[0]?.versions).toEqual(["19.2.7"])
    expect(result.findings[0]?.remediation).toContain("reinstall")
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
        "Deduplicate so this package resolves to a single physical path. If a copy comes from a linked sibling repo, reinstalling will not collapse it - point one tree's copy at the other's (symlink the duplicate to the linked repo's copy) instead of reinstalling.",
    },
  ])
  expect(rendered).toContain("Deduplicate so this package resolves to a single physical path")
  expect(rendered).toContain("linked sibling repo")
})
