import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { createViteDevServer, type ViteDevServer } from "../src/vite.ts"

/**
 * The public-env boundary has to hold in DEV, not only in the production build.
 *
 * Vite inlines any `VITE_*` variable into client source by default, which is its own boundary running
 * beside Nifra's `PUBLIC_` one - so a `VITE_DATABASE_URL` in someone's `.env` reached the browser
 * without ever passing the policy that is supposed to decide that. The production build was fixed and
 * tested; the dev server was fixed and NOT tested, which is the same shape as the bug that started
 * this: a guard holding in one pipeline while the file name reads like protection in all of them.
 *
 * This drives the real dev server and reads what it actually serves, rather than asserting that
 * `vite.ts` contains a line - a source assertion would still pass if Vite stopped honouring the
 * option, and the point of this boundary is what ends up in the browser.
 */

const TMP_BASE = `${import.meta.dir}/.tmp-vite-dev-env-`
const PUBLIC_VAR = "PUBLIC_NIFRA_DEV_VISIBLE"
const VITE_VAR = "VITE_NIFRA_DEV_MUST_STAY_PRIVATE"
const PUBLIC_VALUE = "nifra-dev-public-value"
const SECRET_VALUE = "vite-dev-prefix-bypass-secret"

let root: string
let routesDir: string
let server: ViteDevServer | undefined
let previous: { readonly pub: string | undefined; readonly secret: string | undefined }

beforeEach(() => {
  previous = { pub: process.env[PUBLIC_VAR], secret: process.env[VITE_VAR] }
  process.env[PUBLIC_VAR] = PUBLIC_VALUE
  process.env[VITE_VAR] = SECRET_VALUE

  root = mkdtempSync(TMP_BASE)
  routesDir = join(root, "routes")
  mkdirSync(routesDir)
  writeFileSync(join(routesDir, "index.tsx"), "export default function Index() { return null }\n")
  writeFileSync(join(root, "client.ts"), "export function mountRouter() {}\n")
  // A module that asks for BOTH, so one request shows what the boundary let through and what it kept.
  writeFileSync(
    join(root, "env-probe.ts"),
    `export const visible = import.meta.env.${PUBLIC_VAR}\n` +
      `export const hidden = import.meta.env.${VITE_VAR}\n`,
  )
})

afterEach(async () => {
  await server?.stop()
  server = undefined
  rmSync(root, { recursive: true, force: true })
  if (previous.pub === undefined) delete process.env[PUBLIC_VAR]
  else process.env[PUBLIC_VAR] = previous.pub
  if (previous.secret === undefined) delete process.env[VITE_VAR]
  else process.env[VITE_VAR] = previous.secret
})

const start = async (publicEnvPrefix?: string): Promise<string> => {
  server = await createViteDevServer({
    root,
    routesDir,
    clientModule: join(root, "client.ts"),
    port: 0,
    ...(publicEnvPrefix === undefined ? {} : { publicEnvPrefix }),
    createApp: () => ({ fetch: () => new Response("app") }),
  })
  return `http://127.0.0.1:${server.port}`
}

test("dev serves the declared public variable and withholds Vite's own VITE_* one", async () => {
  const origin = await start()
  const served = await (await fetch(`${origin}/env-probe.ts`)).text()

  expect(served).toContain(PUBLIC_VALUE)
  // The whole point. Before `envPrefix` was bound to Nifra's policy this line was in the response.
  expect(served).not.toContain(SECRET_VALUE)
}, 60_000)

test("a configured prefix is what dev honours, not the default", async () => {
  // `PUBLIC_` is no longer blessed when the app declares a different prefix, so the same variable
  // that was served above must now be withheld - proving the option is read rather than defaulted.
  const origin = await start("NIFRA_ONLY_")
  const response = await fetch(`${origin}/env-probe.ts`)
  const served = await response.text()

  // Proof this is the transformed module and not a 404 - without it, two `not.toContain`s would pass
  // on any error page, which is the way a test like this quietly stops testing anything.
  expect(response.status).toBe(200)
  expect(served).toContain("export const visible")

  expect(served).not.toContain(PUBLIC_VALUE)
  expect(served).not.toContain(SECRET_VALUE)
}, 60_000)
