import { expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { serverComponentsPlugin } from "../src/server-components/vite.ts"

test("native client authorization compares Vite and filesystem path spellings", async () => {
  const root = await mkdtemp(join(tmpdir(), "nifra-component-path-"))
  const file = join(root, "Counter.tsx")
  const query = "?nifra-native-client-reference"
  try {
    await writeFile(file, '"use client"; export default function Counter() { return null }')
    await writeFile(join(root, "Counter.props.ts"), "export default {}")
    const plugin = serverComponentsPlugin({ root, adapter: "react" })
    if (typeof plugin.load !== "function" || typeof plugin.resolveId !== "function")
      throw new Error("missing compiler hooks")
    const context = { environment: { name: "rsc" } }
    const viteId = file.replaceAll("\\", "/")
    const filesystemId = viteId.replaceAll("/", "\\")
    expect(Reflect.apply(plugin.load, context, [viteId])).toMatchObject({
      code: expect.any(String),
    })
    expect(await Reflect.apply(plugin.resolveId, context, [filesystemId + query, viteId])).toBe(
      filesystemId + query,
    )
    const browserId = viteId.startsWith("/") ? `/@fs${viteId}` : `/@fs/${viteId}`
    expect(await Reflect.apply(plugin.resolveId, context, [browserId + query, filesystemId])).toBe(
      viteId + query,
    )
    await expect(
      Reflect.apply(plugin.resolveId, context, [filesystemId + query, `${viteId}.other`]),
    ).rejects.toThrow("compiler-owned")
    await expect(
      Reflect.apply(plugin.resolveId, context, [filesystemId + query, undefined]),
    ).rejects.toThrow("compiler-owned")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
