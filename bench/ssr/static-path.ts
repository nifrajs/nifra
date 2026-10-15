/** Map a request path onto a `nifra build --target static` directory, the way a static host does. */
export function staticFileFor(dist: string, pathname: string): string | undefined {
  if (!pathname.startsWith("/") || pathname.includes("..")) return undefined
  return pathname.endsWith("/") ? `${dist}${pathname}index.html` : `${dist}${pathname}`
}
