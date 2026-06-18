import { describe, expect, test } from "bun:test"
import {
  createStylesheetEmitter,
  hash8,
  type PluginBuilder,
  reproduciblePath,
  requirePeer,
} from "../src/plugins/kit.ts"

type LoadCb = (args: { path: string }) => { contents: string; loader: string }
type ResolveCb = (args: { path: string }) => { path: string; namespace: string }

/** Drive `createStylesheetEmitter` with a fake build, capturing the resolver + namespaced CSS loader. */
function setupEmitter(namespace: string) {
  let cssLoad: LoadCb | undefined
  let cssResolve: ResolveCb | undefined
  const build = {
    onLoad: (opts: { namespace?: string }, cb: LoadCb) => {
      if (opts.namespace !== undefined) cssLoad = cb
    },
    onResolve: (_opts: unknown, cb: ResolveCb) => {
      cssResolve = cb
    },
  } as unknown as PluginBuilder
  const emitter = createStylesheetEmitter(build, namespace)
  return { emitter, cssLoad: cssLoad as LoadCb, cssResolve: cssResolve as ResolveCb }
}

describe("hash8", () => {
  test("is deterministic, 8 lowercase hex chars", () => {
    expect(hash8("/a/b.css\u0000title")).toMatch(/^[0-9a-f]{8}$/)
    expect(hash8("x")).toBe(hash8("x"))
  })

  test("different inputs (almost always) hash differently", () => {
    expect(hash8("foo")).not.toBe(hash8("bar"))
  })
})

describe("createStylesheetEmitter", () => {
  test("emit() stashes CSS and returns the virtual import line", () => {
    const { emitter } = setupEmitter("nifra-test-css")
    const line = emitter.emit("/abs/x.css", ".a{color:red}")
    expect(line).toBe('import "/abs/x.css?nifra-test-css"\n')
  })

  test("the resolver routes the virtual specifier into the namespace", () => {
    const { emitter, cssResolve } = setupEmitter("nifra-test-css")
    emitter.emit("/abs/x.css", ".a{}")
    const resolved = cssResolve({ path: "/abs/x.css?nifra-test-css" })
    expect(resolved.namespace).toBe("nifra-test-css")
  })

  test("the namespaced loader returns the stashed CSS (css loader); empty for unknown paths", () => {
    const { emitter, cssLoad } = setupEmitter("nifra-test-css")
    emitter.emit("/abs/x.css", ".a{color:red}")
    const hit = cssLoad({ path: "/abs/x.css?nifra-test-css" })
    expect(hit).toEqual({ contents: ".a{color:red}", loader: "css" })
    const miss = cssLoad({ path: "/abs/never.css?nifra-test-css" })
    expect(miss.contents).toBe("")
  })
})

describe("requirePeer", () => {
  test("returns the module when present", async () => {
    const sass = await requirePeer<{ compileString: unknown }>("sass", {
      feature: "test",
      install: "bun add -d sass",
    })
    expect(typeof sass.compileString).toBe("function")
  })

  test("throws an actionable install-hint error when absent", async () => {
    await expect(
      requirePeer("nifra-nonexistent-peer-xyz", {
        feature: "SASS/SCSS support",
        install: "bun add -d sass",
      }),
    ).rejects.toThrow(
      /SASS\/SCSS support requires the optional peer "nifra-nonexistent-peer-xyz".*bun add -d sass/,
    )
  })

  test("does NOT mask a real load failure as 'not installed' (rethrows with the cause)", async () => {
    const broken = new URL("./fixtures/throws-on-load.ts", import.meta.url).pathname
    await expect(
      requirePeer(broken, { feature: "SASS/SCSS support", install: "bun add -d sass" }),
    ).rejects.toThrow(/is installed but failed to load/)
  })
})

describe("reproduciblePath", () => {
  test("anchors on the file's nearest package.json (package-root-relative), forward-slashed", () => {
    // packages/web HAS a package.json → the path is relative to packages/web, NOT the cwd/repo root.
    const abs = `${process.cwd()}/packages/web/src/x.module.css`
    expect(reproduciblePath(abs)).toBe("src/x.module.css")
    expect(reproduciblePath(abs)).toBe(reproduciblePath(abs)) // deterministic
  })

  test("independent of cwd — same file → same path regardless of where the process runs", () => {
    // The whole point of (A): dom build cwd and ssr runtime cwd may differ; the result must not.
    const abs = `${process.cwd()}/packages/web/src/x.module.css`
    const fromRepoRoot = reproduciblePath(abs)
    const cwd = process.cwd()
    try {
      process.chdir("/")
      expect(reproduciblePath(abs)).toBe(fromRepoRoot) // cwd changed, result unchanged
    } finally {
      process.chdir(cwd)
    }
  })

  test("does not leak the machine's absolute prefix", () => {
    const abs = `${process.cwd()}/a/b.css`
    expect(reproduciblePath(abs).startsWith("/")).toBe(false)
  })
})
