import { afterAll, expect, test } from "bun:test"
import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { createDevServer } from "../src/dev.ts"
import { createSsrGraph } from "../src/dev-ssr-graph.ts"

// The bug these pin: on the Bun pipeline the route-level `?v=` query reloads the ROUTE module and
// nothing under it, so a component or helper edit left SSR rendering the code that was on disk when the
// server started while the client, which Bun rebuilds properly, rendered the edit.

const root = `${import.meta.dir}/.tmp-ssr-graph`
afterAll(() => rmSync(root, { recursive: true, force: true }))

/** Write a file and push its mtime forward, so a same-millisecond rewrite still reads as a change. */
let clock = 0
function edit(path: string, contents: string): void {
  writeFileSync(path, contents)
  clock += 1
  const stamp = new Date(Date.now() + clock * 1000)
  utimesSync(path, stamp, stamp)
}

test("an edit below the entry re-evaluates that module and everything importing it", async () => {
  const dir = `${root}/graph`
  mkdirSync(dir, { recursive: true })
  edit(`${dir}/leaf.ts`, `export const leaf = "one"\n`)
  // Extensionless on one hop, explicit on the other. Bun's runtime offers resolver plugins only the
  // second kind, so the extensionless hop is the one that pins the mechanism: the version has to be
  // written into the importer's source, not returned from `onResolve`.
  edit(`${dir}/mid.ts`, `export { leaf } from "./leaf.ts"\n`)
  edit(`${dir}/entry.ts`, `export { leaf } from "./mid"\nexport const literal = "./mid"\n`)

  const graph = createSsrGraph({ root: dir })
  ;(await import("bun")).plugin(graph.plugin)

  // `?q=1` stands in for the route-level query the dev server already appends: the entry itself is
  // re-imported by hand, which is exactly the reach the old mechanism had.
  const first = (await import(`${dir}/entry.ts?q=1`)) as { leaf: string; literal: string }
  expect(first.leaf).toBe("one")
  expect(graph.sweep()).toBe(false) // nothing touched since it was read

  // The edit is two levels down. `mid.ts` did not change, so only an importer bump makes it re-resolve
  // its own dependency - which is the half that was missing.
  edit(`${dir}/leaf.ts`, `export const leaf = "two"\n`)
  expect(graph.sweep()).toBe(true)
  expect(graph.generation()).toBe(1)
  const second = (await import(`${dir}/entry.ts?q=2`)) as { leaf: string; literal: string }
  expect(second.leaf).toBe("two")
  // A string that merely looks like a specifier is left alone: only what the transpiler reported as an
  // import is re-keyed.
  expect(second.literal).toBe("./mid")

  // An untouched tree bumps nothing, so a module nobody edited keeps its identity (and its module-scope
  // state) instead of being forked on every request.
  expect(graph.sweep()).toBe(false)
  expect(graph.generation()).toBe(1)
  graph.dispose()
})

test("a dev-server page render picks up a component edit without a restart", async () => {
  const dir = `${root}/live`
  const routesDir = `${dir}/routes`
  mkdirSync(routesDir, { recursive: true })
  mkdirSync(`${dir}/components`, { recursive: true })
  edit(`${dir}/components/label.ts`, `export const label = "alpha"\n`)
  // Extensionless throughout - the style the framework's own examples and templates are written in.
  edit(
    `${dir}/components/panel.ts`,
    `import { label } from "./label"\nexport const panel = () => \`[\${label}]\`\n`,
  )
  edit(
    `${routesDir}/index.tsx`,
    `import { panel } from "../components/panel"\n` +
      `export const body = () => panel()\n` +
      `export default function Index() { return null }\n`,
  )
  // The dev server's client entry imports the adapter by specifier; a local stand-in keeps this test off
  // any framework package while still satisfying the `mountRouter` contract the entry checks.
  edit(`${dir}/client.ts`, `export function mountRouter() {}\n`)

  const server = await createDevServer({
    routesDir,
    outDir: `${dir}/dist`,
    clientModule: `${dir}/client.ts`,
    port: 0,
    publicDir: false,
    // The leak guard is a background full `Bun.build`; it proves nothing here and only adds noise.
    guardLeaks: false,
    createApp: async (_clientEntry, importQuery) => {
      const mod = (await import(`${routesDir}/index.tsx?${importQuery}`)) as { body: () => string }
      return {
        fetch: () =>
          new Response(`<!doctype html><html><body>${mod.body()}</body></html>`, {
            headers: { "content-type": "text/html" },
          }),
      }
    },
  })
  try {
    const read = async (): Promise<string> =>
      await (await fetch(`http://127.0.0.1:${server.port}/`)).text()
    expect(await read()).toContain("[alpha]")

    // Two levels below the route, which is where the old mechanism stopped.
    edit(`${dir}/components/label.ts`, `export const label = "omega"\n`)
    expect(await read()).toContain("[omega]")
  } finally {
    server.stop()
  }
})
