import { expect, test } from "bun:test"
import { availableParallelism } from "node:os"
import { join } from "node:path"
import { parseContentionArgs } from "./cpu-contention.ts"

test("spinner count defaults to two per core and takes either override", () => {
  expect(parseContentionArgs(["--", "bun", "run", "test"], 4)).toEqual({
    threads: 8,
    command: ["bun", "run", "test"],
  })
  expect(parseContentionArgs(["--per-core", "3", "--", "x"], 4).threads).toBe(12)
  expect(parseContentionArgs(["--threads", "5", "--", "x"], 4).threads).toBe(5)
  expect(parseContentionArgs(["bun", "run", "test"], 4).command).toEqual(["bun", "run", "test"])
})

test("a missing command or a bad option is refused", () => {
  expect(() => parseContentionArgs([], 4)).toThrow(/usage/)
  expect(() => parseContentionArgs(["--"], 4)).toThrow(/usage/)
  expect(() => parseContentionArgs(["--threads", "2"], 4)).toThrow(/usage/)
  expect(() => parseContentionArgs(["--threads", "0", "--", "x"], 4)).toThrow(/positive integer/)
  expect(() => parseContentionArgs(["--threads", "1.5", "--", "x"], 4)).toThrow(/positive integer/)
  expect(() => parseContentionArgs(["--cores", "2", "--", "x"], 4)).toThrow(/unknown option/)
})

// The `test:contention` form: `--` straight after the script path, which Bun drops from argv.
test("the command's exit code comes back and the spinners end with it", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, "cpu-contention.ts"),
      "--",
      process.execPath,
      "-e",
      "process.exit(3)",
    ],
    { stdout: "pipe", stderr: "pipe" },
  )
  const [code, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()])
  expect({ code, stdout }).toEqual({
    code: 3,
    stdout: `cpu-contention: ${availableParallelism() * 2} spinning threads beside \`${process.execPath} -e process.exit(3)\`\n`,
  })
}, 30_000)
