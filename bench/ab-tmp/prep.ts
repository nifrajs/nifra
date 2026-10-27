// TEMPORARY - the Node bundles of the two HTTP suites for one tree.
const tree = process.argv[2]!
for (const suite of ["http", "http-realworld"]) {
  const dir = `${tree}/bench/${suite}`
  const r = await Bun.build({
    entrypoints: [`${dir}/serve-node-nifra.ts`],
    target: "node",
    outdir: `${dir}/dist`,
  })
  if (!r.success) throw new Error(`${suite}: ${r.logs.map(String).join("; ")}`)
}
console.log("prepared", tree)
