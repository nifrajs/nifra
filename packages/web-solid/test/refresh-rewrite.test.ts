import { expect, test } from "bun:test"
import { rewriteRefreshCall, SOLID_HOT_MODULE } from "../src/refresh-rewrite.ts"

const emitted = (local: string): string =>
  `import { $$refresh as ${local} } from "solid-js/refresh";\nconst _REG = {};\nif (import.meta.hot) {\n  import.meta.hot.accept();\n  ${local}("vite", import.meta.hot, _REG);\n}\n`

test("the refresh import and call are rewritten to the bridge, keeping a local name that holds `$$`", () => {
  const out = rewriteRefreshCall(emitted("_$$refresh"))
  expect(out).toContain(`import { refresh as _$$refresh } from "${SOLID_HOT_MODULE}";`)
  expect(out).toContain("_$$refresh(import.meta.url, (cb) => import.meta.hot.accept(cb), _REG);")
  expect(out).not.toContain("import.meta.hot.accept();")
})

test("a call under a different name than the import, or no call, is refused", () => {
  const mismatched = emitted("_a").replace('_a("vite"', '_b("vite"')
  expect(() => rewriteRefreshCall(mismatched)).toThrow("cannot rewrite")
  expect(() => rewriteRefreshCall("const x = 1")).toThrow("cannot rewrite")
})
