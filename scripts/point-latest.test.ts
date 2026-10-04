import { expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type NpmRunner, pointLatest, shouldPointLatest } from "./point-latest.ts"

test("latest moves only forward", () => {
  expect(shouldPointLatest("4.0.0-beta.3", undefined)).toBe(true)
  expect(shouldPointLatest("4.0.0-beta.3", "3.9.0")).toBe(true)
  expect(shouldPointLatest("4.0.0-beta.4", "4.0.0-beta.3")).toBe(true)
  expect(shouldPointLatest("4.0.0-beta.3", "4.0.0-beta.3")).toBe(false)
  expect(shouldPointLatest("4.0.0-beta.3", "4.0.0")).toBe(false)
  expect(shouldPointLatest("3.2.1", "3.10.0")).toBe(false)
})

test("re-points public packages forward and reports what it could not read or move", async () => {
  const dir = mkdtempSync(join(tmpdir(), "point-latest-"))
  try {
    const pkg = (folder: string, manifest: Record<string, unknown>): void => {
      mkdirSync(join(dir, folder))
      writeFileSync(join(dir, folder, "package.json"), JSON.stringify(manifest))
    }
    pkg("ahead", { name: "@x/ahead", version: "2.0.0" })
    pkg("same", { name: "@x/same", version: "1.0.0" })
    pkg("hidden", { name: "@x/hidden", version: "9.0.0", private: true })
    pkg("unreadable", { name: "@x/unreadable", version: "3.0.0" })
    pkg("refused", { name: "@x/refused", version: "5.0.0" })
    mkdirSync(join(dir, "no-manifest"))
    const latest: Record<string, string> = { "@x/ahead": "1.0.0", "@x/same": "1.0.0" }
    const calls: string[] = []
    const npm: NpmRunner = async (args) => {
      calls.push(args.join(" "))
      if (args[0] === "view") {
        const name = args[1] ?? ""
        return name === "@x/unreadable"
          ? { exitCode: 1, stdout: "" }
          : { exitCode: 0, stdout: `${latest[name] ?? ""}\n` }
      }
      return { exitCode: args[2] === "@x/refused@5.0.0" ? 1 : 0, stdout: "" }
    }
    const failed = await pointLatest(dir, npm, () => {})
    expect(failed.sort()).toEqual(["@x/refused@5.0.0", "@x/unreadable@3.0.0"])
    expect(calls.sort()).toEqual([
      "dist-tag add @x/ahead@2.0.0 latest",
      "dist-tag add @x/refused@5.0.0 latest",
      "view @x/ahead dist-tags.latest",
      "view @x/refused dist-tags.latest",
      "view @x/same dist-tags.latest",
      "view @x/unreadable dist-tags.latest",
    ])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test.skipIf(process.platform === "win32")(
  "the script drives the npm on PATH and fails when a package is not re-pointed",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "point-latest-npm-"))
    try {
      const log = join(dir, "calls.log")
      const npm = join(dir, "npm")
      // Every package reads as never published; the one dist-tag add for @nifrajs/core fails.
      writeFileSync(
        npm,
        `#!/bin/sh\necho "$*" >> ${JSON.stringify(log)}\ncase "$*" in\n  "dist-tag add @nifrajs/core@"*) exit 1 ;;\nesac\nexit 0\n`,
      )
      chmodSync(npm, 0o755)
      const env = {
        PATH: `${dir}:${process.env.PATH ?? ""}`,
        HOME: dir,
        NPM_TOKEN: "test-only",
        // Even a real npm reached by mistake has no registry and no credentials here.
        npm_config_registry: "http://127.0.0.1:9/",
        NPM_CONFIG_USERCONFIG: join(dir, "npmrc"),
      }
      const which = Bun.spawnSync(["sh", "-c", "command -v npm"], { env })
      expect(which.stdout.toString().trim()).toBe(npm)
      const run = Bun.spawnSync([process.execPath, join(import.meta.dir, "point-latest.ts")], {
        env,
      })
      expect(run.exitCode).toBe(1)
      expect(run.stderr.toString()).toContain("1 package(s) not re-pointed: @nifrajs/core@")
      const calls = readFileSync(log, "utf8").trim().split("\n")
      expect(calls).toContain("view @nifrajs/core dist-tags.latest")
      expect(calls.some((call) => call.startsWith("dist-tag add @nifrajs/core@"))).toBe(true)
      expect(calls.filter((call) => call.startsWith("view ")).length).toBeGreaterThan(10)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  },
  30_000,
)
