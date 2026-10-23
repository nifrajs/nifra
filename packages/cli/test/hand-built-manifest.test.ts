import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { collectDoctorResult } from "../src/doctor.ts"
import {
  handBuiltManifestMessage,
  handBuiltManifests,
  manifestListsIn,
} from "../src/hand-built-manifest.ts"
import { writeAppFile } from "./fixture-root.ts"

const created: string[] = []
afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** An app whose `index` and `users/[id]` pages have backend halves and whose `about` page has none. */
function app(prefix = ""): string {
  const root = mkdtempSync(join(tmpdir(), "nifra-manifest-"))
  created.push(root)
  for (const file of ["index.tsx", "about.tsx", "users/[id].tsx"])
    writeAppFile(root, `${prefix}routes/${file}`, "export default () => null\n")
  for (const file of ["index.backend.ts", "users/[id].backend.ts"])
    writeAppFile(root, `${prefix}routes/${file}`, "export const loader = () => null\n")
  return root
}

const call = (argument: string): string =>
  `import { buildManifest } from "@nifrajs/web"\nconst load = () => () => Promise.reject(new Error("x"))\nexport const manifest = buildManifest(${argument}, load)\n`

const missingFor = (root: string, file: string, argument: string): readonly string[][] =>
  handBuiltManifests(root, manifestListsIn(file, call(argument))).map((f) => [...f.missing])

describe("a hand-built route manifest", () => {
  test("only a list spelled out in source is read", () => {
    expect(manifestListsIn("a.ts", call('["index.tsx", "about.tsx"]'))).toEqual([
      { file: "a.ts", line: 3, source: "array", entries: ["index.tsx", "about.tsx"] },
    ])
    expect(
      manifestListsIn("a.ts", call('Object.keys(import.meta.glob("./routes/**/*.tsx"))')),
    ).toEqual([{ file: "a.ts", line: 3, source: "glob", entries: ["./routes/**/*.tsx"] }])
    // biome-ignore lint/suspicious/noTemplateCurlyInString: source text the manifest check reads, not an interpolation here
    for (const opaque of ["files", '[...files, "index.tsx"]', "[`${name}.tsx`]", "discover()"])
      expect(manifestListsIn("a.ts", call(opaque))).toEqual([])
    expect(
      manifestListsIn(
        "a.ts",
        '// buildManifest(["index.tsx"])\nconst s = \'buildManifest(["x.tsx"])\'\n',
      ),
    ).toEqual([])
  })

  test("a listed page whose backend half is left out is reported; an unlisted page is not", () => {
    const root = app()
    expect(missingFor(root, "test/a.test.ts", '["index.tsx", "about.tsx"]')).toEqual([
      ["routes/index.backend.ts"],
    ])
    expect(missingFor(root, "test/a.test.ts", '["about.tsx"]')).toEqual([])
    expect(missingFor(root, "test/a.test.ts", '["index.tsx", "./index.backend.ts"]')).toEqual([])
  })

  test("glob patterns are matched against the routes directory", () => {
    const root = app()
    expect(
      missingFor(root, "test/a.test.ts", 'Object.keys(import.meta.glob("../routes/**/*.tsx"))'),
    ).toEqual([["routes/index.backend.ts", "routes/users/[id].backend.ts"]])
    expect(
      missingFor(
        root,
        "test/a.test.ts",
        'Object.keys(import.meta.glob(["/routes/**/*.tsx", "/routes/**/*.backend.ts"]))',
      ),
    ).toEqual([])
    expect(
      missingFor(root, "server.ts", 'Object.keys(import.meta.glob("./routes/**/*.{tsx,ts}"))'),
    ).toEqual([])
    expect(
      missingFor(
        root,
        "server.ts",
        'Object.keys(import.meta.glob(["./routes/**/*", "!./routes/**/*.backend.ts"]))',
      ),
    ).toEqual([["routes/index.backend.ts", "routes/users/[id].backend.ts"]])
  })

  test("each file is read against the routes directory of its own app", () => {
    const root = app("apps/web/")
    expect(missingFor(root, "apps/web/test/a.test.ts", '["index.tsx"]')).toEqual([
      ["apps/web/routes/index.backend.ts"],
    ])
    expect(missingFor(root, "apps/api/test/a.test.ts", '["index.tsx"]')).toEqual([])
  })

  test("doctor reports it as an advisory that never fails ok", async () => {
    const root = app()
    writeAppFile(
      root,
      "package.json",
      JSON.stringify({ name: "app", dependencies: { "@nifrajs/web": "5.0.0" } }),
    )
    writeAppFile(root, "test/routes.test.ts", call('["index.tsx", "users/[id].tsx"]'))
    const result = await collectDoctorResult(root)
    expect(result.ok).toBe(true)
    expect(result.handBuiltManifests).toEqual([
      {
        file: "test/routes.test.ts",
        line: 3,
        source: "array",
        missing: ["routes/index.backend.ts", "routes/users/[id].backend.ts"],
      },
    ])
    const message = handBuiltManifestMessage(result.handBuiltManifests![0]!)
    expect(message).toContain("leaves out 2 backend half(s) of pages it lists")
    expect(message).toContain('Use discoverRoutes("./routes") from @nifrajs/web/fs')
  })
})
