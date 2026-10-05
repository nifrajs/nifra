/**
 * The rich-text tag grammar, shared by `rich.ts` and `check.ts` (internal - no package entry exports
 * it). A tag is `<name>`, `</name>` or `<name/>`: an ASCII letter, then letters, digits, `_` or `-`.
 * Anything else (`a < b`, `<3`, `<a href="x">`) is text. Groups: closing slash, name, self-closing slash.
 */
export const TAG_SOURCE = "<(\\/?)([A-Za-z][\\w-]*)\\s*(\\/?)>"
