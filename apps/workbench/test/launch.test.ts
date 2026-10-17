import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseArgs, rpcServerOptions } from "../src/launch.ts"

const checkout = mkdtempSync(join(tmpdir(), "nifra-workbench-"))
const marker = join(checkout, "imported.txt")
mkdirSync(join(checkout, ".nifra/extensions"), { recursive: true })
writeFileSync(
  join(checkout, ".nifra/extensions/probe.ts"),
  `import { writeFileSync } from "node:fs"
writeFileSync(${JSON.stringify(marker)}, "imported")
export default () => {}
`,
)

afterAll(() => rmSync(checkout, { recursive: true, force: true }))

describe("workbench project extensions", () => {
  test("are not loaded unless the launcher is given --extensions", async () => {
    const options = await rpcServerOptions(parseArgs(["--cwd", checkout]))
    expect(options.extensions).toBeUndefined()
    expect(existsSync(marker)).toBe(false)
  })

  test("--extensions loads them from --cwd", async () => {
    const options = await rpcServerOptions(parseArgs(["--cwd", checkout, "--extensions"]))
    await options.extensions?.reload()
    expect(existsSync(marker)).toBe(true)
  })
})
