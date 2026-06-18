/** The gate measurement: client bundle (min+gz) for the same counter island, spike vs Solid. */
import { gzipSync } from "bun"

const here = import.meta.dir
async function size(label: string, entry: string, opts: Record<string, unknown> = {}) {
  const built = await Bun.build({
    entrypoints: [`${here}/${entry}`],
    target: "browser",
    minify: true,
    ...opts,
  })
  let src = ""
  for (const o of built.outputs) src += await o.text()
  const gz = gzipSync(Buffer.from(src)).length
  console.log(
    `${label.padEnd(22)} min ${(src.length / 1024).toFixed(2).padStart(6)} KB   gz ${(gz / 1024).toFixed(2).padStart(5)} KB`,
  )
  return gz
}
const spike = await size("view-spike counter", "demo/counter-view.ts")
// Solid baselines (measured elsewhere, cited in VIEW-SPIKE.md): a minimal solid-js/web island
// ≈ 4.0 KB gz; nifra+Solid full page hydration = 6.0 KB gz (SSR-BENCHMARKS client-JS column).
console.log(`\nvs solid island ~4.0 KB gz: spike is ${((spike / 4096) * 100).toFixed(0)}%`)
console.log(`vs nifra+solid page 6.0 KB gz: spike is ${((spike / 6144) * 100).toFixed(0)}%`)
