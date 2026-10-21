/** Option checks `live()` and `liveHub()` share: an app and its hub must read the same options alike. */

export const DEFAULT_TTL_SECONDS = 600
export const DEFAULT_MAX_SOCKETS = 10_000
export const DEFAULT_RELOAD_RATE = 500
export const DEFAULT_APP_ID = "nifra"

export function positive(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new TypeError(`[nifra/web] live: \`${name}\` must be a positive whole number`)
  }
  return resolved
}

export function grantTtlOf(value: number | undefined): number {
  const ttl = value ?? DEFAULT_TTL_SECONDS
  if (!Number.isSafeInteger(ttl) || ttl < 60 || ttl > 86_400) {
    throw new TypeError(
      "[nifra/web] live: `grantTtl` must be a whole number of seconds from 60 to 86400",
    )
  }
  return ttl
}

export function spreadFloorOf(value: number | undefined): number {
  const floor = value ?? 0
  if (!Number.isSafeInteger(floor) || floor < 0 || floor > 5000) {
    throw new TypeError("[nifra/web] live: `spreadFloor` must be a whole number of ms up to 5000")
  }
  return floor
}

export function appIdOf(value: string | undefined): string {
  const appId = value ?? DEFAULT_APP_ID
  if (typeof appId !== "string" || appId === "" || appId.length > 128) {
    throw new TypeError(
      "[nifra/web] live: `appId` must be a non-empty string of at most 128 characters",
    )
  }
  return appId
}
