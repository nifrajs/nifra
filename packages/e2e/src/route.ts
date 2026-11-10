const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** An id, uuid, long hex, timestamp or token-looking value: something that differs per run or per record. */
function varies(part: string): boolean {
  if (/^\d+$/.test(part) || UUID.test(part) || /^[0-9a-f]{16,}$/i.test(part)) return true
  return part.length >= 20 && /\d/.test(part) && /[A-Za-z]/.test(part)
}

/**
 * Where a page is, for deciding whether a recording still starts and ends in the same place: the
 * path and query with id-like parts replaced by `:id`, the origin left out when it is the app's own
 * (the port changes every run), the hash dropped.
 */
export function normalizeRoute(url: string, appOrigin: string): string {
  const target = new URL(url)
  const origin = target.origin === appOrigin ? "" : target.origin
  const path = target.pathname
    .split("/")
    .map((part) => (varies(part) ? ":id" : part))
    .join("/")
  const query = [...target.searchParams.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${varies(value) ? ":id" : value}`)
    .join("&")
  return `${origin}${path}${query === "" ? "" : `?${query}`}`
}
