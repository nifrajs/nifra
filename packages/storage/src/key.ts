/**
 * Storage-key safety. A key is a POSIX-ish relative path (`avatars/u1.png`); we reject anything that
 * could escape a `FileStorage` root or otherwise misbehave - absolute paths, `..` traversal, NUL bytes,
 * backslashes (Windows traversal), and empty or `.` segments (aliases on a file system). Enforced by EVERY adapter (not just `FileStorage`) so a key is
 * portable across them, and so the check can't be forgotten on the one adapter where it's a vulnerability.
 */

export class StorageKeyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "StorageKeyError"
  }
}

/** Throw {@link StorageKeyError} unless `key` is a safe relative storage key. */
export function assertSafeKey(key: string): void {
  if (key.length === 0 || key.length > 1024) {
    throw new StorageKeyError(`storage key must be 1-1024 chars (got ${key.length})`)
  }
  if (key.startsWith("/") || key.includes("\\") || key.includes("\0")) {
    throw new StorageKeyError(
      `unsafe storage key ${JSON.stringify(key)} (absolute, backslash, or NUL)`,
    )
  }
  for (const segment of key.split("/")) {
    if (segment === "..") {
      throw new StorageKeyError(`unsafe storage key ${JSON.stringify(key)} (".." path traversal)`)
    }
    // A file system reads `a/./b`, `a//b` and `a/b/` as `a/b`, and an object store does not - so one
    // backend would alias two keys another keeps apart.
    if (segment === "" || segment === ".") {
      throw new StorageKeyError(
        `unsafe storage key ${JSON.stringify(key)} (an empty or "." segment aliases another key)`,
      )
    }
  }
}
