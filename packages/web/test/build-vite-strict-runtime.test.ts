import { afterAll, describe, expect, test } from "bun:test"
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

/**
 * The guard is only as good as the number of places that use it, and that is what failed: the
 * production build relaxed before importing while the dev server did not. ESM caches a module that
 * throws during evaluation, so the dev server's unguarded import ran first in the test process, vite
 * was permanently errored, and every later `loadVite` re-threw the cached failure with its shim
 * correctly installed and powerless. One unguarded import poisons vite for the whole process.
 *
 * A runtime test cannot see that - by the time it runs, some other file has already decided the
 * outcome. So this is enforced statically instead: the import lives in one module, and nothing else
 * may reach for vite directly.
 */
test("nothing imports vite except the shared, guarded importer", async () => {
  const srcDir = join(import.meta.dir, "..", "src")
  const offenders: string[] = []
  for await (const rel of new Bun.Glob("**/*.ts").scan({ cwd: srcDir, dot: false })) {
    const portableRel = rel.replaceAll("\\", "/")
    if (portableRel === "internal/vite-import.ts") continue
    const text = await Bun.file(join(srcDir, rel)).text()
    // Strip line comments so the prose warning next to the dev server's call does not self-report.
    const code = text.replaceAll(/^[\t ]*\/\/.*$/gm, "")
    if (/\bimport\(\s*["']vite["']\s*\)/.test(code)) offenders.push(portableRel)
  }
  expect(offenders).toEqual([])
})

test("the shared importer survives the narrow runtime", async () => {
  const imported = await runUnderStrictRuntime(
    `const { importVite } = await import(${JSON.stringify(join(import.meta.dir, "..", "src", "internal", "vite-import.ts"))})
     const vite = await importVite()
     console.log(typeof vite.build === "function" ? "IMPORT_OK" : "IMPORT_WRONG_SHAPE")`,
    NARROW_PRELUDE,
  )
  expect(imported.output).toContain("IMPORT_OK")
}, 120_000)

/**
 * The two helpers, exercised in-process. Everything above runs in a subprocess - which is the only way
 * to test a strict runtime - so none of it reaches the parent's coverage, and `isViteUnresolved` is
 * never reached there at all because vite resolves fine here.
 */
describe("vite-import helpers", () => {
  test("isViteUnresolved separates a missing vite from a broken one", async () => {
    const { isViteUnresolved } = await import("../src/internal/vite-import.ts")
    // Resolution failures: vite is not installed, which IS worth telling the user to fix.
    expect(isViteUnresolved(new Error("Cannot find package 'vite' imported from /app"))).toBe(true)
    expect(isViteUnresolved(new Error("Cannot find module 'vite'"))).toBe(true)
    expect(isViteUnresolved(new Error("ERR_MODULE_NOT_FOUND"))).toBe(true)
    // Evaluation failures: vite is installed and broke on this runtime. Telling that user to install
    // what they already installed is the wrong instruction, so these must not be classed as missing.
    expect(isViteUnresolved(new Error("First argument must be an Error object"))).toBe(false)
    expect(isViteUnresolved(new Error("failed to load native binding"))).toBe(false)
    expect(isViteUnresolved("not an error at all")).toBe(false)
  })

  test("relaxCaptureStackTrace still decorates a real Error, and is idempotent", async () => {
    const { relaxCaptureStackTrace } = await import("../src/internal/vite-import.ts")
    relaxCaptureStackTrace()
    const first = Error.captureStackTrace
    relaxCaptureStackTrace() // second call must not wrap the wrapper
    expect(Error.captureStackTrace).toBe(first)

    // The shim delegates: a genuine Error still gets its stack.
    const real = new Error("real")
    Error.captureStackTrace(real)
    expect(typeof real.stack).toBe("string")

    // And it swallows a refusal rather than propagating it - the entire point.
    expect(() => Error.captureStackTrace(Object.create(Error.prototype))).not.toThrow()
  })
})
