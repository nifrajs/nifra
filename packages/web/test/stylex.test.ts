import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { buildClient, buildServer } from "../src/build.ts"
import { buildClientVite } from "../src/build-vite.ts"
import { stylexBunPlugin, stylexVitePlugin } from "../src/plugins/stylex.ts"

const TMP_BASE = `${import.meta.dir}/.tmp-stylex-`
const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs.length = 0
})

function scaffold(): { root: string; routes: string; client: string; server: string } {
  const root = mkdtempSync(TMP_BASE)
  dirs.push(root)
  const routes = join(root, "routes")
  mkdirSync(routes, { recursive: true })
  writeFileSync(
    join(routes, "index.tsx"),
    [
      'import * as stylex from "@stylexjs/stylex"',
      'import React from "react"',
      "",
      "const styles = stylex.create({",
      "  card: {",
      '    display: "flex",',
      "    padding: 16,",
      '    color: "red",',
      '    ":hover": { color: "blue" },',
      '    "@media (min-width: 640px)": { padding: 24 },',
      "  },",
      "})",
      "",
      "export default function Home() {",
      "  return <div {...stylex.props(styles.card)}>StyleX</div>",
      "}",
      "",
    ].join("\n"),
  )
  const client = join(root, "client.ts")
  const server = join(root, "server.ts")
  writeFileSync(client, "export function mountRouter() {}\n")
  writeFileSync(
    server,
    [
      'import { manifest, clientEntry } from "./server-manifest"',
      "export default { manifest, clientEntry }",
      "",
    ].join("\n"),
  )
  return { root, routes, client, server }
}

const bundleText = (directory: string): string =>
  readdirSync(directory)
    .filter((file) => file.endsWith(".js"))
    .map((file) => readFileSync(join(directory, file), "utf8"))
    .join("\n")

const cssText = (directory: string): string =>
  readdirSync(directory)
    .filter((file) => file.endsWith(".css"))
    .map((file) => readFileSync(join(directory, file), "utf8"))
    .join("\n")

test("Bun StyleX plugin emits aggregate CSS and preserves the SSR fallback", async () => {
  const fixture = scaffold()
  const clientOut = join(fixture.root, "client")
  const manifest = await buildClient({
    routesDir: fixture.routes,
    outDir: clientOut,
    clientModule: fixture.client,
    minify: false,
    publicDir: false,
    plugins: [stylexBunPlugin("dom")],
  })

  expect(manifest.css?.length).toBeGreaterThan(0)
  expect(manifest.routeStyles?.index?.length).toBeGreaterThan(0)
  expect(cssText(clientOut)).toContain("x78zum5")

  const serverOut = join(fixture.root, "server")
  await buildServer({
    routesDir: fixture.routes,
    serverEntry: fixture.server,
    outDir: serverOut,
    clientEntry: manifest.entry,
    target: "bun",
    minify: false,
    plugins: [stylexBunPlugin("ssr")],
  })
  const server = bundleText(serverOut)
  expect(server).toContain('className: "x78zum5')
  expect(server).not.toContain("@stylexjs/stylex")
})

test("Vite StyleX plugin attributes virtual CSS to the route entry", async () => {
  const fixture = scaffold()
  const outDir = join(fixture.root, "vite")
  const manifest = await buildClientVite({
    root: fixture.root,
    routesDir: fixture.routes,
    outDir,
    clientModule: fixture.client,
    minify: false,
    vitePlugins: [stylexVitePlugin("dom")],
  })

  expect(manifest.css?.length).toBeGreaterThan(0)
  expect(manifest.routeStyles?.index?.length).toBeGreaterThan(0)
  expect(cssText(outDir)).toContain("x78zum5")
})
