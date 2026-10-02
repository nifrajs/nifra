/**
 * The app's deploy target as `nifra.config.ts` declares it (`export const target = "bun"`), read and
 * rewritten as text: `nifra port` and `nifra doctor` never run app code, and `nifra target <t>` edits
 * one line of a file the developer owns.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { CONFIG_FILE } from "./app-files.ts"
import { stripComments } from "./check-scan.ts"

const TARGET_EXPORT = /\bexport\s+const\s+target\b[^=\n]*=\s*(["'])([^"'\n]*)\1/

/** The `target` string `nifra.config.ts` exports, or `undefined` when it exports none. */
export function readConfigTarget(appRoot: string): string | undefined {
  const path = join(appRoot, CONFIG_FILE)
  if (!existsSync(path)) return undefined
  return TARGET_EXPORT.exec(stripComments(readFileSync(path, "utf8")))?.[2]
}

/**
 * Point `nifra.config.ts` at `target`: rewrite its `target` export, or append one. Returns the previous
 * value. Throws when the app has no `nifra.config.ts`.
 */
export function writeConfigTarget(appRoot: string, target: string): string | undefined {
  const path = join(appRoot, CONFIG_FILE)
  if (!existsSync(path)) {
    throw new Error(
      `[nifra] no ${CONFIG_FILE} in ${appRoot} - \`nifra target\` sets its \`target\``,
    )
  }
  const text = readFileSync(path, "utf8")
  // Matched on the comment-blanked text, whose offsets are the original's, so a commented-out
  // `target` line is never the one rewritten.
  const found = TARGET_EXPORT.exec(stripComments(text))
  const previous = found?.[2]
  let next: string
  if (found === null) {
    next = `${text.replace(/\n*$/, "\n")}\n// The deploy target \`nifra build\` emits; \`nifra target <t>\` switches it.\nexport const target = "${target}"\n`
  } else {
    // Only the quoted value changes, so a type annotation on the export survives.
    const end = found.index + found[0].length
    const start = end - (previous ?? "").length - 2
    next = `${text.slice(0, start)}"${target}"${text.slice(end)}`
  }
  writeFileSync(path, next)
  return previous
}
