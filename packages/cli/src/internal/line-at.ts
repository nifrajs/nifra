/** The 1-based line holding `index` in `content`. */
export function lineAt(content: string, index: number): number {
  return content.slice(0, index).split("\n").length
}
