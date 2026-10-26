const INHERITED: readonly string[] = ["PATH", "HOME", "LANG", "LC_ALL", "TERM", "CI"]
const INHERITED_ON_WINDOWS: readonly string[] = [
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

function readEnv(name: string): string | undefined {
  const exact = process.env[name]
  if (exact !== undefined || process.platform !== "win32") return exact
  const key = Object.keys(process.env).find(
    (candidate) => candidate.toLowerCase() === name.toLowerCase(),
  )
  return key === undefined ? undefined : process.env[key]
}

/**
 * The environment a child process gets: an allowlist of the parent's variables, then `overrides`, where
 * a name set to `undefined` is left out.
 */
export function safeEnv(
  overrides?: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const names = new Set(
    process.platform === "win32" ? [...INHERITED, ...INHERITED_ON_WINDOWS] : INHERITED,
  )
  for (const name of Object.keys(overrides ?? {})) names.add(name)
  const result: Record<string, string> = {}
  for (const name of names) {
    const value =
      overrides !== undefined && Object.hasOwn(overrides, name) ? overrides[name] : readEnv(name)
    if (value !== undefined) result[name] = value
  }
  return result
}
