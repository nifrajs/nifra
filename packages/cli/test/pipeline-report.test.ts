import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describePipeline } from "../src/pipeline-guard.ts"
import { collectPipelineReport } from "../src/pipeline-report.ts"

/** Write a throwaway app whose files are `name -> source`, run the reader over it, clean up. */
async function report(files: Record<string, string>) {
  const dir = await mkdtemp(join(tmpdir(), "nifra-pipeline-"))
  try {
    for (const [name, source] of Object.entries(files)) await writeFile(join(dir, name), source)
    return await collectPipelineReport(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

describe("which pipeline the config says it is on", () => {
  test("a config with no plugins is the plain Bun default", async () => {
    const r = await report({
      "nifra.config.ts": `import { reactAdapter } from "@nifrajs/web-react"\nexport const adapter = reactAdapter\n`,
    })
    expect(r.ran).toBe(true)
    expect(r.pipeline).toBe("bun")
    expect(r.certain).toBe(true)
    expect(r.reason).toContain("no transforms")
    expect(r.findings).toEqual([])
  })

  test("vitePlugins as the only transforms selects Vite, matching chooseBuildPipeline", async () => {
    const r = await report({
      "nifra.config.ts": `import { svelte } from "@sveltejs/vite-plugin-svelte"\nexport const vitePlugins = [svelte()]\n`,
    })
    expect(r.pipeline).toBe("vite")
    expect(r.reason).toContain("Bun build cannot run")
  })

  test("a Bun slot keeps both phases on Bun even alongside vitePlugins", async () => {
    const r = await report({
      "nifra.config.ts": `import { vueBunPlugin } from "@nifrajs/web-vue/plugin"
export const clientPlugins = [vueBunPlugin()]
export const vitePlugins = []
`,
    })
    expect(r.pipeline).toBe("bun")
    expect(r.reason).toContain("declares Bun plugins")
  })

  test("an empty array reads as absent, exactly as it behaves at runtime", async () => {
    const r = await report({ "nifra.config.ts": `export const vitePlugins = []\n` })
    expect(r.pipeline).toBe("bun")
    expect(r.certain).toBe(true)
  })

  test("a thunk cannot be read from source, so the answer is withheld rather than guessed", async () => {
    const r = await report({
      "nifra.config.ts": `export const vitePlugins = () => [svelte()]\n`,
    })
    expect(r.pipeline).toBe("unknown")
    expect(r.certain).toBe(false)
    expect(r.reason).toContain("loading it")
  })

  test("a re-exported slot is present-but-unreadable, not absent", async () => {
    const r = await report({
      "nifra.config.ts": `export { vitePlugins } from "./plugins.ts"\n`,
    })
    expect(r.pipeline).toBe("unknown")
    expect(r.certain).toBe(false)
  })

  test("`export *` could carry a slot, so it also withholds the answer", async () => {
    const r = await report({ "nifra.config.ts": `export * from "./plugins.ts"\n` })
    expect(r.certain).toBe(false)
  })

  test("framework.ts is read when there is no nifra.config.ts", async () => {
    const r = await report({
      "framework.ts": `import { reactAdapter } from "@nifrajs/web-react"\nexport const adapter = reactAdapter\n`,
    })
    expect(r.ran).toBe(true)
    expect(r.configFile).toBe("framework.ts")
  })

  test("a directory that is not a nifra app reports nothing rather than throwing", async () => {
    const r = await report({})
    expect(r.ran).toBe(false)
    expect(r.findings).toEqual([])
  })
})

describe("plugin-slot: a plugin the other bundler will never call", () => {
  test("a Vite plugin sitting in clientPlugins is an error", async () => {
    const r = await report({
      "nifra.config.ts": `import svgr from "vite-plugin-svgr"\nexport const clientPlugins = [svgr()]\n`,
    })
    const f = r.findings.find((x) => x.rule === "plugin-slot")
    expect(f?.severity).toBe("error")
    expect(f?.message).toContain("clientPlugins")
    expect(f?.message).toContain("silently does not run")
    expect(f?.fix).toContain("vitePlugins")
    expect(f?.line).toBe(2)
  })

  test("a Bun plugin sitting in vitePlugins is an error", async () => {
    const r = await report({
      "nifra.config.ts": `import { vueBunPlugin } from "@nifrajs/web-vue/plugin"\nexport const vitePlugins = [vueBunPlugin()]\n`,
    })
    const f = r.findings.find((x) => x.rule === "plugin-slot")
    expect(f?.severity).toBe("error")
    expect(f?.fix).toContain("clientPlugins")
  })

  test("correctly placed plugins produce no slot finding", async () => {
    const r = await report({
      "nifra.config.ts": `import { svelte } from "@sveltejs/vite-plugin-svelte"
import { vueBunPlugin } from "@nifrajs/web-vue/plugin"
export const vitePlugins = [svelte()]
export const serverPlugins = [vueBunPlugin()]
`,
    })
    expect(r.findings.filter((f) => f.rule === "plugin-slot")).toEqual([])
  })

  test("a plugin whose origin says nothing is left alone, not guessed at", async () => {
    const r = await report({
      "nifra.config.ts": `import { thing } from "./local-plugin.ts"\nexport const vitePlugins = [thing()]\n`,
    })
    expect(r.findings.filter((f) => f.rule === "plugin-slot")).toEqual([])
  })

  test("a commented-out plugin is not a finding", async () => {
    const r = await report({
      "nifra.config.ts": `import svgr from "vite-plugin-svgr"
export const clientPlugins = [
  // svgr(),
]
`,
    })
    expect(r.findings.filter((f) => f.rule === "plugin-slot")).toEqual([])
  })
})

describe("adapter-entry: the dev toolchain bundled into the production server", () => {
  test("a Vite plugin imported by framework.ts is an error", async () => {
    const r = await report({
      "framework.ts": `import { svelte } from "@sveltejs/vite-plugin-svelte"
import { svelteAdapter } from "@nifrajs/web-svelte"
export const adapter = svelteAdapter
export const vitePlugins = [svelte()]
`,
      "nifra.config.ts": `export { adapter, vitePlugins } from "./framework.ts"\n`,
    })
    const f = r.findings.find((x) => x.rule === "adapter-entry")
    expect(f?.severity).toBe("error")
    expect(f?.file).toBe("framework.ts")
    expect(f?.message).toContain("fails at startup")
    expect(f?.fix).toContain("nifra.config.ts")
  })

  test("the split config is clean: the toolchain stays where only the CLI imports it", async () => {
    const r = await report({
      "framework.ts": `import { svelteAdapter } from "@nifrajs/web-svelte"\nexport const adapter = svelteAdapter\n`,
      "nifra.config.ts": `import { svelte } from "@sveltejs/vite-plugin-svelte"
export { adapter } from "./framework.ts"
export const vitePlugins = [svelte()]
`,
    })
    expect(r.adapterEntry).toBe("framework.ts")
    expect(r.findings.filter((f) => f.rule === "adapter-entry")).toEqual([])
  })

  test("with no framework.ts the config itself is the entry, and its imports ship", async () => {
    const r = await report({
      "nifra.config.ts": `import { svelte } from "@sveltejs/vite-plugin-svelte"
import { svelteAdapter } from "@nifrajs/web-svelte"
export const adapter = svelteAdapter
export const vitePlugins = [svelte()]
`,
    })
    const f = r.findings.find((x) => x.rule === "adapter-entry")
    expect(f?.file).toBe("nifra.config.ts")
    expect(f?.fix).toContain("framework.ts")
  })

  test("a type-only toolchain import costs nothing at runtime and is not reported", async () => {
    const r = await report({
      "framework.ts": `import type { Plugin } from "vite"
import { svelteAdapter } from "@nifrajs/web-svelte"
export const adapter = svelteAdapter
export type P = Plugin
`,
    })
    expect(r.findings.filter((f) => f.rule === "adapter-entry")).toEqual([])
  })
})

describe("bun-client-conditions", () => {
  test("conditions on the Bun pipeline warn, because the client bundle cannot take them", async () => {
    const r = await report({
      "nifra.config.ts": `export const conditions = ["solid"]\n`,
    })
    const f = r.findings.find((x) => x.rule === "bun-client-conditions")
    expect(f?.severity).toBe("warning")
    expect(f?.fix).toContain("--vite")
  })

  test("an empty conditions array is nothing to warn about", async () => {
    const r = await report({ "nifra.config.ts": `export const conditions = []\n` })
    expect(r.findings.filter((f) => f.rule === "bun-client-conditions")).toEqual([])
  })

  test("on the Vite pipeline conditions resolve as production does, so no warning", async () => {
    const r = await report({
      "nifra.config.ts": `import { svelte } from "@sveltejs/vite-plugin-svelte"
export const conditions = ["browser"]
export const vitePlugins = [svelte()]
`,
    })
    expect(r.pipeline).toBe("vite")
    expect(r.findings.filter((f) => f.rule === "bun-client-conditions")).toEqual([])
  })
})

describe("describePipeline - the line dev and build print", () => {
  test("the default names the flag that switches away from it", () => {
    expect(describePipeline({ pipeline: "bun", why: "default" })).toBe(
      "bundler: bun (default; --vite to switch)",
    )
  })

  test("an auto-selected pipeline states the config reason, never looking like the default", () => {
    const line = describePipeline({
      pipeline: "vite",
      why: "auto",
      reason: "auto: this app's only transforms are `vitePlugins` (svelte)",
    })
    expect(line).toStartWith("bundler: vite (auto:")
    expect(line).toContain("svelte")
  })

  test("a forced pipeline says which flag forced it", () => {
    expect(describePipeline({ pipeline: "vite", why: "forced" })).toBe(
      "bundler: vite (forced by --vite)",
    )
  })
})
