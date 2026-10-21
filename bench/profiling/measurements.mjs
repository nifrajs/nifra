export function parseOha(raw, count) {
  const data = JSON.parse(raw)
  const statuses = data.statusCodeDistribution
  const timing = [
    data.summary?.requestsPerSec,
    data.latencyPercentiles?.p50,
    data.latencyPercentiles?.p99,
  ]
  if (
    data.summary?.successRate !== 1 ||
    statuses?.["200"] !== count ||
    Object.keys(statuses).length !== 1 ||
    Object.keys(data.errorDistribution ?? {}).length > 0 ||
    !timing.every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0) ||
    timing[0] === 0
  )
    throw new Error("incomplete, non-200, or invalid oha measurement")
  return { rps: timing[0], p50ms: timing[1] * 1000, p99ms: timing[2] * 1000, completed: count }
}

export function summarize(profile, mode) {
  if (!profile) return undefined
  const totals = new Map()
  const label = (f) => `${f.functionName || "(anonymous)"} ${f.url}:${f.lineNumber + 1}`
  if (mode === "heap") {
    function walk(node) {
      const frame = label(node.callFrame)
      totals.set(frame, (totals.get(frame) ?? 0) + node.selfSize)
      for (const child of node.children ?? []) walk(child)
    }
    walk(profile.head)
  } else {
    const nodes = new Map(profile.nodes.map((n) => [n.id, n]))
    for (let i = 0; i < profile.samples.length; i++) {
      const f = nodes.get(profile.samples[i]).callFrame
      // Exclude inspector control work as well as idle time from the attribution denominator.
      if (
        ["(idle)", "(program)", "(root)"].includes(f.functionName) ||
        f.url.startsWith("node:inspector")
      )
        continue
      const frame = label(f)
      totals.set(frame, (totals.get(frame) ?? 0) + (profile.timeDeltas?.[i] ?? 1))
    }
  }
  const total = [...totals.values()].reduce((sum, n) => sum + n, 0)
  return {
    total,
    top: [...totals]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 25)
      .map(([frame, value]) => ({ frame, value, share: total === 0 ? 0 : value / total })),
  }
}
