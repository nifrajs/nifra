/**
 * An app's `clientModule` when its config names a first-party file. The browser bundle's generated
 * entry imports it, so the build classifies that file, and everything it imports, as browser code.
 */
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { CONFIG_FILE, FRAMEWORK_FILE } from "./app-files.ts"
import { stripComments } from "./check-scan.ts"
import type { SpecifierResolver } from "./internal/project-specifiers.ts"

const CLIENT_MODULE_EXPORT =
  /\bexport\s+const\s+clientModule\s*(?::\s*string\s*)?=\s*(?:"([^"\\\r\n]*)"|'([^'\\\r\n]*)')/

export interface ClientModuleRoot {
  /** The project-relative config file that names it. */
  readonly config: string
  readonly line: number
  readonly specifier: string
  /** The real path of the file it names. */
  readonly file: string
}

/** The project-relative directory of every app among `files`: one holding a nifra config. */
export function appDirs(files: readonly string[]): string[] {
  const apps = new Set<string>()
  for (const file of files) {
    for (const config of [CONFIG_FILE, FRAMEWORK_FILE]) {
      if (file === config) apps.add("")
      else if (file.endsWith(`/${config}`)) apps.add(file.slice(0, -config.length - 1))
    }
  }
  return [...apps]
}

/**
 * The file `clientModule` names in `app`, read the way the loader reads it: from `nifra.config.ts`
 * when it exists, else `backend/framework.ts`, and a relative path against the app root. `undefined`
 * for a package specifier, a value that is not a string literal, or a path to no file.
 */
export function clientModuleRoot(
  root: string,
  app: string,
  resolve: SpecifierResolver,
): ClientModuleRoot | undefined {
  const config = existsSync(join(root, app, CONFIG_FILE)) ? CONFIG_FILE : FRAMEWORK_FILE
  const path = join(root, app, config)
  if (!existsSync(path)) return undefined
  const text = readFileSync(path, "utf8")
  // `stripComments` keeps offsets, so the match index is a position in `text`.
  const match = CLIENT_MODULE_EXPORT.exec(stripComments(text))
  if (match === null) return undefined
  const specifier = match[1] ?? match[2] ?? ""
  const file = resolve(join(root, app, CONFIG_FILE), specifier)
  if (file === undefined) return undefined
  return {
    config: app === "" ? config : `${app}/${config}`,
    line: text.slice(0, match.index).split("\n").length,
    specifier,
    file,
  }
}
