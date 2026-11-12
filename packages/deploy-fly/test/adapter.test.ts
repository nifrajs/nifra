import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { buildTarget, buildWithDeploymentAdapter } from "@nifrajs/web/build"
import { flyAdapter } from "../src/index.ts"

test("Fly adapter validates options and emits a Node deployment manifest", async () => {
  const options = flyAdapter.validateOptions({
    app: "nifra-production",
    primaryRegion: "iad",
    internalPort: 4321,
    healthCheckPath: "/healthz",
  })
  const emitted = await flyAdapter.emit({
    adapterId: "fly",
    appRoot: "/app",
    baseTarget: "node",
    outDir: "/app/dist",
    options,
    result: {},
  })

  expect(emitted.run).toBe("fly deploy")
  expect(emitted.files).toEqual([
    {
      path: "Dockerfile",
      contents: expect.stringContaining('CMD ["node", "server.js"]'),
    },
    {
      path: "fly.toml",
      contents: expect.stringContaining('app = "nifra-production"'),
    },
  ])
  expect(emitted.files[0]?.contents).toContain("ENV PORT=4321")
  expect(emitted.files[1]?.contents).toContain("internal_port = 4321")
  expect(emitted.files[1]?.contents).toContain('primary_region = "iad"')
  expect(emitted.files[1]?.contents).toContain("[[http_service.checks]]")
  expect(emitted.files[1]?.contents).toContain('path = "/healthz"')
})

test("Fly adapter requires an app name and rejects unknown or unsafe settings", () => {
  expect(() => flyAdapter.validateOptions(undefined)).toThrow("`app` name")
  expect(() => flyAdapter.validateOptions({ app: "bad name" })).toThrow("Fly app name")
  expect(() => flyAdapter.validateOptions({ app: "valid", extra: "nope" })).toThrow(
    "unknown option",
  )
  expect(() => flyAdapter.validateOptions({ app: "valid", internalPort: 70000 })).toThrow(
    "between 1 and 65535",
  )
  expect(() =>
    flyAdapter.validateOptions({ app: "valid", healthCheckPath: "//other.test" }),
  ).toThrow("same-origin path")
})

test("Fly adapter defaults to an unpinned image and accepts a pinned reference", async () => {
  const emit = async (options: Record<string, unknown>) =>
    (
      await flyAdapter.emit({
        adapterId: "fly",
        appRoot: "/app",
        baseTarget: "node",
        outDir: "/app/dist",
        options: flyAdapter.validateOptions({ app: "valid", ...options }),
        result: {},
      })
    ).files[0]?.contents
  expect(await emit({})).toStartWith("FROM node:22-slim\n")
  expect(await emit({ image: "node:22.21.1-slim" })).toStartWith("FROM node:22.21.1-slim\n")
  const digest = `node@sha256:${"a".repeat(64)}`
  expect(await emit({ image: digest })).toStartWith(`FROM ${digest}\n`)
  expect(await emit({ image: "registry.example.com:5000/team/node:22" })).toStartWith(
    "FROM registry.example.com:5000/team/node:22\n",
  )
})

test("Fly adapter refuses an image that could add Dockerfile instructions", () => {
  for (const image of ["node:22\nRUN curl x | sh", "node 22", "", 5, "Node:22", "node@sha256:abc"])
    expect(() => flyAdapter.validateOptions({ app: "valid", image })).toThrow("`image` must be")
})

test("packages a real Nifra Node build into a Fly deploy directory", async () => {
  const root = mkdtempSync(join(import.meta.dir, ".tmp-fly-build-"))
  try {
    const routesDir = join(root, "routes")
    const frontendDir = join(root, "frontend")
    const frameworkFile = join(root, "framework.ts")
    mkdirSync(routesDir)
    mkdirSync(frontendDir)
    writeFileSync(join(routesDir, "index.tsx"), "export default function Home() { return null }\n")
    writeFileSync(join(frontendDir, "client.ts"), "export function mountRouter() {}\n")
    writeFileSync(
      frameworkFile,
      [
        "export const adapter = {",
        '  renderToStream: () => new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("<html></html>")); controller.close() } }),',
        '  hydrationHead: () => "",',
        "}",
      ].join("\n"),
    )
    const outDir = join(root, "dist")
    const result = await buildWithDeploymentAdapter({
      adapter: flyAdapter,
      appRoot: root,
      outDir,
      options: { app: "nifra-fly-test", primaryRegion: "iad" },
      protectedPaths: [routesDir, frontendDir, frameworkFile],
      build: (stagingOutDir) =>
        buildTarget("node", {
          routesDir,
          outDir: stagingOutDir,
          workDir: join(root, ".work"),
          clientModule: join(frontendDir, "client.ts"),
          adapterImport: frameworkFile,
        }),
    })

    expect(result).toMatchObject({ adapterId: "fly", baseTarget: "node", outDir })
    expect(readFileSync(join(outDir, "server.js"), "utf8")).toContain("serve")
    expect(readFileSync(join(outDir, "Dockerfile"), "utf8")).toContain('CMD ["node", "server.js"]')
    expect(readFileSync(join(outDir, "fly.toml"), "utf8")).toContain('app = "nifra-fly-test"')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}, 60_000)
