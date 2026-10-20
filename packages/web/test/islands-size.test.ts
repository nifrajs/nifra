import { expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { gzipSync } from "bun"

const ISLANDS = JSON.stringify(fileURLToPath(new URL("../src/islands.ts", import.meta.url)))
const SWAP = JSON.stringify(fileURLToPath(new URL("../src/islands-swap.ts", import.meta.url)))

// Bundling the bare entry measures nothing (tree-shaking drops unused exports), so each fixture is a
// realistic island module for one way of writing islands, and every one pays for the bus.
const BUS = `const bus = createIslandBus(); bus.on("x", (v) => console.log(v)); bus.emit("x", 1)\n`
const MARKUP = `const compare = bindIsland(({ state, root, onDispose }) => {
  const count = state("count", 0)
  const open = state("open", false)
  const query = state("query", "")
  const label = computed(() => \`\${count()} selected\`)
  effect(() => console.log(label(), root))
  onDispose(() => console.log("bye"))
  return {
    add: () => batch(() => { count.set((n) => n + 1); open.set(true) }),
    toggle: () => open.set((v) => !v),
    search: () => query.set(String(query())),
  }
})
console.log(islandProps({ seeded: signal(1)() }))
`
const JS = `const todos = defineIsland((el, props) => {
  const items = signal(props.items)
  const filter = signal("")
  const shown = computed(() => items().filter((t) => t.title.includes(filter())))
  const count = computed(() => shown().length)
  const user = resource(filter, (f, abort) => fetch("/me?f=" + f, { signal: abort }).then((r) => r.json()))
  const out = el.querySelector("output"), p = el.querySelector("p")
  effect(() => { out.textContent = String(count()) })
  bindList(shown, el.querySelector("ul"), {
    key: (t) => t.id,
    create: (t) => { const li = document.createElement("li"); li.textContent = t.title; return li },
    update: (li, t) => { li.textContent = t.title },
  })
  effect(() => { const s = user(); p.textContent = s.status === "ready" ? s.value.name : s.status === "error" ? "failed" : "..." })
  const input = el.querySelector("input")
  const onInput = () => filter.set(input.value)
  input.addEventListener("input", onInput)
  return () => input.removeEventListener("input", onInput)
})
`
const IMPERATIVE = `const counter = defineIsland((el, props) => {
  let n = props.start
  const out = el.querySelector("output")
  const onClick = () => { out.textContent = String(++n) }
  el.addEventListener("click", onClick)
  return () => el.removeEventListener("click", onClick)
})
`
const ALL =
  "batch, bindIsland, bindList, computed, createIslandBus, defineIsland, effect, islandProps, mountIslands, resource, signal"

// Measured on Bun 1.4.3 + 2%. Raise a cap only in the commit that explains the new bytes.
const fixtures = {
  imperative: { budget: 1140, source: `${IMPERATIVE}mountIslands({ counter })` },
  markup: { budget: 2672, source: `${MARKUP}mountIslands({ compare })` },
  js: { budget: 2410, source: `${JS}mountIslands({ todos })` },
  everything: { budget: 3498, source: `${MARKUP}${JS}mountIslands({ compare, todos })` },
  // `@nifrajs/web/islands/swap` in place of `mountIslands`: what a page pays for slot swaps.
  swap: {
    budget: 2935,
    source: `import { enableSwap } from ${SWAP}\n${IMPERATIVE}enableSwap({ counter })`,
  },
}

for (const [name, { budget, source }] of Object.entries(fixtures)) {
  test(`${name} islands bundle stays within ${budget} B gz`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "islands-size-"))
    const entry = join(dir, "entry.js")
    writeFileSync(entry, `import { ${ALL} } from ${ISLANDS}\n${BUS}${source}`)
    try {
      const built = await Bun.build({ entrypoints: [entry], target: "browser", minify: true })
      expect(built.success).toBe(true)
      let src = ""
      for (const o of built.outputs) src += await o.text()
      const gz = gzipSync(Buffer.from(src)).length
      console.log(`@nifrajs/web/islands ${name}: ${src.length} B min, ${gz} B gz`)
      expect(gz).toBeLessThanOrEqual(budget)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
}
