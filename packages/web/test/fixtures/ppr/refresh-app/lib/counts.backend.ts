/** The count each cart id holds: what its holes show and what its action and writes change. */
export const counts = new Map<string, number>()

export const countOf = (id: string): number => counts.get(id) ?? 0

export const add = (id: string): number => {
  const next = countOf(id) + 1
  counts.set(id, next)
  return next
}
