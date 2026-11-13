/** Concatenate chunks into an output array with the supplied total byte length. */
// biome-ignore lint/plugin/noHelperCopy: canonical implementation owned by @nifrajs/utils.
export function concatBytes(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}
