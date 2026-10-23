import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { autoReflectJsonSchema, explainAutoReflectJsonSchema } from "../src/index.ts"

// A schema that names zod as its vendor but carries no converter, so the project's zod is probed.
const zodShaped = { "~standard": { version: 1, vendor: "zod", validate: () => ({ value: 1 }) } }

let root = ""
beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "nifra-mock-zod-")))
})
afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

/** A project directory whose `node_modules/zod` is `source`, or none when `source` is undefined. */
function project(name: string, source?: string): string {
  const dir = join(root, name)
  mkdirSync(join(dir, "src", "deep"), { recursive: true })
  if (source !== undefined) {
    const zod = join(dir, "node_modules", "zod")
    mkdirSync(zod, { recursive: true })
    writeFileSync(join(zod, "package.json"), JSON.stringify({ name: "zod", main: "index.js" }))
    writeFileSync(join(zod, "index.js"), source)
  }
  return join(dir, "src", "deep")
}

/** Read the schema with the process cwd inside `dir`; probes are cached per cwd. */
function fromCwd<T>(dir: string, read: () => T): T {
  const previous = process.cwd()
  process.chdir(dir)
  try {
    return read()
  } finally {
    process.chdir(previous)
  }
}

describe("autoReflectJsonSchema - project zod probe", () => {
  test("a project zod older than 4 is the answer, found by walking up from cwd", () => {
    const dir = project("old-zod", "module.exports = {}\n")
    expect(fromCwd(dir, () => explainAutoReflectJsonSchema(zodShaped))).toBe(
      "the zod installed is older than 4 and has no toJSONSchema",
    )
  })

  test("a project zod whose converter returns nothing explains so", () => {
    const dir = project("empty-zod", "module.exports = { toJSONSchema: () => undefined }\n")
    expect(fromCwd(dir, () => explainAutoReflectJsonSchema(zodShaped))).toBe(
      "zod's toJSONSchema returned nothing",
    )
  })

  test("a project zod that converts is used", () => {
    const dir = project(
      "new-zod",
      "module.exports = { toJSONSchema: (_schema, options) => ({ type: 'string', io: options.io }) }\n",
    )
    expect(fromCwd(dir, () => autoReflectJsonSchema(zodShaped))).toEqual({
      type: "string",
      io: "input",
    })
  })

  test("a project zod that fails to load falls back to the package's own zod", () => {
    const dir = project("broken-zod", "throw new Error('cannot load zod')\n")
    const fallback = fromCwd(dir, () => explainAutoReflectJsonSchema(zodShaped))
    expect(fallback).not.toBe("zod is not resolvable from the project or from @nifrajs/mock")
    const bare = project("no-zod")
    expect(fromCwd(bare, () => explainAutoReflectJsonSchema(zodShaped))).toBe(fallback)
  })

  test("a library converter that returns no schema explains so", () => {
    const schema = {
      "~standard": {
        version: 1,
        vendor: "acme",
        validate: () => ({ value: 1 }),
        jsonSchema: { input: () => null },
      },
    }
    expect(explainAutoReflectJsonSchema(schema)).toBe(
      "the acme schema's ~standard.jsonSchema.input returned no schema",
    )
  })
})
