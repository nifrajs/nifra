import { expect, test } from "bun:test"
import { resolve } from "node:path"

/**
 * A production server bundle folds every per-request NODE_ENV check to a constant. Node reads
 * `process.env` through the environment on each access (about 145 ns, against about 1 ns on Bun), and a
 * define replaces only the plain `process.env.NODE_ENV` member read, never `process.env?.NODE_ENV`.
 */
const PER_REQUEST = [
  "packages/web/src/internal/ppr/server.ts",
  "packages/web-vue/src/index.ts",
  "packages/web-solid/src/index.ts",
]

for (const file of PER_REQUEST) {
  test(`${file} reads no NODE_ENV in a production bundle`, async () => {
    const result = await Bun.build({
      entrypoints: [resolve(import.meta.dir, "../../..", file)],
      target: "node",
      packages: "external",
      define: { "process.env.NODE_ENV": '"production"' },
    })
    expect(result.success).toBe(true)
    const text = (await Promise.all(result.outputs.map((output) => output.text()))).join("\n")
    expect(text).not.toContain("NODE_ENV")
  })
}
