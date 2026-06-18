import { deflateSync } from "node:zlib"
import { buildClient } from "@nifrajs/web/build"

const manifest = await buildClient({
  routesDir: `${import.meta.dir}/routes`,
  outDir: `${import.meta.dir}/public/assets`,
  clientModule: "@nifrajs/web-react/client",
  conditions: ["bun", "browser"],
  define: { "process.env.NODE_ENV": '"production"' },
})
console.log("client entry:", manifest.entry)

// Generate a real raster source for the self-hosted resize demo (`@nifrajs/image/server` resizes THIS,
// unlike the stand-in SVG "CDN" elsewhere in the example). A diagonal gradient makes the downscaling
// visibly real. Committed alongside the prebuilt assets so `bun server.ts` runs without a build step.
const photo = makePng(1600, 900)
await Bun.write(`${import.meta.dir}/public/photo.png`, photo)
console.log(`source photo: public/photo.png (${1600}×${900}, ${photo.length} bytes)`)

/** Build a valid RGBA PNG with a diagonal gradient. IDAT uses node:zlib (a real zlib stream — Bun's
 * `deflateSync` emits raw deflate, which PNG decoders reject). */
function makePng(w: number, h: number): Uint8Array {
  const crc32 = (buf: Uint8Array): number => {
    let c = ~0
    for (let i = 0; i < buf.length; i++) {
      c ^= buf[i]!
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
    }
    return ~c >>> 0
  }
  const chunk = (type: string, data: Uint8Array): Uint8Array => {
    const t = new TextEncoder().encode(type)
    const len = new Uint8Array(4)
    new DataView(len.buffer).setUint32(0, data.length)
    const body = new Uint8Array(t.length + data.length)
    body.set(t)
    body.set(data, t.length)
    const crc = new Uint8Array(4)
    new DataView(crc.buffer).setUint32(0, crc32(body))
    return new Uint8Array([...len, ...body, ...crc])
  }
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
  const ihdr = new Uint8Array(13)
  const dv = new DataView(ihdr.buffer)
  dv.setUint32(0, w)
  dv.setUint32(4, h)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  const raw = new Uint8Array(h * (1 + w * 4))
  for (let y = 0; y < h; y++) {
    const row = y * (1 + w * 4)
    for (let x = 0; x < w; x++) {
      const p = row + 1 + x * 4
      raw[p] = Math.round((255 * x) / w) // R ramps across
      raw[p + 1] = Math.round((255 * y) / h) // G ramps down
      raw[p + 2] = Math.round((255 * (x + y)) / (w + h)) // B on the diagonal
      raw[p + 3] = 255
    }
  }
  const idat = new Uint8Array(deflateSync(raw))
  return new Uint8Array([
    ...sig,
    ...chunk("IHDR", ihdr),
    ...chunk("IDAT", idat),
    ...chunk("IEND", new Uint8Array(0)),
  ])
}
