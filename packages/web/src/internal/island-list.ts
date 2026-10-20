import { effect, untrack } from "./island-signals.ts"

/** The node surface `bindList` uses; an `Element` has it. */
export interface ListNode {
  remove(): void
}

/** The container surface `bindList` uses; an `Element` has it. */
export interface ListContainer<E extends ListNode> {
  replaceChildren(...nodes: E[]): void
  insertBefore(node: E, before: E | null): unknown
}

/** How `bindList` turns items into keyed DOM. */
export interface BindListOptions<T, E extends ListNode = HTMLElement> {
  /** Stable and unique per item - never the array index, or a removal reuses the wrong node. */
  key(item: T): string | number
  create(item: T): E
  /** Brings a node in line with its item: runs after `create` and on every later change. */
  update?(el: E, item: T): void
}

/**
 * Render a list signal (or any getter) into `container` with keyed reconciliation. A surviving item
 * keeps its node, so focus, selection and input state survive a reorder. A render with no earlier
 * nodes replaces the container's children; later renders move only the nodes outside the longest
 * run already in order. `key`, `create` and `update` run untracked: a signal they read does not
 * re-render the list. Returns the disposer; inside an island the binding also stops on unmount.
 */
export function bindList<T, E extends ListNode = HTMLElement>(
  source: () => readonly T[],
  container: ListContainer<E>,
  options: BindListOptions<T, E>,
): () => void {
  let nodes = new Map<string | number, E>()
  // Each node's position in the last render; empty until a render leaves nodes to keep.
  let at = new Map<E, number>()
  return effect(() => {
    const items = source()
    untrack(() => {
      const next = new Map<string | number, E>()
      for (const item of items) {
        const key = options.key(item)
        if (next.has(key)) console.warn("[nifra/islands] bindList: duplicate key skipped", key)
        else {
          const el = nodes.get(key) ?? options.create(item)
          options.update?.(el, item)
          next.set(key, el)
        }
      }
      const els = [...next.values()]
      if (at.size === 0) container.replaceChildren(...els)
      else {
        for (const [key, el] of nodes) if (!next.has(key)) el.remove()
        const stays = inOrder(els.map((el) => at.get(el) ?? -1))
        let anchor: E | null = null
        for (let i = els.length - 1; i >= 0; i--) {
          const el = els[i]
          if (el === undefined) continue
          if (!stays.has(i)) container.insertBefore(el, anchor)
          anchor = el
        }
      }
      at = new Map(els.map((el, i) => [el, i]))
      nodes = next
    })
  })
}

// The indexes of `old` (each node's previous position, -1 for a new node) on a longest increasing
// run: those nodes already sit in order, and every other node is moved.
function inOrder(old: readonly number[]): Set<number> {
  // tails[n] is the index ending the best run of length n + 1; back links each run.
  const tails: number[] = []
  const back: number[] = []
  old.forEach((o, i) => {
    if (o < 0) return
    let lo = 0
    let hi = tails.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if ((old[tails[mid] ?? 0] ?? 0) < o) lo = mid + 1
      else hi = mid
    }
    back[i] = tails[lo - 1] ?? -1
    tails[lo] = i
  })
  const stays = new Set<number>()
  for (let i = tails.at(-1) ?? -1; i >= 0; i = back[i] ?? -1) stays.add(i)
  return stays
}
