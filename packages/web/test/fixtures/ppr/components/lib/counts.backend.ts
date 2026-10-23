/** The basket counts the fixture's action adds to, by product id. */
const counts = new Map<string, number>()

export const countOf = (id: string): number => counts.get(id) ?? 0

export const add = (id: string): void => {
  counts.set(id, countOf(id) + 1)
}
