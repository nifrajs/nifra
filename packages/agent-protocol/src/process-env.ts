/**
 * The environment a host hands a process it spawns: an agent CLI, a model backend, an extension
 * worker. The child gets no ambient environment, only the variables it needs to start, the names
 * its adapter adds, and the values the caller passes.
 *
 * Both functions take the platform and the host environment as arguments, so the Windows set is
 * decided by the caller and can be checked on any machine. Node, Bun and Deno read `process.env`
 * case-insensitively on Windows, so a lookup by the canonical name finds `Path` as `PATH`.
 */

const POSIX_BASE_ENV: readonly string[] = ["PATH", "HOME", "LANG", "LC_ALL", "TERM"]

const WINDOWS_BASE_ENV: readonly string[] = [
  ...POSIX_BASE_ENV,
  "SystemRoot",
  "WINDIR",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "LOCALAPPDATA",
  "APPDATA",
  "COMSPEC",
  "PATHEXT",
  "BUN_INSTALL",
  "HOMEDRIVE",
  "HOMEPATH",
  "USERNAME",
  "USERDOMAIN",
  "ProgramData",
  "ProgramFiles",
  "ProgramFiles(x86)",
]

/** What a spawned process needs to start on `platform`. None of it is a credential. */
export function childProcessBaseEnv(platform: string): readonly string[] {
  return platform === "win32" ? WINDOWS_BASE_ENV : POSIX_BASE_ENV
}

export interface ChildProcessEnvInput {
  /** The host's environment, usually `process.env`. */
  readonly env: Readonly<Record<string, string | undefined>>
  /** The host's platform, usually `process.platform`. */
  readonly platform: string
  /** Names read from `env` besides the base set. */
  readonly names?: readonly string[]
  /** Values that win over `env`. A name set to `undefined` here is left out. */
  readonly values?: Readonly<Record<string, string | undefined>> | undefined
}

/**
 * The environment for a spawned process: the {@link childProcessBaseEnv} names and `names`, read
 * from `env`, with `values` over them. A name with no value is left out.
 */
export function childProcessEnv(input: ChildProcessEnvInput): Record<string, string> {
  const { env, values } = input
  const names = new Set([
    ...childProcessBaseEnv(input.platform),
    ...(input.names ?? []),
    ...(values === undefined ? [] : Object.keys(values)),
  ])
  const result: Record<string, string> = {}
  for (const name of names) {
    const value = values !== undefined && Object.hasOwn(values, name) ? values[name] : env[name]
    if (value !== undefined) result[name] = value
  }
  return result
}
