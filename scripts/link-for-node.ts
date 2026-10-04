/**
 * Make every workspace package resolvable from the repository root. Runs as the root `postinstall`.
 *
 * `bun install` links into the root `node_modules` only the packages the root declares, so a fresh
 * checkout cannot resolve the rest from the root - not under Node, and not under Bun for root tooling
 * or for the scaffold fixtures that borrow the root `node_modules`. A tree that had once run the Node
 * tests had every link and passed; a fresh clone, CI's included, failed typecheck and test. Linking on
 * install makes the two trees the same.
 *
 * This creates the symlink farm npm/pnpm would have, mapping every publishable workspace package to
 * its directory. Additive and idempotent: it only ever writes inside `node_modules/@nifrajs/` (plus
 * the two unscoped entry points), never rewrites Bun's own layout, and re-running it is a no-op.
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
  // A junction on Windows, where a directory symlink needs a privilege a contributor may not have;
  // other platforms ignore the type.
  await symlink(dir, link, "junction")
}

console.log(`linked ${linkables.length} workspace package(s) into node_modules`)
