/**
 * A JS string literal for embedding a runtime value in GENERATED source. `JSON.stringify` alone is
 * not a code sanitizer: its output can still contain `<` (so a value holding `</script>` breaks out
 * of an inline-script embedding of the generated code) and the U+2028/U+2029 line separators (legal
 * inside JSON strings, line terminators to pre-ES2019 parsers). Escape all three so the emitted
 * literal is inert in every context the generated source can land in.
 */

// Built with fromCharCode so this file stays pure ASCII - a literal U+2028/U+2029 in source is
// invisible in review and one save-with-normalization away from silently vanishing.
const LINE_SEPARATOR = String.fromCharCode(0x2028)
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029)

export function jsStringLiteral(value: string): string {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003C")
    .replaceAll(LINE_SEPARATOR, "\\u2028")
    .replaceAll(PARAGRAPH_SEPARATOR, "\\u2029")
}
