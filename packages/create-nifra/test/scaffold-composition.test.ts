import { expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { NIFRA_DEP_RANGE } from "../src/scaffold/frameworks.ts"

/**
 * A scaffolded app must install the release it was scaffolded by.
 *
 * The release script used to regex-sweep `@nifrajs/*` pins across eight `package.json` files with
 * nothing verifying the result, and its own comment warned that a missed bump ships templates that
 * install the PREVIOUS release. A site's manifest is generated from one constant now, and this is what
 * turns that footgun into a red build.
 *
 * The rest of this file used to compare a composed site against the `template-site-<framework>`
 * directory it replaced. That comparison licensed deleting those directories and went with them;
 * `scaffold-snapshot.test.ts` is the ongoing net, and `scaffold-check.test.ts` grades the composed
 * output for the properties that actually matter.
 */
test("the scaffold's Nifra range matches the version being published", async () => {
  const core = JSON.parse(
    await readFile(join(import.meta.dir, "..", "..", "core", "package.json"), "utf8"),
  ) as { version: string }
  expect(NIFRA_DEP_RANGE).toBe(`^${core.version}`)
})
