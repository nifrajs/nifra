/** `path` with `\` separators turned into `/`, for keys and output that must not depend on the OS. */
export function toPosix(path: string): string {
  return path.replaceAll("\\", "/")
}
