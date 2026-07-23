/**
 * Make the workspace resolvable to NON-Bun tools.
 *
 * Bun resolves workspace packages through its own internal map and writes no `node_modules/@nifrajs/*`
 * entries to disk, so after `bun install` the tree is fully functional under Bun and completely
 * unresolvable under Node - `import "@nifrajs/core"` throws ERR_MODULE_NOT_FOUND. That is invisible
 * day to day and is exactly why the Node adapter had no Node-side coverage: the runtime it targets
 * could not even load it from this checkout.
 *
 * This creates the symlink farm npm/pnpm would have, mapping every publishable workspace package to
 * its directory. Additive and idempotent: it only ever writes inside `node_modules/@nifrajs/` (plus
 * the two unscoped entry points), never rewrites Bun's own layout, and re-running it is a no-op.
 *
 * `bun install --linker=isolated` produces the same reachability, but it rewrites the whole tree -
 * a heavy, surprising side effect for a test step whose only requirement is "Node can find these".
 */

import { mkdir, symlink, unlink } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { Glob } from "bun"

const ROOT = resolve(import.meta.dir, "..")

interface Linkable {
  readonly name: string
  readonly dir: string
}

const linkables: Linkable[] = []
for (const manifest of await Array.fromAsync(new Glob("packages/*/package.json").scan(ROOT))) {
  const dir = resolve(ROOT, dirname(manifest))
  const pkg = JSON.parse(await Bun.file(resolve(ROOT, manifest)).text()) as {
    name?: string
    private?: boolean
  }
  if (pkg.name === undefined || pkg.private === true) continue
  linkables.push({ name: pkg.name, dir })
}

await mkdir(resolve(ROOT, "node_modules/@nifrajs"), { recursive: true })
for (const { name, dir } of linkables) {
  const link = resolve(ROOT, "node_modules", name)
  await mkdir(dirname(link), { recursive: true })
  // Replace rather than skip: a stale link from a renamed or moved package would otherwise survive
  // and resolve to the wrong directory, which is worse than not being linked at all.
  await unlink(link).catch(() => {})
  await symlink(dir, link, "dir")
}

console.log(
  `linked ${linkables.length} workspace package(s) into node_modules for non-Bun runtimes`,
)
