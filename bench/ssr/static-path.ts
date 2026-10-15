/** Match the same prerendered document and flattened asset URLs on both runtimes. */
export function staticFileFor(dist: string, pathname: string): string | undefined {
  if (!pathname.startsWith("/") || pathname.includes("..")) return undefined
  if (pathname === "/") return `${dist}/index.html`
  if (pathname.startsWith("/assets/")) {
    const name = pathname.slice("/assets/".length)
    if (name === "" || name.includes("/")) return undefined
    return `${dist}/${name}`
  }
  return `${dist}/${pathname.slice(1)}`
}
