import { resolve } from "node:path"

/**
 * Each entry's emitted JS chunk, keyed by the absolute source path the build metafile records for it.
 * Bun's API does not promise that `outputs` follow `entrypoints` order, so a route's preload is read
 * from the output that names the route's own source as its entry, never from a position.
 */
export function entryChunks(
  outputs: Readonly<Record<string, { readonly entryPoint?: string }>>,
  cwd: string,
): ReadonlyMap<string, string> {
  const chunks = new Map<string, string>()
  for (const [path, output] of Object.entries(outputs)) {
    if (output.entryPoint !== undefined && /\.[cm]?js$/.test(path))
      chunks.set(resolve(cwd, output.entryPoint), path)
  }
  return chunks
}
