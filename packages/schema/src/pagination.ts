/**
 * Cursor-pagination runtime helpers — an opaque cursor codec + a page builder. Pair with `t.paginated`
 * (the response schema) and `t.pageQuery` (the request schema).
 *
 * Edge-safe: `btoa`/`atob` + `TextEncoder`/`TextDecoder` (no `Buffer`), so it runs on Bun/Node/Deno/
 * Workers. Cursors are opaque but NOT signed — treat a decoded cursor as untrusted client input: validate
 * its shape before keying a DB query off it (it's a position hint, not an authorization token).
 */

/** UTF-8 → URL-safe base64 (no padding). */
function toBase64Url(input: string): string {
  const bytes = new TextEncoder().encode(input)
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

/** URL-safe base64 → UTF-8. Throws on malformed input (callers below catch it). */
function fromBase64Url(input: string): string {
  const binary = atob(input.replace(/-/g, "+").replace(/_/g, "/"))
  const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

/** Encode any JSON-serializable value (e.g. the last row's sort key) into an opaque cursor string. */
export function encodeCursor(value: unknown): string {
  return toBase64Url(JSON.stringify(value))
}

/** Decode a cursor back to its value. Returns `undefined` for a null/empty/malformed cursor — treat that
 * as "start from the beginning" rather than erroring on a client-supplied string. */
export function decodeCursor<T = unknown>(cursor: string | null | undefined): T | undefined {
  if (cursor === null || cursor === undefined || cursor === "") return undefined
  try {
    return JSON.parse(fromBase64Url(cursor)) as T
  } catch {
    return undefined
  }
}

/** A cursor-pagination page — matches the shape of `t.paginated(item)`. */
export interface Page<Item> {
  readonly items: Item[]
  readonly nextCursor: string | null
}

/**
 * Build a page from rows you fetched with `limit + 1`. If the extra row came back there are more pages:
 * drop it and emit a `nextCursor` from the last KEPT row via `cursorOf`; otherwise `nextCursor` is `null`.
 *
 *   const rows = await db.notes.after(decodeCursor(query.cursor)).take(limit + 1)
 *   return paginate(rows, limit, (note) => note.id)
 */
export function paginate<Row>(
  rows: readonly Row[],
  limit: number,
  cursorOf: (row: Row) => unknown,
): Page<Row> {
  const hasMore = rows.length > limit
  const items = hasMore ? rows.slice(0, limit) : [...rows]
  const last = items[items.length - 1]
  const nextCursor = hasMore && last !== undefined ? encodeCursor(cursorOf(last)) : null
  return { items, nextCursor }
}
