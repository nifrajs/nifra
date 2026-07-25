import { afterAll, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

/**
 * A Vite build must survive a runtime whose `Error.captureStackTrace` is stricter than V8's.
 *
 * V8 decorates ANY object handed to that API. Some runtimes require a real Error - one with the internal
 * slot, which `Object.create(Error.prototype)` does not have - and throw "First argument must be an Error
 * object". Vite bundles `follow-redirects`, which defines its error types the pre-class way:
 *
 *   CustomError.prototype = new (baseClass || Error)()
 *
 * That CONSTRUCTS the base while defining the subclass, so `captureStackTrace` receives an object which
 * inherits Error but was never built by it. On a strict runtime it throws while vite's own module is
 * still evaluating, so `import("vite")` fails and every Vite build dies with a message about stack traces
 * that names nothing about vite. It was visible only on CI, as the entire Vite suite failing at once.
 *
 * ## Why a subprocess
 *
 * The check has to happen on vite's FIRST evaluation in a process. Installing the strict shim inside this
 * suite proves nothing: any earlier test that builds has already imported vite, so the module cache hands
 * back the finished module and `follow-redirects` never re-runs - a version of this test written that way
 * passed with the fix removed. A fresh process is what makes the assertion mean anything.
 */

const TMP_BASE = `${import.meta.dir}/.tmp-strict-runtime-`
const dirs: string[] = []
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

/** The strict runtime, as a prelude both subprocesses share. */
const STRICT_PRELUDE = `
  const permissive = Error.captureStackTrace
  Error.captureStackTrace = (target, ctor) => {
    if (Object.prototype.toString.call(target) !== "[object Error]") {
      throw new TypeError("First argument must be an Error object")
    }
    return permissive.call(Error, target, ctor)
  }
`

/**
 * A second strict runtime, and the one that actually shipped a failure.
 *
 * `STRICT_PRELUDE` refuses ANY non-Error target. A Bun build on CI was narrower: it accepted a bare
 * `Object.create(Error.prototype)` and refused follow-redirects' object, which carries an Error
 * INSTANCE as its prototype and passes `this.constructor`. That difference is invisible to a shim that
 * only looks at the target, so it is modelled here by refusing only when `constructorOpt` is supplied -
 * the discriminator the previous probe was blind to.
 */
const NARROW_PRELUDE = `
  const permissive = Error.captureStackTrace
  Error.captureStackTrace = (target, ctor) => {
    if (ctor !== undefined && Object.prototype.toString.call(target) !== "[object Error]") {
      throw new TypeError("First argument must be an Error object")
    }
    return permissive.call(Error, target, ctor)
  }
`

async function runUnderStrictRuntime(
  body: string,
  prelude: string = STRICT_PRELUDE,
): Promise<{ code: number; output: string }> {
  const proc = Bun.spawn([process.execPath, "-e", `${prelude}\n${body}`], {
    // `vite` is a devDependency of @nifrajs/web, so a bare import only resolves from inside it.
    cwd: join(import.meta.dir, ".."),
    stdout: "pipe",
    stderr: "pipe",
  })
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  return { code: await proc.exited, output: out + err }
}

test("importing vite on such a runtime fails - the hazard is real, not hypothetical", async () => {
  // The negative control. Without it the test below could pass because nothing was ever wrong; this
  // pins the actual failure, in a process where nifra has relaxed nothing.
  const raw = await runUnderStrictRuntime(`
    try { await import("vite"); console.log("VITE_IMPORTED") }
    catch (error) { console.log("VITE_FAILED:", error.message) }
  `)
  expect(raw.output).toContain("VITE_FAILED:")
  expect(raw.output).toMatch(/First argument must be an Error object/)
}, 120_000)

test("nifra's Vite build runs on that same runtime", async () => {
  const root = mkdtempSync(TMP_BASE)
  dirs.push(root)
  mkdirSync(join(root, "routes"), { recursive: true })
  writeFileSync(
    join(root, "routes", "index.tsx"),
    "export default function Index() { return null }\n",
  )
  writeFileSync(join(root, "client-stub.ts"), "export function mountRouter() {}\n")

  const built = await runUnderStrictRuntime(`
    const { buildClientVite } = await import(${JSON.stringify(join(import.meta.dir, "..", "src", "build-vite.ts"))})
    await buildClientVite({
      root: ${JSON.stringify(root)},
      routesDir: ${JSON.stringify(join(root, "routes"))},
      outDir: ${JSON.stringify(join(root, "dist", "assets"))},
      clientModule: ${JSON.stringify(join(root, "client-stub.ts"))},
      minify: false,
    })
    console.log("BUILD_OK")
  `)
  expect(built.output).toContain("BUILD_OK")
  expect(built.code).toBe(0)
}, 120_000)

test("importing vite fails on the NARROW runtime too - the shape the old probe missed", async () => {
  // Negative control for the narrow case specifically. If vite imported cleanly here there would be
  // nothing for the shim to fix, and the test below would prove nothing.
  const raw = await runUnderStrictRuntime(
    `try { await import("vite"); console.log("VITE_IMPORTED") }
     catch (error) { console.log("VITE_FAILED:", error.message) }`,
    NARROW_PRELUDE,
  )
  expect(raw.output).toContain("VITE_FAILED:")
  expect(raw.output).toMatch(/First argument must be an Error object/)
}, 120_000)

test("nifra's Vite build runs on the NARROW runtime - this is the case that shipped broken", async () => {
  // The regression this file exists for now. The previous implementation probed with
  // `Object.create(Error.prototype)` and no `constructorOpt`; this runtime accepts exactly that, so the
  // probe concluded "permissive", installed nothing, and every Vite test failed on CI while passing
  // locally and in a Linux container. Reinstating the probe turns this red.
  const root = mkdtempSync(TMP_BASE)
  dirs.push(root)
  mkdirSync(join(root, "routes"), { recursive: true })
  writeFileSync(
    join(root, "routes", "index.tsx"),
    "export default function Index() { return null }\n",
  )
  writeFileSync(join(root, "client-stub.ts"), "export function mountRouter() {}\n")

  const built = await runUnderStrictRuntime(
    `const { buildClientVite } = await import(${JSON.stringify(join(import.meta.dir, "..", "src", "build-vite.ts"))})
     await buildClientVite({
       root: ${JSON.stringify(root)},
       routesDir: ${JSON.stringify(join(root, "routes"))},
       outDir: ${JSON.stringify(join(root, "dist", "assets"))},
       clientModule: ${JSON.stringify(join(root, "client-stub.ts"))},
       minify: false,
     })
     console.log("BUILD_OK")`,
    NARROW_PRELUDE,
  )
  expect(built.output).toContain("BUILD_OK")
  expect(built.code).toBe(0)
}, 120_000)
