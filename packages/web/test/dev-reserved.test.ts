import { expect, test } from "bun:test"
import type { OnResolveCallback, PluginBuilder } from "bun"
import {
  DEV_ENTRY_FILE,
  reserveDevSpecifiers,
  withoutReservedSpecifiers,
} from "../src/internal/dev-reserved.ts"

// The browser-level proof is packages/cli/test/bun-dev-browser-boot.test.ts; this pins the filter
// rewrite itself, which has to leave every other match exactly as the plugin author wrote it.

const RESERVED = [`./${DEV_ENTRY_FILE}`, "react-refresh/runtime/index.js"]

test("a rewritten filter never matches a reserved specifier, however broad the original", () => {
  for (const filter of [/.*/, /^\./, /\.tsx$/, /runtime/, /^react-refresh\/runtime\/index\.js$/]) {
    for (const specifier of RESERVED) {
      expect(withoutReservedSpecifiers(filter).test(specifier), `${filter} ${specifier}`).toBe(
        false,
      )
    }
  }
})

test("on every other specifier a rewritten filter answers as the original does", () => {
  const filters = [
    /.*/,
    /\.tsx?$/,
    /^\./,
    /foo/,
    /FOO/i,
    /(a)\1/,
    /^b/m,
    /(?<=\/)x$/,
    /^\.\/entry\.tsx$/,
    /x/g,
    /\p{Lu}/u,
  ]
  const specifiers = [
    "./entry.tsx",
    `./${DEV_ENTRY_FILE}?raw`,
    `../${DEV_ENTRY_FILE}`,
    "react-refresh/runtime",
    "../routes/index.tsx",
    "./a.ts?raw",
    "react",
    "aa",
    "a/x",
    "foo",
    "Foo",
    "",
  ]
  for (const filter of filters) {
    const rewritten = withoutReservedSpecifiers(filter)
    for (const specifier of specifiers) {
      const expected = new RegExp(filter.source, filter.flags.replace("g", "")).test(specifier)
      expect(rewritten.test(specifier), `${filter} ${JSON.stringify(specifier)}`).toBe(expected)
    }
  }
})

test("reserveDevSpecifiers rewrites onResolve filters and passes everything else through", () => {
  const resolves: { filter: RegExp; namespace?: string; callback: OnResolveCallback }[] = []
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: the view reads only onResolve and spreads the rest, both present
  const build: PluginBuilder = {
    onResolve: (constraints: { filter: RegExp; namespace?: string }, callback: OnResolveCallback) =>
      resolves.push({ ...constraints, callback }),
    onLoad: () => undefined,
    config: { target: "browser" },
  } as never
  const view = reserveDevSpecifiers(build)
  const callback: OnResolveCallback = () => undefined
  expect(view.onResolve({ filter: /.*/, namespace: "file" }, callback)).toBe(view)
  expect(resolves).toHaveLength(1)
  expect(resolves[0]?.namespace).toBe("file")
  expect(resolves[0]?.callback).toBe(callback)
  expect(resolves[0]?.filter.test("./x.ts")).toBe(true)
  expect(resolves[0]?.filter.test(`./${DEV_ENTRY_FILE}`)).toBe(false)
  expect(view.onLoad).toBe(build.onLoad)
  expect(view.config).toBe(build.config)
})
