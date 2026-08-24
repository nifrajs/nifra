/**
 * Golden output for the three verification commands. `nifra check`, `nifra assure`, and
 * `nifra levels` are three views over the same reflected project; their stdout is a public contract
 * (agents and CI read it). This suite pins each command's exact human + `--json` output so a change
 * to how the shared data is composed cannot silently move a byte. Absolute fixture paths are the only
 * machine-specific text, so they are normalized to `<cwd>` before snapshotting.
 */

import { afterAll, describe, expect, test } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { runAssurance } from "../src/assure.ts"
import { runCapabilitySnapshot } from "../src/capabilities-tool.ts"
import { runCheck } from "../src/check.ts"
import { runLevels } from "../src/levels-tool.ts"
import { runManifestEmit } from "../src/manifest-tool.ts"
import { createFixtureProject, createFixtureRoot, removeFixtureRoot } from "./fixture-root.ts"

const FIXTURES = createFixtureRoot("nifra-verification-golden-")

afterAll(async () => {
  removeFixtureRoot(FIXTURES)
})

/** Capture everything a command writes to stdout, with the fixture's absolute path folded to `<cwd>`
 * so the snapshot is stable across machines. */
async function capture(cwd: string, run: () => Promise<unknown>): Promise<string> {
  const lines: string[] = []
  const original = console.log
  console.log = (...args: unknown[]) => {
    lines.push(args.map((arg) => (typeof arg === "string" ? arg : String(arg))).join(" "))
  }
  try {
    await run()
  } finally {
    console.log = original
  }
  let output = lines.join("\n").split(cwd).join("<cwd>")
  // Normalize only the separator immediately after the redacted absolute path. Replacing every
  // backslash corrupts JSON output (`\"` becomes `/\"`, and `\n` becomes `/n`).
  if (cwd.includes("\\")) output = output.replaceAll(/(<cwd>)\\/g, "$1/")
  return output
}

const PAY_BACKEND = [
  `import { server } from "@nifrajs/core"`,
  `const okBody = {`,
  `  "~standard": { version: 1, vendor: "golden", validate: (value) => (typeof value?.amount === "number" ? { value } : { issues: [{ message: "amount" }] }) },`,
  `  jsonSchema: { type: "object", properties: { amount: { type: "number", minimum: 1, maximum: 9 } }, required: ["amount"] },`,
  `}`,
  `export const backend = server().post("/pay", { body: okBody }, () => ({ ok: true }))`,
  "",
].join("\n")

const FULL_CONFIG = [
  `import { defineAssuranceConfig } from "@nifrajs/core/assurance"`,
  `import { defineCapabilityPolicy } from "@nifrajs/core/capabilities"`,
  `import { backend } from "./backend.ts"`,
  `export default defineAssuranceConfig({`,
  `  source: backend,`,
  `  policy: { rules: [{ name: "all", match: {}, require: [] }] },`,
  `  capabilities: defineCapabilityPolicy({ definitions: [], provenance: { imports: [], forbiddenImports: [] } }),`,
  `  manifest: {},`,
  `  invariants: { executor: (request) => backend.fetch(request) },`,
  `})`,
  "",
].join("\n")

/** Backend + a full assurance config (route assurance + capabilities + manifest + invariants), with
 * the capability lockfile and trust manifest emitted so the ladder can climb and `check` sees them
 * in sync. Exercises every assurance-fed branch of all three commands at once. */
async function fullProject(): Promise<string> {
  const cwd = createFixtureProject(FIXTURES, "full-")
  await mkdir(cwd, { recursive: true })
  await writeFile(join(cwd, "backend.ts"), PAY_BACKEND)
  await writeFile(join(cwd, "nifra.assurance.ts"), FULL_CONFIG)
  const original = console.log
  console.log = () => {} // silence the emit tools' own progress logs during setup
  try {
    await runCapabilitySnapshot(cwd)
    await runManifestEmit(cwd)
  } finally {
    console.log = original
  }
  return cwd
}

/** Backend only, no assurance config: the common project shape. */
async function plainProject(): Promise<string> {
  const cwd = createFixtureProject(FIXTURES, "plain-")
  await mkdir(cwd, { recursive: true })
  await writeFile(join(cwd, "backend.ts"), PAY_BACKEND)
  return cwd
}

/** A route module tripping three source lints at once: an own-API fetch, a server-only import, and a
 * raw-Response return (the advisory). No assurance config. */
async function dirtyProject(): Promise<string> {
  const cwd = createFixtureProject(FIXTURES, "dirty-")
  await mkdir(join(cwd, "routes"), { recursive: true })
  await writeFile(
    join(cwd, "routes", "notes.tsx"),
    [
      `import { db } from "../db"`,
      `export async function loader() {`,
      `  const res = await fetch("/notes")`,
      `  return res`,
      `}`,
      `export function action() {`,
      `  return new Response("ok")`,
      `}`,
      "",
    ].join("\n"),
  )
  return cwd
}

describe("verification golden output: nifra check", () => {
  test("full assurance project: human report", async () => {
    const cwd = await fullProject()
    expect(await capture(cwd, () => runCheck(cwd))).toMatchSnapshot()
  })

  test("full assurance project: --json", async () => {
    const cwd = await fullProject()
    expect(await capture(cwd, () => runCheck(cwd, { json: true }))).toMatchSnapshot()
  })

  test("plain project (no config): human report with tips", async () => {
    const cwd = await plainProject()
    expect(await capture(cwd, () => runCheck(cwd))).toMatchSnapshot()
  })

  test("dirty project: human report with failing lints + advisory", async () => {
    const cwd = await dirtyProject()
    expect(await capture(cwd, () => runCheck(cwd))).toMatchSnapshot()
  })

  test("dirty project: --json", async () => {
    const cwd = await dirtyProject()
    expect(await capture(cwd, () => runCheck(cwd, { json: true }))).toMatchSnapshot()
  })
})

describe("verification golden output: nifra assure", () => {
  test("full assurance project: human report", async () => {
    const cwd = await fullProject()
    expect(await capture(cwd, () => runAssurance(cwd))).toMatchSnapshot()
  })

  test("full assurance project: --json", async () => {
    const cwd = await fullProject()
    expect(await capture(cwd, () => runAssurance(cwd, { json: true }))).toMatchSnapshot()
  })

  test("missing config throws the same error as before", async () => {
    const cwd = await plainProject()
    await expect(runAssurance(cwd)).rejects.toThrow("route assurance config not found")
  })
})

describe("verification golden output: nifra levels", () => {
  test("full assurance project: human report climbs the ladder", async () => {
    const cwd = await fullProject()
    expect(await capture(cwd, () => runLevels(cwd))).toMatchSnapshot()
  })

  test("full assurance project: --json", async () => {
    const cwd = await fullProject()
    expect(await capture(cwd, () => runLevels(cwd, { json: true }))).toMatchSnapshot()
  })

  test("plain project (no config): ladder stops at L0", async () => {
    const cwd = await plainProject()
    expect(await capture(cwd, () => runLevels(cwd))).toMatchSnapshot()
  })
})
