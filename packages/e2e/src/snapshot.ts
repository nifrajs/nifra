export const INTERACTIVE =
  /^\s*- (?:button|link|textbox|searchbox|checkbox|radio|combobox|listbox|option|tab|menuitem|switch|slider|spinbutton|heading|dialog|alertdialog|alert|status)\b/

/**
 * Fit a snapshot into `maxChars`: long lines are shortened, and when the whole is still too long the
 * controls and headings are kept first and the rest fills the room that is left, in page order.
 * Dropped runs are marked, so the model knows the page goes on.
 */
export function pruneSnapshot(snapshot: string, maxChars: number, maxLine = 240): string {
  const lines = snapshot
    .split("\n")
    .map((line) => (line.length > maxLine ? `${line.slice(0, maxLine - 1)}…` : line))
  if (lines.reduce((total, line) => total + line.length + 1, 0) <= maxChars) return lines.join("\n")

  const keep = new Set<number>()
  let used = 0
  const take = (index: number, line: string): void => {
    const cost = line.length + 1
    if (used + cost > maxChars) return
    keep.add(index)
    used += cost
  }
  lines.forEach((line, index) => {
    if (INTERACTIVE.test(line)) take(index, line)
  })
  lines.forEach((line, index) => {
    if (!keep.has(index)) take(index, line)
  })

  const out: string[] = []
  let omitted = 0
  const flush = (): void => {
    if (omitted > 0) out.push(`  … (${omitted} lines omitted)`)
    omitted = 0
  }
  lines.forEach((line, index) => {
    if (keep.has(index)) {
      flush()
      out.push(line)
    } else {
      omitted += 1
    }
  })
  flush()
  return out.join("\n")
}
