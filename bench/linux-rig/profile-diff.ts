/**
 * Diff two V8 .cpuprofile files by self-time share.
 *
 * The ablation ladder says WHICH rung a cost sits in; this says which frames the step between two
 * adjacent rungs is made of. Profiling both rungs identically and comparing self-time SHARES (not
 * absolute samples - the profiler compresses throughput, and the two runs serve different request
 * counts) leaves only what the added stage does.
 *
 *   bun run bench/linux-rig/profile-diff.ts prof/nifra-corsnoop.cpuprofile prof/nifra-cors1.cpuprofile
 *
 * Prints the frames whose share GREW most from the baseline to the target - the added stage's
 * actual cost centres - then the same for frames that shrank, as a sanity check that the two runs
 * are otherwise comparable.
 *
 * Call-tree mode attributes a frame that self-time cannot: microtask and async-context frames sit
 * at the top of their own stacks, so their COST shows up but their CAUSE does not. For each node
 * matching the given substrings this prints the aggregated ancestor chains (who was on the stack
 * when it ran) and the aggregated descendant frames (which callbacks executed inside it - for
 * processTicksAndRejections, that is the .then continuations, i.e. the promise's creator).
 *
 *   bun run bench/linux-rig/profile-diff.ts --tree prof/nifra-bare.cpuprofile [frameSubstring...]
 */
interface CallFrame {
  readonly functionName: string
  readonly url: string
  readonly lineNumber: number
}
interface ProfileNode {
  readonly id: number
  readonly callFrame: CallFrame
  readonly hitCount?: number
  readonly children?: ReadonlyArray<number>
}
interface CpuProfile {
  readonly nodes: ReadonlyArray<ProfileNode>
  readonly samples?: ReadonlyArray<number>
}

const argv = process.argv.slice(2)
const treeMode = argv[0] === "--tree"
if (treeMode) argv.shift()
const [basePath, targetPath] = argv
if (basePath === undefined) {
  throw new Error(
    "usage: bun run profile-diff.ts <baseline.cpuprofile> [target.cpuprofile]\n" +
      "  one file  -> top self-time frames, as a share of NON-IDLE samples\n" +
      "  two files -> per-frame share delta from baseline to target\n" +
      "  --tree <file.cpuprofile> [frameSubstring...] -> ancestor chains + descendant\n" +
      "  breakdown for every node whose label matches (default: processTicksAndRejections,\n" +
      "  async_context_frame)",
  )
}

/** functionName + a short file:line tag, so two same-named closures stay distinguishable. */
function labelOf(frame: CallFrame): string {
  const file = frame.url.split("/").pop() ?? frame.url
  const name = frame.functionName === "" ? "(anonymous)" : frame.functionName
  return frame.url === "" ? `${name} [native]` : `${name} @ ${file}:${frame.lineNumber + 1}`
}

/** Self-time share per frame label, normalized to the profile's total samples. */
async function sharesOf(
  path: string,
  exclude?: ReadonlySet<string>,
): Promise<{ shares: Map<string, number>; total: number }> {
  const profile = (await Bun.file(path).json()) as CpuProfile
  const byLabel = new Map<string, number>()
  let total = 0
  for (const node of profile.nodes) {
    const hits = node.hitCount ?? 0
    if (hits === 0) continue
    const label = labelOf(node.callFrame)
    if (exclude?.has(label)) continue
    total += hits
    byLabel.set(label, (byLabel.get(label) ?? 0) + hits)
  }
  const shares = new Map<string, number>()
  for (const [label, hits] of byLabel) shares.set(label, (hits / total) * 100)
  return { shares, total }
}

// Idle samples are the profiler watching the event loop wait for the next request; including them
// makes every share a function of load rather than of the code, and makes two profiles taken at
// different throughputs incomparable. Everything below is a share of CPU actually spent.
const IDLE = new Set(["(idle) [native]", "(program) [native]"])

