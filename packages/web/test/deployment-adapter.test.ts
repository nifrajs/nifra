import { afterEach, beforeEach, expect, test } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { join } from "node:path"
import {
  buildWithDeploymentAdapter,
  DEPLOYMENT_ADAPTER_API_VERSION,
  type DeploymentAdapterOutput,
  type DeploymentTargetAdapter,
} from "../src/build.ts"

let root: string
let appRoot: string
let outDir: string

beforeEach(() => {
  root = mkdtempSync(join(import.meta.dir, ".tmp-deployment-adapter-"))
  appRoot = join(root, "app")
  outDir = join(root, "dist")
  mkdirSync(appRoot)
  mkdirSync(outDir)
  writeFileSync(join(outDir, "old.txt"), "last good build")
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const adapter = (
  emit: DeploymentTargetAdapter["emit"] = () => ({
    files: [{ path: "provider.txt", contents: "host metadata" }],
    run: "deploy command",
  }),
): DeploymentTargetAdapter => ({
  apiVersion: DEPLOYMENT_ADAPTER_API_VERSION,
  id: "test-host",
  baseTarget: "node",
  capabilities: { componentPipeline: false },
  validateOptions: (input) => {
    if (input !== undefined && (typeof input !== "object" || input === null))
      throw new Error("options must be an object")
    return input === undefined ? {} : { input }
  },
  emit,
})

const build = (targetAdapter: DeploymentTargetAdapter, output = outDir) =>
  buildWithDeploymentAdapter({
    adapter: targetAdapter,
    appRoot,
    outDir: output,
    protectedPaths: [],
    build: async (stagingOutDir) => {
      mkdirSync(stagingOutDir, { recursive: true })
      writeFileSync(join(stagingOutDir, "server.js"), "base server")
      mkdirSync(join(stagingOutDir, "assets"))
      writeFileSync(join(stagingOutDir, "assets", "app.js"), "base asset")
      return { target: "node", stagingOutDir }
    },
  })

const malformedAdapter = (value: unknown): DeploymentTargetAdapter => {
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: Runtime validation must reject malformed JavaScript adapters before the typed builder runs.
  return value as DeploymentTargetAdapter
}

const malformedOptions = (value: unknown): Readonly<Record<string, unknown>> => {
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: These fixtures deliberately violate validateOptions' return contract to cover its runtime guard.
  return value as Readonly<Record<string, unknown>>
}

const malformedFiles = (value: unknown): DeploymentAdapterOutput["files"] => {
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: These fixtures deliberately violate the public file contract to cover its runtime guard.
  return value as DeploymentAdapterOutput["files"]
}

test("publishes a completed base build plus adapter files as one output", async () => {
  const result = await build(adapter())

  expect(result).toMatchObject({
    adapterId: "test-host",
    baseTarget: "node",
    outDir,
    run: "deploy command",
    result: { target: "node" },
  })
  expect(readFileSync(join(outDir, "server.js"), "utf8")).toBe("base server")
  expect(readFileSync(join(outDir, "provider.txt"), "utf8")).toBe("host metadata")
  expect(existsSync(join(outDir, "old.txt"))).toBe(false)
  expect(existsSync(result.result.stagingOutDir)).toBe(false)
})

test("keeps the previous output when the build or adapter fails", async () => {
  await expect(
    build(
      adapter(async () => {
        throw new Error("adapter failure")
      }),
    ),
  ).rejects.toThrow("adapter failure")
  expect(readFileSync(join(outDir, "old.txt"), "utf8")).toBe("last good build")
  expect(existsSync(join(outDir, "server.js"))).toBe(false)

  await expect(
    build(
      adapter((context) => {
        writeFileSync(join(context.outDir, "server.js"), "adapter overwrote the server")
        return { files: [], run: "deploy command" }
      }),
    ),
  ).rejects.toThrow("modified its read-only base output")
  expect(readFileSync(join(outDir, "old.txt"), "utf8")).toBe("last good build")

  await expect(
    buildWithDeploymentAdapter({
      adapter: adapter(),
      appRoot,
      outDir,
      protectedPaths: [],
      build: async () => {
        throw new Error("base build failure")
      },
    }),
  ).rejects.toThrow("base build failure")
  expect(readFileSync(join(outDir, "old.txt"), "utf8")).toBe("last good build")
})

test("rejects traversal, output collisions, and secret-bearing adapter files without publishing", async () => {
  const outputs: DeploymentAdapterOutput[] = [
    { files: [{ path: "../escape.txt", contents: "no" }], run: "deploy" },
    { files: [{ path: "bad\u0001name.txt", contents: "no" }], run: "deploy" },
    { files: [{ path: "server.js", contents: "overwrite" }], run: "deploy" },
    { files: [{ path: "Server.js", contents: "overwrite on Windows" }], run: "deploy" },
    { files: [], run: "deploy\u0001unsafe" },
    {
      files: [
        {
          path: "fly.toml",
          contents: 'key = "sk_live_0123456789abcdefABCDEF"\n',
        },
      ],
      run: "deploy",
    },
  ]
  const messages = [
    /invalid relative path/,
    /invalid relative path/,
    /collides with an existing path/,
    /collides with an existing path/,
    /must return files and non-empty run guidance/,
    /credential/,
  ]
  for (const [index, output] of outputs.entries()) {
    await expect(build(adapter(() => output))).rejects.toThrow(messages[index])
    expect(readFileSync(join(outDir, "old.txt"), "utf8")).toBe("last good build")
    expect(existsSync(join(outDir, "server.js"))).toBe(false)
  }
})

test("validates options and component-pipeline support before starting a build", async () => {
  let started = false
  await expect(
    buildWithDeploymentAdapter({
      adapter: adapter(),
      appRoot,
      outDir,
      protectedPaths: [],
      options: "invalid",
      build: async () => {
        started = true
        throw new Error("must not build")
      },
    }),
  ).rejects.toThrow("options must be an object")
  expect(started).toBe(false)

  await expect(
    buildWithDeploymentAdapter({
      adapter: adapter(),
      appRoot,
      outDir,
      protectedPaths: [],
      componentPipeline: true,
      build: async () => {
        started = true
        throw new Error("must not build")
      },
    }),
  ).rejects.toThrow("does not support the component pipeline")
  expect(started).toBe(false)
  expect(readFileSync(join(outDir, "old.txt"), "utf8")).toBe("last good build")
})

test("rejects malformed adapter identities and contracts before invoking the builder", async () => {
  const invalidAdapters: readonly [unknown, RegExp][] = [
    [null, /must be an object/],
    [{ ...adapter(), apiVersion: 2 }, /uses API 2/],
    [{ ...adapter(), id: "Node" }, /lowercase, non-reserved/],
    [{ ...adapter(), id: "node" }, /lowercase, non-reserved/],
    [{ ...adapter(), baseTarget: "unknown" }, /unsupported baseTarget/],
    [{ ...adapter(), capabilities: null }, /must declare capabilities/],
    [{ ...adapter(), capabilities: { componentPipeline: "yes" } }, /must declare capabilities/],
    [{ ...adapter(), validateOptions: undefined }, /must implement validateOptions/],
    [{ ...adapter(), emit: undefined }, /must implement validateOptions/],
  ]

  for (const [candidate, message] of invalidAdapters) {
    let started = false
    await expect(
      buildWithDeploymentAdapter({
        adapter: malformedAdapter(candidate),
        appRoot,
        outDir,
        protectedPaths: [],
        build: async () => {
          started = true
          return undefined
        },
      }),
    ).rejects.toThrow(message)
    expect(started).toBe(false)
  }
})

test("requires validateOptions to return a plain object", async () => {
  const invalidValues: readonly unknown[] = [
    null,
    [],
    new Date(),
    Object.create({ inherited: true }),
  ]
  for (const value of invalidValues) {
    await expect(
      build({
        ...adapter(),
        validateOptions: () => malformedOptions(value),
      }),
    ).rejects.toThrow("validateOptions() must return a plain object")
  }

  const nullPrototypeOptions: Record<string, unknown> = Object.create(null)
  nullPrototypeOptions.mode = "safe"
  const result = await build({ ...adapter(), validateOptions: () => nullPrototypeOptions })
  expect(result.run).toBe("deploy command")
})

test("validates adapter file paths, types, limits, and portable path collisions", async () => {
  const oversized = "x".repeat(2 * 1024 * 1024 + 1)
  const tooMany = Array.from({ length: 257 }, (_, index) => ({
    path: `meta-${index}.txt`,
    contents: "x",
  }))
  const tooMuch = Array.from({ length: 5 }, (_, index) => ({
    path: `meta-${index}.txt`,
    contents: "x".repeat(1700 * 1024),
  }))
  const invalidFiles = malformedFiles([{ path: "meta.txt", contents: 42 }])
  const outputs: readonly [DeploymentAdapterOutput, RegExp][] = [
    [{ files: tooMany, run: "deploy" }, /at most 256 files/],
    [{ files: malformedFiles([null]), run: "deploy" }, /invalid relative path/],
    [{ files: [{ path: "x".repeat(241), contents: "x" }], run: "deploy" }, /invalid relative path/],
    [
      { files: [{ path: "folder\\file.txt", contents: "x" }], run: "deploy" },
      /invalid relative path/,
    ],
    [
      { files: [{ path: "folder:file.txt", contents: "x" }], run: "deploy" },
      /invalid relative path/,
    ],
    [{ files: [{ path: "/rooted.txt", contents: "x" }], run: "deploy" }, /invalid relative path/],
    [
      { files: [{ path: "folder/../escape.txt", contents: "x" }], run: "deploy" },
      /invalid relative path/,
    ],
    [{ files: [{ path: "CON.txt", contents: "x" }], run: "deploy" }, /invalid relative path/],
    [{ files: [{ path: "trailing. ", contents: "x" }], run: "deploy" }, /invalid relative path/],
    [{ files: invalidFiles, run: "deploy" }, /must contain text or bytes/],
    [
      { files: [{ path: "large.txt", contents: oversized }], run: "deploy" },
      /exceeds 2097152 bytes/,
    ],
    [{ files: tooMuch, run: "deploy" }, /exceeds 8388608 bytes/],
    [
      {
        files: [
          { path: "folder", contents: "file" },
          { path: "folder/child.txt", contents: "nested" },
        ],
        run: "deploy",
      },
      /path crosses a file: folder/,
    ],
    [
      {
        files: [
          { path: "Folder/first.txt", contents: "first" },
          { path: "folder/second.txt", contents: "second" },
        ],
        run: "deploy",
      },
      /case-insensitive directory collision/,
    ],
  ]

  for (const [output, message] of outputs) {
    await expect(build(adapter(() => output))).rejects.toThrow(message)
    expect(readFileSync(join(outDir, "old.txt"), "utf8")).toBe("last good build")
  }
})

test("writes nested byte files and accepts a reviewed secret exemption", async () => {
  const result = await buildWithDeploymentAdapter({
    adapter: adapter(() => ({
      files: [
        { path: "nested/opaque.bin", contents: new Uint8Array([0xff, 0x00, 0x10]) },
        { path: "nested/fly.toml", contents: 'key = "sk_live_0123456789abcdefABCDEF"\n' },
      ],
      run: "deploy command",
    })),
    appRoot,
    outDir,
    protectedPaths: [],
    secretExemptions: [
      { rule: "key-format", file: "nested/fly.toml", reason: "fixture for exemption behavior" },
    ],
    build: async (stagingOutDir) => {
      mkdirSync(stagingOutDir, { recursive: true })
      writeFileSync(join(stagingOutDir, "server.js"), "base server")
      return { target: "node" }
    },
  })
  expect(result.outDir).toBe(outDir)
  expect([...readFileSync(join(outDir, "nested/opaque.bin"))]).toEqual([0xff, 0x00, 0x10])
  expect(readFileSync(join(outDir, "nested/fly.toml"), "utf8")).toContain("sk_live_")
})

test("rejects a symlink in base output and an output directory that becomes a symlink", async () => {
  await expect(
    buildWithDeploymentAdapter({
      adapter: adapter(),
      appRoot,
      outDir,
      protectedPaths: [],
      build: async (stagingOutDir) => {
        mkdirSync(stagingOutDir, { recursive: true })
        symlinkSync(appRoot, join(stagingOutDir, "unexpected-link"))
        return undefined
      },
    }),
  ).rejects.toThrow("contains a symbolic link")

  const safeTarget = join(root, "safe-target")
  mkdirSync(safeTarget)
  await expect(
    buildWithDeploymentAdapter({
      adapter: adapter(),
      appRoot,
      outDir,
      protectedPaths: [],
      build: async (stagingOutDir) => {
        mkdirSync(stagingOutDir, { recursive: true })
        writeFileSync(join(stagingOutDir, "server.js"), "base server")
        rmSync(outDir, { recursive: true, force: true })
        symlinkSync(safeTarget, outDir)
        return undefined
      },
    }),
  ).rejects.toThrow(/symlink|symbolic link/)
})

test("refuses an output directory that is already a symlink", async () => {
  const safeTarget = join(root, "safe-target")
  mkdirSync(safeTarget)
  rmSync(outDir, { recursive: true, force: true })
  symlinkSync(safeTarget, outDir)

  await expect(build(adapter())).rejects.toThrow("is a symlink")
})
