/** The Node bundle the HTTP runners build before spawning a target that needs one. */
export const buildNodeBundle = (dir: string, entry: string) => async (): Promise<void> => {
  // A rerun in the same CI job measures what the first run built.
  if (Bun.env.BENCH_SKIP_BUILD === "1") return
  const result = await Bun.build({
    entrypoints: [`${dir}/${entry}`],
    target: "node",
    outdir: `${dir}/dist`,
  })
  if (!result.success) {
    throw new Error(`${entry} bundle failed: ${result.logs.map(String).join("; ")}`)
  }
}
