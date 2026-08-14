import { expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { applyEnvFiles, parseEnvFile, takeEnvFileFlags } from "../src/env-file.ts"

test("parseEnvFile reads assignments, quotes, comments and `export`", () => {
  expect(
    parseEnvFile(
      [
        "# a comment",
        "",
        "DATABASE_URL=postgres://user@host:5444/db",
        "export API_KEY=plain",
        'QUOTED="a value with # inside"',
        "SINGLE='literal \\n stays'",
        'ESCAPED="line\\nbreak"',
        "TRAILING=value # trailing comment",
        "  SPACED = padded ",
        "not an assignment",
        "- name: something",
      ].join("\n"),
    ),
  ).toEqual({
    DATABASE_URL: "postgres://user@host:5444/db",
    API_KEY: "plain",
    QUOTED: "a value with # inside",
    SINGLE: "literal \\n stays",
    ESCAPED: "line\nbreak",
    TRAILING: "value",
    SPACED: "padded",
  })
})

test("parseEnvFile keeps a `#` that is part of the value", () => {
  expect(parseEnvFile("URL=https://example.test/path#frag")).toEqual({
    URL: "https://example.test/path#frag",
  })
})

test("takeEnvFileFlags strips both flag spellings and leaves the rest for the command parser", () => {
  expect(
    takeEnvFileFlags(["check", "--env-file", ".env.local", "--json", "--env-file=.env.ci"]),
  ).toEqual({
    argv: ["check", "--json"],
    files: [".env.local", ".env.ci"],
  })
})

test("takeEnvFileFlags refuses a flag with no path", () => {
  expect(() => takeEnvFileFlags(["check", "--env-file"])).toThrow(/--env-file needs a path/)
  expect(() => takeEnvFileFlags(["check", "--env-file", "--json"])).toThrow(
    /--env-file needs a path/,
  )
  expect(() => takeEnvFileFlags(["check", "--env-file="])).toThrow(/--env-file needs a path/)
})

test("applyEnvFiles never overwrites the process environment, and a later file wins over an earlier", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nifra-env-file-"))
  const key = "NIFRA_TEST_ENV_FILE_ONLY"
  const preset = "NIFRA_TEST_ENV_FILE_PRESET"
  try {
    await writeFile(join(dir, "base.env"), `${key}=from-base\n${preset}=from-base\n`)
    await writeFile(join(dir, "override.env"), `${key}=from-override\n`)
    delete process.env[key]
    process.env[preset] = "from-shell"

    const applied = await applyEnvFiles(dir, ["base.env", "override.env"])

    expect(applied).toEqual([join(dir, "base.env"), join(dir, "override.env")])
    expect(process.env[key]).toBe("from-override")
    // The shell (or CI's secret store) is the more explicit source and is never shadowed by a file.
    expect(process.env[preset]).toBe("from-shell")
  } finally {
    delete process.env[key]
    delete process.env[preset]
    await rm(dir, { recursive: true, force: true })
  }
})

test("applyEnvFiles fails loudly on a missing file instead of silently loading nothing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nifra-env-file-missing-"))
  try {
    await expect(applyEnvFiles(dir, [".env.nope"])).rejects.toThrow(
      /--env-file not found or unreadable/,
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