if (treeMode) {
  const patterns = argv.slice(1)
  const targets =
    patterns.length > 0 ? patterns : ["processTicksAndRejections", "async_context_frame"]
  const profile = (await Bun.file(basePath).json()) as CpuProfile

  const byId = new Map<number, ProfileNode>()
  const parentOf = new Map<number, number>()
  let nonIdle = 0
  for (const node of profile.nodes) {
    byId.set(node.id, node)
    if (!IDLE.has(labelOf(node.callFrame))) nonIdle += node.hitCount ?? 0
    for (const child of node.children ?? []) parentOf.set(child, node.id)
  }

  /** Self hits of the node plus everything beneath it - the frame's inclusive cost. */
  function subtreeHits(node: ProfileNode): number {
    let sum = node.hitCount ?? 0
    for (const child of node.children ?? []) {
      const c = byId.get(child)
      if (c !== undefined) sum += subtreeHits(c)
    }
    return sum
  }

  /** Root-to-node label chain. */
  function chainOf(node: ProfileNode): string[] {
    const chain: string[] = []
    let cur: ProfileNode | undefined = node
    while (cur !== undefined) {
      chain.unshift(labelOf(cur.callFrame))
      const p = parentOf.get(cur.id)
      cur = p === undefined ? undefined : byId.get(p)
    }
    return chain
  }

  /** Descendant self time grouped by label, the matched node itself excluded. */
  function descendantSelf(node: ProfileNode, into: Map<string, number>): void {
    for (const child of node.children ?? []) {
      const c = byId.get(child)
      if (c === undefined) continue
      const hits = c.hitCount ?? 0
      if (hits > 0) {
        const label = labelOf(c.callFrame)
        into.set(label, (into.get(label) ?? 0) + hits)
      }
      descendantSelf(c, into)
    }
  }

  const pct = (hits: number) => `${((hits / nonIdle) * 100).toFixed(2)}%`
  console.log(`${basePath}  (${nonIdle} non-idle samples)`)

  for (const pattern of targets) {
    // Matching a node whose ancestor already matched would double-count the subtree; keep roots only.
    const matched = profile.nodes.filter((n) => labelOf(n.callFrame).includes(pattern))
    const matchedIds = new Set(matched.map((n) => n.id))
    const roots = matched.filter((n) => {
      for (let p = parentOf.get(n.id); p !== undefined; p = parentOf.get(p)) {
        if (matchedIds.has(p)) return false
      }
      return true
    })
    if (roots.length === 0) {
      console.log(`\n== "${pattern}": no matching frames`)
      continue
    }

    let self = 0
    let subtree = 0
    const chains = new Map<string, number>()
    const inside = new Map<string, number>()
    for (const node of roots) {
      self += node.hitCount ?? 0
      subtree += subtreeHits(node)
      const chain = chainOf(node).join("\n      > ")
      chains.set(chain, (chains.get(chain) ?? 0) + subtreeHits(node))
      descendantSelf(node, inside)
    }
    console.log(
      `\n== "${pattern}"  self ${pct(self)}, subtree ${pct(subtree)}  (${roots.length} tree nodes)`,
    )

    console.log(`\n  ancestor chains (who was on the stack), by subtree hits:`)
    const chainRows = [...chains].sort((a, b) => b[1] - a[1])
    for (const [chain, hits] of chainRows.slice(0, 8)) {
      console.log(`\n    ${pct(hits)}  ${chain}`)
    }

    console.log(`\n  ran INSIDE it (descendant self time - the continuations themselves):`)
    const insideRows = [...inside].sort((a, b) => b[1] - a[1])
    if (insideRows.length === 0) console.log(`    (none - all samples are the frame's own code)`)
    for (const [label, hits] of insideRows.slice(0, 20)) {
      if (hits / nonIdle < 0.0004) break
      console.log(`    ${pct(hits)}  ${label}`)
    }
  }
  process.exit(0)
}

if (targetPath === undefined) {
  const { shares, total } = await sharesOf(basePath, IDLE)
  console.log(`${basePath}  (${total} non-idle samples)\n`)
  const rows = [...shares].sort((a, b) => b[1] - a[1])
  for (const [label, share] of rows.slice(0, 30)) {
    if (share < 0.15) break
    console.log(`  ${share.toFixed(2)}%  ${label}`)
  }
  process.exit(0)
}

const base = await sharesOf(basePath)
const target = await sharesOf(targetPath)

const labels = new Set([...base.shares.keys(), ...target.shares.keys()])
const rows: Array<{ label: string; base: number; target: number; delta: number }> = []
for (const label of labels) {
  const b = base.shares.get(label) ?? 0
  const t = target.shares.get(label) ?? 0
  rows.push({ label, base: b, target: t, delta: t - b })
}
rows.sort((a, b) => b.delta - a.delta)

const fmt = (r: (typeof rows)[number]) =>
  `  ${r.delta >= 0 ? "+" : ""}${r.delta.toFixed(2)}%  ${r.base.toFixed(2)} -> ${r.target.toFixed(2)}   ${r.label}`

console.log(`baseline ${basePath}  (${base.total} samples)`)
console.log(`target   ${targetPath}  (${target.total} samples)`)
console.log("\nself-time share GREW most (the added stage):")
for (const r of rows.slice(0, 18)) {
  if (r.delta <= 0.02) break
  console.log(fmt(r))
}
console.log("\nself-time share SHRANK most (should be dilution only):")
for (const r of rows.slice(-8).reverse()) {
  if (r.delta >= -0.02) break
  console.log(fmt(r))
}

export {}
