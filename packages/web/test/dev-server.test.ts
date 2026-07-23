import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { CLIENT_ENTRY_PATH, createDevServer, type DevServer } from "../src/dev.ts"

// Integration coverage for the Bun-pipeline dev server. The temp app lives INSIDE the workspace so the
// generated entry's `@nifrajs/web/client` import resolves through node_modules hoisting, exactly as a real
// app's would.

const WORKSPACE_TMP_BASE = `${import.meta.dir}/.tmp-dev-server-`
let projectRoot: string
let routesDir: string
let clientModule: string
let server: DevServer | undefined

beforeEach(() => {
  projectRoot = mkdtempSync(WORKSPACE_TMP_BASE)
  routesDir = join(projectRoot, "routes")
  mkdirSync(routesDir, { recursive: true })
  writeFileSync(join(routesDir, "index.tsx"), "export default function Index() { return null }\n")
  clientModule = join(projectRoot, "client-stub.ts")
  writeFileSync(clientModule, "export function mountRouter() {}\n")
})
afterEach(() => {
  server?.stop()
  server = undefined
  rmSync(projectRoot, { recursive: true, force: true })
})

/** Boot the dev server against the temp app. Leak guards off — `buildClient` is covered by its own tests. */
const boot = async (): Promise<DevServer> => {
  server = await createDevServer({
    routesDir,
    outDir: join(projectRoot, "dist"),
    clientModule,
    port: 0,
    guardLeaks: false,
    createApp: (clientEntry, importQuery) => ({
      fetch: () =>
        new Response(
          `<!doctype html><html><head></head><body><script type="module" src="${clientEntry}"></script>` +
            `<p id="q">${importQuery}</p></body></html>`,
          { headers: { "content-type": "text/html; charset=utf-8" } },
        ),
    }),
  })
  return server
}

test("pages reference the STABLE entry URL, never Bun's hashed one", async () => {
  const dev = await boot()
  expect(dev.clientEntry).toBe(CLIENT_ENTRY_PATH)
  const page = await (await fetch(`http://127.0.0.1:${dev.port}/`)).text()
  expect(page).toContain(`src="${CLIENT_ENTRY_PATH}"`)
  // A hashed URL in the document is the bug this whole design exists to prevent: it is a content hash over
  // the client graph, so it dies on the next rebuild and Bun answers it with a reload stub — forever.
  expect(page).not.toContain("/_bun/client/")
})

test("the stable entry URL redirects to Bun's current chunk", async () => {
  const dev = await boot()
  const res = await fetch(`http://127.0.0.1:${dev.port}${CLIENT_ENTRY_PATH}`, {
    redirect: "manual",
  })
  expect(res.status).toBe(307)
  expect(res.headers.get("location")).toStartWith("/_bun/")
  // And following it must reach a real bundle, not the reload stub a dead URL returns.
  const followed = await fetch(`http://127.0.0.1:${dev.port}${CLIENT_ENTRY_PATH}`)
  expect(followed.status).toBe(200)
  expect((await followed.text()).length).toBeGreaterThan(1000)
})

test("Bun's stylesheets are injected into the SSR'd <head>", async () => {
  // The app renders no stylesheet of its own; anything present came from Bun's CSS extraction.
  writeFileSync(join(projectRoot, "app.css"), "body{color:rebeccapurple}\n")
  writeFileSync(
    join(routesDir, "index.tsx"),
    'import "../app.css"\nexport default function Index() { return null }\n',
  )
  const dev = await boot()
  const page = await (await fetch(`http://127.0.0.1:${dev.port}/`)).text()
  expect(page).toMatch(/<link rel="stylesheet" href="\/_bun\/[^"]+\.css"><\/head>/)
})

test("SSR never lags the client: the render that follows a rebuild is already rebuilt too", async () => {
  // The ordering guarantee, stated precisely. SSR freshness is derived from Bun's entry hash at request
  // time rather than from a file watcher, so the moment Bun's client moves, the NEXT page render has
  // moved with it. Nothing here claims SSR leads the filesystem — it cannot, and does not need to. What
  // it must never do is still be rendering old code when the browser reloads with new code, which is what
  // produces a hydration mismatch nobody can reproduce on request.
  const dev = await boot()
  const origin = `http://127.0.0.1:${dev.port}`
  const chunk = async (): Promise<string | null> =>
    (await fetch(`${origin}${CLIENT_ENTRY_PATH}`, { redirect: "manual" })).headers.get("location")
  const queryOf = async (): Promise<string | undefined> =>
    /<p id="q">([^<]*)<\/p>/.exec(await (await fetch(`${origin}/`)).text())?.[1]

  const chunkBefore = await chunk()
  const queryBefore = await queryOf()
  expect(queryBefore).toBeDefined()

  writeFileSync(
    join(routesDir, "index.tsx"),
    "export const changed = true\nexport default function Index() { return null }\n",
  )
  // Wait for BUN to rebuild — that is the event the guarantee is relative to.
  let chunkAfter = chunkBefore
  for (let i = 0; i < 100 && chunkAfter === chunkBefore; i += 1) {
    await Bun.sleep(50)
    chunkAfter = await chunk()
  }
  expect(chunkAfter).not.toBe(chunkBefore)

  // The very next render is against the new build. No watcher tick was awaited to get here.
  expect(await queryOf()).not.toBe(queryBefore)
})

test("an unchanged app is NOT rebuilt on every request (the query is stable)", async () => {
  const dev = await boot()
  const first = await (await fetch(`http://127.0.0.1:${dev.port}/`)).text()
  const second = await (await fetch(`http://127.0.0.1:${dev.port}/`)).text()
  expect(/<p id="q">([^<]*)<\/p>/.exec(second)?.[1]).toBe(/<p id="q">([^<]*)<\/p>/.exec(first)?.[1])
})

test("stop() removes the generated dev directory", async () => {
  const dev = await boot()
  expect(await Bun.file(join(projectRoot, ".nifra-bun", "entry.tsx")).exists()).toBe(true)
  dev.stop()
  server = undefined
  expect(await Bun.file(join(projectRoot, ".nifra-bun", "entry.tsx")).exists()).toBe(false)
})

test("route additions and removals regenerate the Bun client entry without restart", async () => {
  await boot()
  const entry = join(projectRoot, ".nifra-bun", "entry.tsx")
  const about = join(routesDir, "about.tsx")
  writeFileSync(about, "export default function About() { return null }\n")

  for (let i = 0; i < 40 && !readFileSync(entry, "utf8").includes("routes/about.tsx"); i++) {
    await Bun.sleep(100)
  }
  expect(readFileSync(entry, "utf8")).toContain("routes/about.tsx")

  rmSync(about)
  for (let i = 0; i < 40 && readFileSync(entry, "utf8").includes("routes/about.tsx"); i++) {
    await Bun.sleep(100)
  }
  expect(readFileSync(entry, "utf8")).not.toContain("routes/about.tsx")
})

test("a failing app render returns the dev error overlay, not a bare 500", async () => {
  server = await createDevServer({
    routesDir,
    outDir: join(projectRoot, "dist"),
    clientModule,
    port: 0,
    guardLeaks: false,
    createApp: () => ({
      fetch: () => {
        throw new Error("loader exploded")
      },
    }),
  })
  const res = await fetch(`http://127.0.0.1:${server.port}/`)
  expect(res.status).toBe(500)
  expect(res.headers.get("content-type")).toContain("text/html")
  expect(await res.text()).toContain("loader exploded")
})
