/**
 * URL-safe output chunk naming. Bun names a code-split chunk after its source file's basename, so a
 * dynamic-route file like `[slug].tsx` emits `[slug]-<hash>.js` — the `[ ]` make a URL a static server
 * (server-bun, CF Pages) reject with 400, so the lazy import fails and the route silently never
 * hydrates (SSR looks perfect; all interactivity is dead). `sanitizeOutputNames` renames every output
 * whose basename isn't URL-path-safe (`[slug]` → `_slug_`) and rewrites the references to it inside the
 * other JS/CSS chunks (where the bootstrap's lazy `import("…/[slug]-hash.js")` lives). The returned
 * unsafe→safe basename map lets the build manifest point at the renamed files.
 */
import { readFileSync, renameSync, writeFileSync } from "node:fs"

const basename = (path: string): string => path.slice(path.lastIndexOf("/") + 1)
const URL_UNSAFE_NAME = /[^A-Za-z0-9._-]/g

export function sanitizeOutputNames(
  outputs: readonly { readonly path: string }[],
): Map<string, string> {
  const renames = new Map<string, string>()
  for (const out of outputs) {
    const base = basename(out.path)
    const safe = base.replace(URL_UNSAFE_NAME, "_")
    if (safe !== base) renames.set(base, safe)
  }
  if (renames.size === 0) return renames
  // The hashed basename is a unique token, so replacing it literally inside the other chunks is safe.
  for (const out of outputs) {
    if (!out.path.endsWith(".js") && !out.path.endsWith(".css")) continue
    let text = readFileSync(out.path, "utf8")
    let changed = false
    for (const [from, to] of renames) {
      if (text.includes(from)) {
        text = text.split(from).join(to)
        changed = true
      }
    }
    if (changed) writeFileSync(out.path, text)
  }
  for (const out of outputs) {
    const safe = renames.get(basename(out.path))
    if (safe !== undefined) {
      renameSync(out.path, out.path.slice(0, out.path.lastIndexOf("/") + 1) + safe)
    }
  }
  return renames
}
