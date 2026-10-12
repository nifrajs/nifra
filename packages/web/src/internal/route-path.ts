/**
 * A route pattern's literal text as a request path spells it. A route file named `café.tsx` is
 * requested as `/caf%C3%A9`, so the routers, which compare the raw request path, are given the pattern
 * that way. Only controls, space and non-ASCII are encoded (what a browser encodes in a path), so ASCII
 * punctuation such as a param constraint keeps its meaning. Runs once per pattern, never per request.
 */
export const requestPattern = (pattern: string): string =>
  pattern.normalize("NFC").replace(/[^!-~]/gu, encodeURIComponent)

// This module also compiles without the DOM lib; at runtime the name is the browser's own global.
declare const location: { readonly origin: string } | undefined

/**
 * An app path as a URL `fetch`, `history` and `location` resolve on this document's own origin. A path
 * starting `//` or `/\` is the path of a page here (`https://shop.example//evil.example/x`), but resolved
 * as written it is a protocol-relative URL to another host, so it is anchored to this origin.
 */
export const appUrl = (path: string): string =>
  path.charCodeAt(0) === 47 /* / */ &&
  (path.charCodeAt(1) === 47 || path.charCodeAt(1) === 92) /* / or \ */ &&
  typeof location !== "undefined" &&
  location.origin !== "null"
    ? location.origin + path
    : path
