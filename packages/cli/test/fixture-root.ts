import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

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

/**
 * Remove a directory a killed tool may still hold. On Windows its child processes (a killed `go`
 * leaves `compile` running) keep their handles for a moment, and removal fails with EBUSY until then.
 */
export async function removeReleasedDirectory(
  directory: string,
  remove: (directory: string) => void = (path) => rmSync(path, { recursive: true, force: true }),
): Promise<void> {
  const deadline = Date.now() + 10_000
  for (;;) {
    try {
      remove(directory)
      return
    } catch (error) {
      const code = error instanceof Error ? Reflect.get(error, "code") : undefined
      const held = code === "EBUSY" || code === "EPERM" || code === "EACCES" || code === "ENOTEMPTY"
      if (!held || Date.now() >= deadline) throw error
      await Bun.sleep(100)
    }
  }
}

/** Write a fixture file at an app-relative path (`backend/app.ts`), creating its directory. */
export function writeAppFile(root: string, path: string, content: string): string {
  const file = join(root, path)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, content)
  return file
}

/** A minimal tsconfig.json, so `nifra check` typechecks a fixture's TypeScript instead of failing it. */
export const FIXTURE_TSCONFIG = JSON.stringify({
  compilerOptions: {
    module: "preserve",
    moduleResolution: "bundler",
    allowImportingTsExtensions: true,
    noEmit: true,
    skipLibCheck: true,
    target: "esnext",
  },
})
