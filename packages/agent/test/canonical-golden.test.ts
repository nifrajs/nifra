import { expect, test } from "bun:test"
import { composeDescriptor, composeRegistrySnapshot } from "../src/registry.ts"

// Registry digests are published and compared across boots, so their bytes are pinned literally.
test("a descriptor's schema digest and the snapshot digest are pinned", async () => {
  const descriptor = await composeDescriptor({
    kind: "tool",
    name: "alpha",
    inputSchema: { b: [2, { d: null, c: "\u00e9" }], a: 1, omitted: undefined },
  })
  expect(descriptor.schemaDigest).toBe(
    "4ef06c6436bffc91583e5acdec283e4b431eca3b12eee6c9bbcd49081966c5e7",
  )
  expect((await composeRegistrySnapshot([descriptor])).digest).toBe(
    "f97b6cafef280030541458386e8083dfe1d988668f5e77d658b694de042a2b60",
  )
})
