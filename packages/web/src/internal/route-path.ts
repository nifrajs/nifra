/**
 * A route pattern's literal text as a request path spells it. A route file named `café.tsx` is
 * requested as `/caf%C3%A9`, so the routers, which compare the raw request path, are given the pattern
 * that way. Only controls, space and non-ASCII are encoded (what a browser encodes in a path), so ASCII
 * punctuation such as a param constraint keeps its meaning. Runs once per pattern, never per request.
 */
export const requestPattern = (pattern: string): string =>
  pattern.normalize("NFC").replace(/[^!-~]/gu, encodeURIComponent)
