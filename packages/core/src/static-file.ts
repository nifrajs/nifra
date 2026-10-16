/**
 * What a file served from disk is typed as, and which files are never served - the shared owner for
 * every static-file surface.
 *
 * `@nifrajs/web`'s `servePublicDir` (dev, the Bun entry, the Deno entry's embedded table) and
 * `@nifrajs/node`'s `static` reader (the Node entry) answer the same deployed files. Two copies that
 * drift serve a `.pdf` as a download on one runtime and inline on the other, or a `.well-known` file
 * on one and a 404 on the other, so both read this module. The Node adapter runs a generated copy
 * (scripts/gen-node-outcome.ts), so this module imports nothing.
 */

/**
 * Media types by extension. A table rather than the runtime's own file typing, which Node and Deno
 * lack. Unknown extensions, and extensionless files such as ACME tokens, are
 * `application/octet-stream`, which together with `nosniff` keeps a browser from guessing a more
 * dangerous type.
 */
export const CONTENT_TYPES: Readonly<Record<string, string>> = Object.freeze({
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".cjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".xml": "application/xml",
  ".rss": "application/rss+xml",
  ".atom": "application/atom+xml",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".bmp": "image/bmp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".wasm": "application/wasm",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".ogg": "audio/ogg",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".vtt": "text/vtt; charset=utf-8",
})

/** The media type for a file path or name by its extension, case-insensitively. */
export function contentTypeOf(path: string): string {
  const dot = path.lastIndexOf(".")
  // A dot before the last separator belongs to a directory; a leading dot names a dotfile, not a type.
  const name = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1
  if (dot <= name) return "application/octet-stream"
  return CONTENT_TYPES[path.slice(dot).toLowerCase()] ?? "application/octet-stream"
}

/**
 * Whether a relative path crosses a dot-segment other than `.well-known` (RFC 8615, public by
 * definition). Serving, the build's `public/` copy and the parity listing all apply it, so an editor
 * or VCS artifact (`.env`, `.git/`, `.DS_Store`) is neither served nor shipped. Both separators split:
 * a request path uses `/`, a relative file path the OS separator.
 */
export function isHiddenPath(rel: string): boolean {
  for (const segment of rel.split(/[\\/]/)) {
    if (segment.charCodeAt(0) === 46 /* '.' */ && segment !== ".well-known") return true
  }
  return false
}
