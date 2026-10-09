import { expect, test } from "bun:test"
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import preact from "@preact/preset-vite"
import { svelte } from "@sveltejs/vite-plugin-svelte"
import vue from "@vitejs/plugin-vue"
import solid from "vite-plugin-solid"
import { devServerComponents } from "../src/server-components/build.ts"
import { componentRequestHeader } from "../src/server-components/protocol.ts"
import { parseComponentState } from "../src/server-components/state.ts"
import type { ComponentState } from "../src/server-components/types.ts"

for (const adapter of ["react", "vue", "svelte", "solid", "preact"] as const) {
  test(`${adapter} development runs the native SSR entry and authorized owner refresh`, async () => {
    const root =
      adapter === "react"
        ? resolve(import.meta.dirname, "../../web-react/test/fixtures/server-components")
        : resolve(import.meta.dirname, "fixtures/server-components", adapter)
    const entries =
      adapter === "react"
        ? { client: "entry.client.ts", ssr: "entry-ssr.backend.ts", rsc: "entry-rsc.backend.tsx" }
        : { client: "entry.client.ts", ssr: "entry.backend.ts" }
    const plugins =
      adapter === "react"
        ? []
        : [
            adapter === "vue"
              ? vue()
              : adapter === "svelte"
                ? svelte()
                : adapter === "preact"
                  ? preact()
                  : solid({ ssr: true }),
          ]
    const server = await devServerComponents({ root, adapter, entries, plugins, port: 0 })
    try {
      const url = server.resolvedUrls!.local[0]!
      const response = await fetch(url)
      expect(response.status).toBe(200)
      const html = await response.text()
      expect(html).toContain("Public title")
      expect(response.headers.get("cache-control")).toContain("no-store")
      const client = await fetch(new URL("/entry.client.ts", url))
      expect(client.status).toBe(200)
      const action = await fetch(url, {
        method: "POST",
        body: new URLSearchParams({ text: "public" }),
      })
      expect(action.status).toBe(200)
      expect(action.headers.get("set-cookie")).toContain("fixture-revision=3")
      expect(await action.text()).toContain("Public title")
      const denied = await fetch(new URL("?deny=yes", url))
      expect(denied.status).toBe(403)
      expect(await denied.text()).not.toContain("Public title")
    } finally {
      await server.close()
    }
  }, 60_000)
}

for (const adapter of ["react", "vue", "svelte", "solid", "preact"] as const) {
  test(`${adapter} hot updates replace all environments and reject earlier component generations`, async () => {
    const source =
      adapter === "react"
        ? resolve(import.meta.dirname, "../../web-react/test/fixtures/server-components")
        : resolve(import.meta.dirname, "fixtures/server-components", adapter)
    const root = await mkdtemp(resolve(source, "..", `.hmr-${adapter}-`))
    await cp(source, root, {
      recursive: true,
      filter: (file) => !file.includes("/node_modules/") && !file.includes("/.vite/"),
    })
    const entries =
      adapter === "react"
        ? { client: "entry.client.ts", ssr: "entry-ssr.backend.ts", rsc: "entry-rsc.backend.tsx" }
        : { client: "entry.client.ts", ssr: "entry.backend.ts" }
    const plugins =
      adapter === "react"
        ? []
        : [
            adapter === "vue"
              ? vue()
              : adapter === "svelte"
                ? svelte()
                : adapter === "preact"
                  ? preact()
                  : solid({ ssr: true }),
          ]
    const server = await devServerComponents({ root, adapter, entries, plugins, port: 0 })
    const stateAt = async (): Promise<ComponentState> => {
      const html = await (
        await fetch(server.resolvedUrls!.local[0]!, { signal: AbortSignal.timeout(5000) })
      ).text()
      const text = /<script id="component-state" type="application\/json">([^<]+)<\/script>/.exec(
        html,
      )?.[1]
      if (text === undefined) throw new Error("Missing hot-update hydration state")
      return parseComponentState(JSON.parse(text))
    }
    try {
      // Copying a new tsconfig can trigger Vite's initial restart after listen returns. Both waits are
      // wide for a loaded machine, and end before the test timeout so a real failure still cleans up.
      const deadline = Date.now() + 20_000
      let before: ComponentState | undefined
      let startupError: unknown
      while (before === undefined && Date.now() < deadline) {
        try {
          before = await stateAt()
        } catch (error) {
          startupError = error
          await new Promise((accept) => setTimeout(accept, 50))
        }
      }
      if (before === undefined) throw startupError ?? new Error("HMR fixture did not become ready")
      const file = resolve(
        root,
        adapter === "react" ? "Summary.component.server.tsx" : "Summary.component.server.ts",
      )
      const original = await readFile(file, "utf8")
      const changed =
        adapter === "react"
          ? original.replace("title: t.string()", "title: t.string({ minLength: 1 })")
          : original.replace(
              "props: summaryProps",
              "props: t.object({ title: t.string({ minLength: 1 }), revision: t.number(), islandKey: t.number() })",
            )
      expect(changed).not.toBe(original)
      await writeFile(file, changed)
      let after = before
      const rebuilt = Date.now() + 25_000
      while (after.build === before.build && Date.now() < rebuilt) {
        await new Promise((accept) => setTimeout(accept, 50))
        try {
          after = await stateAt()
        } catch {
          /* Requests during the bounded full-environment restart retry. */
        }
      }
      expect(after.build).not.toBe(before.build)
      const old = before.records[0]!
      const header = componentRequestHeader({
        v: 1,
        build: before.build,
        reference: old.reference,
        key: old.key,
        parent: old.parent,
        input: old.input,
        generation: 1,
        routeEpoch: 0,
        authEpoch: 0,
      })
      const stale = await fetch(server.resolvedUrls!.local[0]!, {
        headers: { "x-nifra-component": header, "sec-fetch-site": "same-origin" },
      })
      expect(stale.status).toBe(409)
      expect(await stale.text()).toContain("component_version")
    } finally {
      await server.close()
      await rm(root, { recursive: true, force: true })
    }
  }, 60_000)
}
