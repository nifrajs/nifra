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
}
interface CpuProfile {
  readonly nodes: ReadonlyArray<ProfileNode>
  readonly samples?: ReadonlyArray<number>
}

const [basePath, targetPath] = process.argv.slice(2)
if (basePath === undefined || targetPath === undefined) {
  throw new Error("usage: bun run profile-diff.ts <baseline.cpuprofile> <target.cpuprofile>")
}

/** functionName + a short file:line tag, so two same-named closures stay distinguishable. */
function labelOf(frame: CallFrame): string {
  const file = frame.url.split("/").pop() ?? frame.url
  const name = frame.functionName === "" ? "(anonymous)" : frame.functionName
  return frame.url === "" ? `${name} [native]` : `${name} @ ${file}:${frame.lineNumber + 1}`
}

/** Self-time share per frame label, normalized to the profile's total samples. */
async function sharesOf(path: string): Promise<{ shares: Map<string, number>; total: number }> {
  const profile = (await Bun.file(path).json()) as CpuProfile
  const byLabel = new Map<string, number>()
  let total = 0
  for (const node of profile.nodes) {
    const hits = node.hitCount ?? 0
    if (hits === 0) continue
    total += hits
    const label = labelOf(node.callFrame)
    byLabel.set(label, (byLabel.get(label) ?? 0) + hits)
  }
  const shares = new Map<string, number>()
  for (const [label, hits] of byLabel) shares.set(label, (hits / total) * 100)
  return { shares, total }
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
