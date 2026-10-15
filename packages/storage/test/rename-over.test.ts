import { expect, test } from "bun:test"
import { renameOver } from "../src/file.ts"

const failing = (...codes: readonly string[]) => {
  const calls: string[] = []
  const move = async (from: string, to: string): Promise<void> => {
    calls.push(`${from}->${to}`)
    const code = codes[calls.length - 1]
    if (code !== undefined) throw Object.assign(new Error(code), { code })
  }
  return { calls, move }
}

test("a rename Windows reports busy is retried until it lands", async () => {
  const { calls, move } = failing("EPERM", "EACCES", "EBUSY")
  await renameOver("a.tmp", "a", move, true)
  expect(calls).toHaveLength(4)
})

test("any other error, or a busy one off Windows, is thrown at once", async () => {
  const other = failing("ENOENT")
  await expect(renameOver("a.tmp", "a", other.move, true)).rejects.toThrow("ENOENT")
  expect(other.calls).toHaveLength(1)
  const unix = failing("EPERM")
  await expect(renameOver("a.tmp", "a", unix.move, false)).rejects.toThrow("EPERM")
  expect(unix.calls).toHaveLength(1)
})

test("a target that stays busy fails once the retries run out", async () => {
  const { calls, move } = failing(...Array.from({ length: 20 }, () => "EPERM"))
  await expect(renameOver("a.tmp", "a", move, true)).rejects.toThrow("EPERM")
  expect(calls).toHaveLength(13)
})
