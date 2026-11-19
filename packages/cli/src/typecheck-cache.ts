import { copyFileSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs"
import { join, resolve } from "node:path"

/** Each invocation writes a private sibling so parallel compilers never read a partial cache. */
export function stageTypecheckCache(cwd: string, tscBin: string, tsconfig: string) {
  const metadata: unknown = JSON.parse(readFileSync(resolve(tscBin, "../../package.json"), "utf8"))
  const version: unknown = Reflect.get(Object(metadata), "version")
  if (typeof version !== "string" || !/^[56]\./.test(version)) return undefined

  const directory = join(cwd, ".nifra", "check")
  const key = Bun.CryptoHasher.hash("sha256", JSON.stringify([tscBin, version, tsconfig]), "hex")
  const filename = join(directory, `${key}.tsbuildinfo`)
  const staged = join(directory, `${key}-${crypto.randomUUID()}.tsbuildinfo`)
  mkdirSync(directory, { recursive: true })
  try {
    copyFileSync(filename, staged)
  } catch (error) {
    if (Reflect.get(Object(error), "code") !== "ENOENT") throw error
  }
  return {
    path: staged,
    finish(publish: boolean): void {
      try {
        if (publish) renameSync(staged, filename)
      } catch (error) {
        // Some compiler exits never produce build info; they still have valid diagnostics.
        if (Reflect.get(Object(error), "code") !== "ENOENT") throw error
      } finally {
        rmSync(staged, { force: true })
      }
    },
  }
}
