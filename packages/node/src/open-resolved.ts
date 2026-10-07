// Kept identical to packages/web/src/open-resolved.ts (a web test compares them); this package
// has no dependency through which to share it.
import { constants as FS } from "node:fs"
import { type FileHandle, open, readlink, realpath, stat } from "node:fs/promises"

// Darwin's open(2) flag refusing a symlink in ANY component; `O_NOFOLLOW` covers only the last one.
const O_NOFOLLOW_ANY = 0x20000000
// Deno's node:fs rejects flags it does not know with EINVAL; the first refusal turns the flag off.
// Read on first use: this module can sit in a client bundle graph, where `process` is undefined.
let noFollowAny: boolean | undefined

/**
 * Open a name `realpath` already resolved, refusing it when any component became a symlink since.
 * A local writer inside the served tree can swap an intermediate directory for a link after the
 * containment check; `O_NOFOLLOW` alone would follow it. Darwin refuses such a path in the kernel;
 * Linux reads back the name the descriptor holds. Elsewhere the opened file's identity is compared
 * with a fresh resolution, which narrows the window but cannot close it.
 */
export async function openResolved(realFile: string): Promise<FileHandle> {
  noFollowAny ??= process.platform === "darwin"
  if (noFollowAny) {
    try {
      return await open(realFile, FS.O_RDONLY | O_NOFOLLOW_ANY)
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EINVAL")) throw error
      noFollowAny = false
    }
  }
  const handle = await open(realFile, FS.O_RDONLY | FS.O_NOFOLLOW)
  try {
    if (await opensAt(handle, realFile)) return handle
  } catch {}
  await handle.close()
  throw Object.assign(new Error(`${realFile} moved while it was opened`), { code: "ELOOP" })
}

async function opensAt(handle: FileHandle, realFile: string): Promise<boolean> {
  const held = await readlink(`/proc/self/fd/${handle.fd}`).catch(() => undefined)
  if (held !== undefined) return held === realFile
  const [opened, named, again] = await Promise.all([
    handle.stat(),
    stat(realFile),
    realpath(realFile),
  ])
  return again === realFile && opened.dev === named.dev && opened.ino === named.ino
}
