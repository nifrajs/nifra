import { basename } from "node:path"
import {
  FRAMEWORKS_ENTRY,
  HOME_COUNTER_ENTRY,
  NIFRA_BOT_ENTRY,
  PLAYGROUND_ENTRY,
} from "./islands/entries"

export interface BuildSiteIslandsOptions {
  readonly outDir: string
}

const assetName = (url: string): string => {
  if (!url.startsWith("/assets/")) {
    throw new Error(`[nifra/site] island entry must live under /assets/: ${url}`)
  }
  return url.slice("/assets/".length)
}

// Each island is a self-contained vanilla-JS bundle (no shared chunks → `splitting: false`). The
// homepage enhancer is a few hundred bytes; the playground bundles @nifrajs/core + schema + runner so it
// can run a real `server()` app via `app.fetch` entirely in the tab.
const ISLANDS: ReadonlyArray<{ src: string; url: string }> = [
  { src: "home-counter.client.ts", url: HOME_COUNTER_ENTRY },
  { src: "playground.client.ts", url: PLAYGROUND_ENTRY },
  { src: "nifra-bot.client.ts", url: NIFRA_BOT_ENTRY },
  { src: "frameworks.client.ts", url: FRAMEWORKS_ENTRY },
]

export async function buildSiteIslands(options: BuildSiteIslandsOptions): Promise<void> {
  const result = await Bun.build({
    entrypoints: ISLANDS.map((i) => `${import.meta.dir}/islands/${i.src}`),
    outdir: options.outDir,
    target: "browser",
    naming: "[name].[ext]", // each entry keeps its source basename, e.g. playground.client.js
    minify: true,
    splitting: false,
    conditions: ["bun", "browser"],
    define: { "process.env.NODE_ENV": '"production"' },
  })
  if (!result.success) {
    throw new Error(
      `[nifra/site] island build failed:\n${result.logs.map((l) => String(l)).join("\n")}`,
    )
  }
  // Every declared island must have produced its expected output file.
  const built = new Set(result.outputs.map((o) => basename(o.path)))
  for (const i of ISLANDS) {
    const expected = assetName(i.url)
    if (!built.has(expected)) {
      throw new Error(
        `[nifra/site] expected island entry ${expected}, got [${[...built].join(", ")}]`,
      )
    }
  }
}
