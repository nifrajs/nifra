import { afterEach, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  inlineSourceMap,
  originalPosition,
  ssrSourceMaps,
} from "../../web/src/internal/source-map.ts"
import { svelteBunPlugin } from "../src/plugin.ts"

/**
 * In a dev server a compiled `.svelte` module carries its compile map: inline for the browser bundle,
 * registered for SSR (Bun's runtime ignores a plugin's inline map). Without it a stack names a line of
 * the compiled output, and the error's codeframe shows the wrong line of the component.
 */

type LoadCb = (args: { path: string }) => Promise<{ contents: string }> | { contents: string }

const compile = async (path: string, generate: "dom" | "ssr"): Promise<string> => {
  let load: LoadCb | undefined
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: a partial builder; setup calls only onLoad and onResolve.
  svelteBunPlugin(generate).setup({
    onLoad: (opts: { namespace?: string }, cb: LoadCb) => {
      if (opts.namespace === undefined) load = cb
    },
    onResolve: () => undefined,
  } as never)
  if (load === undefined) throw new Error("the plugin registered no loader")
  return (await load({ path })).contents
}

const dir = mkdtempSync(join(tmpdir(), "nifra-svelte-map-"))
const SOURCE = [
  '<script lang="ts">',
  "  function add() {",
  '    const saved = JSON.parse(localStorage.getItem("cart") ?? "{}")',
  '    saved.items.push("sku-1")',
  "  }",
  "</script>",
  "",
  "<button onclick={add}>Add</button>",
  "<style>button { color: red }</style>",
  "",
].join("\n")

/** The 1-based position of `needle` in `code`. */
const at = (code: string, needle: string): { line: number; column: number } => {
  const lines = code.split("\n")
  const line = lines.findIndex((text) => text.includes(needle))
  return { line: line + 1, column: (lines[line]?.indexOf(needle) ?? 0) + 1 }
}

afterEach(() => {
  delete process.env.NIFRA_DEV_HMR
})

test("a dev client compile carries a map from the compiled line back to the authored one", async () => {
  const path = join(dir, "cart.svelte")
  await Bun.write(path, SOURCE)
  process.env.NIFRA_DEV_HMR = "1"
  const code = await compile(path, "dom")
  const map = inlineSourceMap(code)
  if (map === undefined) throw new Error("expected an inline map")
  const compiled = at(code, "saved.items.push")
  expect(originalPosition(map, compiled.line, compiled.column)?.line).toBe(4)
})

test("a dev SSR compile registers its map; a production compile carries none", async () => {
  const path = join(dir, "settings.svelte")
  await Bun.write(path, SOURCE)
  process.env.NIFRA_DEV_HMR = "1"
  const code = await compile(path, "ssr")
  const map = ssrSourceMaps().get(path.replaceAll("\\", "/"))
  if (map === undefined) throw new Error("expected a registered map")
  const compiled = at(code, "saved.items.push")
  expect(originalPosition(map, compiled.line, compiled.column)?.line).toBe(4)
  ssrSourceMaps().delete(path.replaceAll("\\", "/"))

  delete process.env.NIFRA_DEV_HMR
  expect(inlineSourceMap(await compile(path, "dom"))).toBeUndefined()
  await compile(path, "ssr")
  expect(ssrSourceMaps().has(path.replaceAll("\\", "/"))).toBe(false)
})
