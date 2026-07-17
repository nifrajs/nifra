/**
 * Clean-dir install-and-use smoke (the Phase 8 exit criterion). Builds + packs every
 * library, installs the tarballs into a fresh directory with no workspace, and runs a
 * small app that exercises core + client + schema + middleware end-to-end — proving the
 * *published* packages work for a real consumer. Runs it twice:
 *   • under Bun  → resolves the `bun` export condition (shipped `src`)
 *   • under Node → resolves `default`/`types` (built `dist`)
 *
 *   bun run scripts/smoke.ts
 */
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { $ } from "bun"

const LIBS = ["core", "client", "schema", "middleware"] as const

console.log("• building all packages")
await $`bun scripts/build-no-run.ts`.quiet()

console.log("• packing tarballs (npm pack mirrors the published package layout)")
const tarballs: string[] = []
const deps: Record<string, string> = {}
for (const lib of LIBS) {
  await $`npm pack`.cwd(`packages/${lib}`).quiet()
  const [tgz] = await Array.fromAsync(
    new Bun.Glob("*.tgz").scan({ cwd: `packages/${lib}`, absolute: true }),
  )
  if (tgz === undefined) throw new Error(`no tarball produced for @nifrajs/${lib}`)
  tarballs.push(tgz)
  // Install all four as direct `file:` deps so sibling dependencies and peers are
  // satisfied locally. (Installing tarballs by path alone makes bun resolve the peer
  // from the npm registry — a 404, since nothing is published yet.)
  deps[`@nifrajs/${lib}`] = `file:${tgz}`
}

const app = await mkdtemp(join(tmpdir(), "nifra-smoke-"))
console.log(`• clean consumer dir → ${app}`)
await writeFile(
  join(app, "package.json"),
  // `overrides` forces the @nifrajs/core peer (and any transitive ref) to the local
  // tarball instead of the unpublished registry name.
  `${JSON.stringify({ name: "smoke", private: true, type: "module", dependencies: deps, overrides: deps }, null, 2)}\n`,
)
await $`bun install`.cwd(app).quiet()

// A real app: t-validated body + CORS middleware. Valid JS *and* TS (no annotations).
const setup = `
import { server } from "@nifrajs/core"
import { client } from "@nifrajs/client"
import { t } from "@nifrajs/schema"
import { cors } from "@nifrajs/middleware"

const app = server()
  .use(cors())
  .post("/users", { body: t.object({ name: t.string() }) }, (c) => ({ id: "u1", name: c.body.name }))
  .get("/users/:id", (c) => ({ id: c.params.id }))
`

// Bun: the full HTTP stack (`listen` uses Bun.serve) + a typed client round-trip.
const bunApp = `${setup}
const instance = app.listen(0)
const api = client<typeof app>(\`http://localhost:\${instance.port}\`)
const got = await api.users({ id: "42" }).get()
const made = await api.users.post({ name: "Ada" })
if (got.data?.id !== "42") throw new Error("GET failed: " + JSON.stringify(got))
if (made.data?.name !== "Ada") throw new Error("POST failed: " + JSON.stringify(made))
console.log("SMOKE_OK")
instance.stop()
`

// Node: the server is Bun-native (no \`listen\`), so drive the lifecycle via app.fetch;
// the client dist must still import + construct (in prod it calls a remote Bun server).
const nodeApp = `${setup}
const got = await (await app.fetch(new Request("http://x/users/42"))).json()
const body = JSON.stringify({ name: "Ada" })
const made = await (await app.fetch(new Request("http://x/users", { method: "POST", headers: { "content-type": "application/json" }, body }))).json()
if (got.id !== "42") throw new Error("GET failed: " + JSON.stringify(got))
if (made.name !== "Ada") throw new Error("POST failed: " + JSON.stringify(made))
if (client("http://localhost:9999") == null) throw new Error("client did not construct")
console.log("SMOKE_OK")
`

await writeFile(join(app, "app.ts"), bunApp)
await writeFile(join(app, "app.mjs"), nodeApp)

console.log("• run under Bun (src export condition)")
const bunOut = await $`bun app.ts`.cwd(app).text()
if (!bunOut.includes("SMOKE_OK")) throw new Error(`Bun smoke failed:\n${bunOut}`)

console.log("• run under Node (dist)")
const nodeOut = await $`node app.mjs`.cwd(app).text()
if (!nodeOut.includes("SMOKE_OK")) throw new Error(`Node smoke failed:\n${nodeOut}`)

await $`rm -rf ${app} ${tarballs}`.quiet().nothrow()
console.log(
  "\n✓ clean-dir smoke passed — core + client + schema + middleware, Bun (src) & Node (dist)",
)
