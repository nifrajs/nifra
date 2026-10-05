/** Resolve only a declared target inside the island or component that owns the calling node. */
export function componentPortalTarget(source: Element, target: Element): Element {
  const owner = source.closest("[data-nifra-island], [data-nifra-component]")
  const name = target.getAttribute("data-nifra-portal")
  if (
    owner === null ||
    name === null ||
    !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name) ||
    !owner.contains(target) ||
    target.closest("[data-nifra-island], [data-nifra-component]") !== owner
  )
    throw new Error("component_contract")
  return target
}

const cleanups = new WeakMap<Element, Set<() => Promise<void>>>()

/** Native portal actions register cleanup with the island that owns their target. */
export function ownComponentPortal(
  source: Element,
  target: Element,
  cleanup: () => void | Promise<void>,
): () => Promise<void> {
  componentPortalTarget(source, target)
  const owner = source.closest("[data-nifra-island], [data-nifra-component]")!
  const entries = cleanups.get(owner) ?? new Set<() => Promise<void>>()
  let pending: Promise<void> | undefined
  const dispose = () => {
    entries.delete(dispose)
    pending ??= Promise.resolve().then(cleanup)
    return pending
  }
  entries.add(dispose)
  cleanups.set(owner, entries)
  return dispose
}

export async function disposeComponentPortals(owner: Element): Promise<void> {
  const entries = cleanups.get(owner)
  cleanups.delete(owner)
  if (entries !== undefined) await Promise.all([...entries].map((cleanup) => cleanup()))
}
