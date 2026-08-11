import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"

/**
 * A test-only filesystem seam. Every suite gets a unique parent and every logical project can get a
 * unique child, so parallel test files cannot observe or delete one another's generated artifacts.
 */
export function createFixtureRoot(prefix: string): string {
  // Keep fixtures below the package test directory so Bun's upward module resolution can still find
  // the workspace's @nifrajs links. The random suffix from mkdtempSync provides isolation.
  return mkdtempSync(join(import.meta.dir, `.${prefix}`))
}

/** Create a unique project directory below a suite-owned parent. */
export function createFixtureProject(parent: string, prefix: string): string {
  return mkdtempSync(join(parent, prefix))
}

/** Remove a suite-owned root and all child projects. */
export function removeFixtureRoot(root: string): void {
  rmSync(root, { recursive: true, force: true })
}
