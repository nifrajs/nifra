export function islandState(props: Record<string, unknown>) {
  const state = $state({ props })
  return state
}
