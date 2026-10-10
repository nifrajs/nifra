// Kept identical to packages/web/src/open-resolved.ts (a web test compares them); this package
// has no dependency through which to share it.
import { constants as FS } from "node:fs"
import { type FileHandle, open, readlink, realpath, stat } from "node:fs/promises"

// Darwin's open(2) flag refusing a symlink in ANY component; `O_NOFOLLOW` covers only the last one.
const O_NOFOLLOW_ANY = 0x20000000
// Deno's node:fs rejects flags it does not know with EINVAL; the first refusal turns the flag off.
let noFollowAny: boolean | undefined

/**
 * Open a name `realpath` already resolved, refusing it when any component became a symlink since.
 * A local writer inside the served tree can swap an intermediate directory for a link after the
 * containment check; `O_NOFOLLOW` alone would follow it. Darwin refuses such a path in the kernel;
 * Linux reads back the name the descriptor holds. Elsewhere, Windows included, no file API can open
 * without following a middle link or name an open descriptor's path, so the check in
 * {@link opensAt} is a platform limit: it narrows the race to repeated swaps but cannot close it.
 */
export async function openResolved(realFile: string): Promise<FileHandle> {
  // Read per open, not at load: this module can sit in a client bundle graph, where `process` is
  // undefined.
  if (noFollowAny ?? process.platform === "darwin") {
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

/** Whether `handle` is the file at `realFile` with no symlink in its path. */
export async function opensAt(
  handle: Pick<FileHandle, "fd" | "stat">,
  realFile: string,
): Promise<boolean> {
  try {
    return (await readlink(`/proc/self/fd/${handle.fd}`)) === realFile
  } catch {
    return sameFileAt(handle, realFile)
  }
}

/**
 * {@link opensAt} where no descriptor's path can be read. Exported for its test, which runs it on
 * every host.
 */
export async function sameFileAt(
  handle: Pick<FileHandle, "stat">,
  realFile: string,
): Promise<boolean> {
  // One step after another, so passing takes a swap back and a swap again between steps: the name
  // resolves to itself, then to the opened file, then to itself again. Identities are compared as
  // bigints because a Windows file index can exceed 2^53.
  if ((await realpath(realFile)) !== realFile) return false
  const opened = await handle.stat({ bigint: true })
  const named = await stat(realFile, { bigint: true })
  if (opened.dev !== named.dev || opened.ino !== named.ino) return false
  return (await realpath(realFile)) === realFile
}
