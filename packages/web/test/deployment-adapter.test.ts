import { afterEach, beforeEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
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
      return { target: "node", stagingOutDir }
    },
  })

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
