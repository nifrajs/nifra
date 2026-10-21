/** The poll's tally, in memory, so one process only. A real app reads and writes its database here. */

export type Choice = "bun" | "deno" | "node"

const tally: Record<Choice, number> = { bun: 0, deno: 0, node: 0 }
let lastVoteAt: number | null = null

export function votes(): Record<Choice, number> {
  return { ...tally }
}

export function vote(choice: Choice): void {
  tally[choice] += 1
  lastVoteAt = Date.now()
}

export function lastVote(): { readonly at: number | null } {
  return { at: lastVoteAt }
}
