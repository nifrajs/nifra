/**
 * The workloads a rerun is limited to. `bench/ci/run.ts` names the ones still noisy in
 * `BENCH_ONLY_WORKLOADS` (a JSON array); without it every workload runs.
 */
export function onlyWorkloads(
  raw: string | undefined = Bun.env.BENCH_ONLY_WORKLOADS,
): ReadonlySet<string> | undefined {
  if (raw === undefined || raw === "") return undefined
  const parsed: unknown = JSON.parse(raw)
  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    !parsed.every((name): name is string => typeof name === "string")
  ) {
    throw new Error("BENCH_ONLY_WORKLOADS takes a JSON array of workload names")
  }
  return new Set(parsed)
}

export function selectWorkloads<T extends { readonly name: string }>(
  workloads: readonly T[],
  only: ReadonlySet<string> | undefined = onlyWorkloads(),
): readonly T[] {
  return only === undefined ? workloads : workloads.filter((w) => only.has(w.name))
}
