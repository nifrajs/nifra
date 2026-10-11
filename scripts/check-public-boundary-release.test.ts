import { expect, test } from "bun:test"
import { join } from "node:path"

const GATE = join(import.meta.dir, "check-public-boundary-release.ts")

async function run(markers: string | undefined): Promise<{ code: number; stderr: string }> {
  const env: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" }
  if (markers !== undefined) env.PRIVATE_MARKERS = markers
  const child = Bun.spawn([process.execPath, "run", GATE], { env, stdout: "pipe", stderr: "pipe" })
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
  return { code, stderr }
}

test("release verification refuses to run without private markers", async () => {
  for (const markers of [undefined, "", " , ,"]) {
    const { code, stderr } = await run(markers)
    expect({ markers, code }).toEqual({ markers, code: 1 })
    expect(stderr).toContain("PRIVATE_MARKERS is required for release verification")
  }
}, 30_000)
