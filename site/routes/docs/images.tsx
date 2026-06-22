import { CodeBlock } from "../../highlight"
import { pageMeta } from "../../meta"

// Pure content page — no React interactivity (TOC/copy/search are the layout enhancer +
// the Nira island), so ship zero framework JS and avoid hydrating the inline-script DOM.
export const hydrate = false

export const meta = pageMeta(
  "Nifra — images",
  "A CLS-safe responsive <Image> with pluggable loaders — a CDN, or Nifra's self-hosted resize endpoint (Bun.Image, sharp, or WASM on the edge) with optional signed URLs.",
)

const BACKENDS = `// doc-check: skip — illustrates third-party codecs (sharp, @jsquash/*); install them to run it.
import { createImageHandler } from "@nifrajs/image/server"
import { sharpImageBackend, wasmImageBackend } from "@nifrajs/image/backends"

// Node — libvips via sharp. Pass your own import (nifra never depends on it):
import sharp from "sharp"
createImageHandler({ backend: sharpImageBackend(sharp), root: "./public" })

// Edge (Workers / Vercel-Edge / Deno-Deploy) — pure-WASM codecs, e.g. jSquash:
import decodeJpeg from "@jsquash/jpeg/decode"
import resize from "@jsquash/resize"
import encodeWebp from "@jsquash/webp/encode"   // + @jsquash/png, @jsquash/jpeg encoders
createImageHandler({
  allowedOrigins: ["https://cdn.example"],
  backend: wasmImageBackend({
    decode: decodeJpeg,                                       // → { data, width, height } (RGBA)
    resize: (img, width, height) => resize(img, { width, height }),
    encode: async (img, format) => new Uint8Array(await encodeWebp(img)), // switch by format
  }),
})`

const SIGNING = `// Lock the endpoint to URLs YOU minted — kills resize-bombing (w/q enumeration).
// SAME secret on loader + handler; it's server-only (inject from env, like a session secret).
import { selfHostedLoader, signImageUrl } from "@nifrajs/image"
import { createImageHandler } from "@nifrajs/image/server"

const IMAGE_SECRET = process.env.IMAGE_SECRET! // server-only; on Workers read c.env.IMAGE_SECRET instead

const resize = selfHostedLoader({ endpoint: "/_image", secret: IMAGE_SECRET })
//  → /_image?src=…&w=800&s=<hmac>   (stable: an SSR-signed URL hydrates + caches identically)

const image = createImageHandler({ root: "./public", signing: { secret: IMAGE_SECRET } })
//  any request without a valid &s= (forged / tampered / expired) → 403, before any fetch or decode

// Time-limited links to private images (server-side only):
const url = signImageUrl("/_image", { src: "/private/a.jpg", width: 800 }, {
  secret: IMAGE_SECRET,
  expiresIn: 300, // seconds → adds &exp=
})`

const USAGE = `import { Image } from "@nifrajs/web-react/image"
import { cloudflareLoader } from "@nifrajs/image"

const cdn = cloudflareLoader()   // → /cdn-cgi/image/format=auto,width=W/...

export default function Page() {
  return <>
    {/* The LCP image: priority → loading="eager" + fetchpriority="high"
        (React 19 also emits a <link rel="preload" as="image"> for it). */}
    <Image src="/hero.jpg" width={1200} height={630} alt="Hero banner"
           priority loader={cdn} sizes="(max-width: 1200px) 100vw, 1200px" />

    {/* Below the fold: lazy + async-decode by default. width/height
        reserve the box, so nothing shifts when it loads (no CLS). */}
    <Image src="/thumb.jpg" width={400} height={300} alt="Thumbnail"
           loader={cdn} quality={75} />
  </>
}`

const LOADERS = `import type { ImageLoader } from "@nifrajs/image"
import { cloudflareLoader, identityLoader } from "@nifrajs/image"

// Built-in: Cloudflare Images. \`base\` prepends an origin to bare paths.
const cf = cloudflareLoader({ base: "https://assets.example.com" })

// The default when you pass no loader: no transform (still CLS-safe + lazy,
// just no responsive variants).
identityLoader({ src: "/a.png", width: 800 })   // → "/a.png"

// Any CDN is a pure (src, width, quality?) → URL builder:
const imgix: ImageLoader = ({ src, width, quality }) =>
  \`https://my.imgix.net\${src}?w=\${width}&auto=format\${quality ? \`&q=\${quality}\` : ""}\``

const SELFHOST = `// 1. The loader (browser-safe) points <Image> at your endpoint:
import { selfHostedLoader } from "@nifrajs/image"
const resize = selfHostedLoader({ endpoint: "/_image" })
// <Image src="/photo.png" width={800} height={450} alt="…" loader={resize} />
//   → /_image?src=%2Fphoto.png&w=800  (+ a 1600w retina candidate)

// 2. The endpoint (server-only) does the actual resize with Bun.Image:
import { createImageHandler } from "@nifrajs/image/server"

const image = createImageHandler({
  root: "./public",                          // local sources resolve under here (traversal+symlink guarded)
  allowedOrigins: ["https://cdn.example"],   // remote sources: allowlist only (omit ⇒ none)
  // maxWidth, maxSourceBytes, maxSourcePixels, concurrency, cacheMaxAge — all tunable
})

// mount it in your router:
app.get("/_image", (c) => image(c.req))`

const DIMENSIONS = `import { imageDimensions, readImageDimensions } from "@nifrajs/image"

// Pure-JS header read — PNG / JPEG / GIF / WebP. No decode, no codec, no deps.
const info = await readImageDimensions(Bun.file("public/hero.jpg"))
// → { width: 1200, height: 630, format: "jpeg" }   (null if unrecognized)

// Build-time tooling: pre-read sizes into a manifest so <Image> is CLS-safe
// without hardcoding width/height at every call site. The sync variant takes the
// raw header bytes you already have in memory (no file read):
const headerBytes = await Bun.file("public/hero.jpg").bytes()
imageDimensions(headerBytes)`

export default function Images() {
  return (
    <div className="prose">
      <h1 className="page">Images</h1>
      <p className="lead">
        <code>@nifrajs/image</code> gives you a CLS-safe, responsive <code>&lt;Image&gt;</code> with
        lazy-by-default loading and a pluggable loader. The <b>core bundles no image codec</b> — point the
        loader at a CDN and the runtime stays tiny. Or self-host: the optional{" "}
        <code>@nifrajs/image/server</code> resizes your own images with <code>Bun.Image</code>.
      </p>

      <h2>The &lt;Image&gt; component</h2>
      <p>
        <code>width</code> and <code>height</code> are <b>required</b> and validated{" "}
        <code>&gt; 0</code> — they reserve layout space so the page never shifts when the image loads
        (the CLS contract). It's <code>loading="lazy"</code> + <code>decoding="async"</code> by default;
        mark the LCP image with <code>priority</code> to get <code>eager</code> +{" "}
        <code>fetchpriority="high"</code>. Extra DOM props (<code>className</code>, <code>style</code>,{" "}
        <code>id</code>, <code>data-*</code>) pass straight through to the <code>&lt;img&gt;</code>.
      </p>
      <CodeBlock code={USAGE} />
      <p>
        The responsive <code>srcSet</code> is built from <code>widths</code> (default{" "}
        <code>{`[width, width*2]`}</code> for 1×/2× retina), de-duped and sorted; if every width yields
        the same URL (e.g. the identity loader), <code>srcSet</code> is omitted. The browser then picks
        the right candidate for the device's pixel ratio and the <code>sizes</code> you declare.
      </p>

      <h2>Loaders</h2>
      <p>
        A loader is a pure <code>{`({ src, width, quality? }) => string`}</code> URL builder. Ship with
        <code> cloudflareLoader()</code> (Cloudflare Images) or the no-op <code>identityLoader</code>,
        or write your own for any CDN — Imgix, Cloudinary, a signed-URL service, anything.
      </p>
      <CodeBlock code={LOADERS} />

      <h2>Self-hosting — nifra's own resize endpoint</h2>
      <p>
        No CDN? <code>@nifrajs/image/server</code>'s <code>createImageHandler</code> is a self-hosted resize
        endpoint backed by <code>Bun.Image</code> (libjpeg-turbo / libspng / libwebp, decoded off-thread).
        Pair it with <code>selfHostedLoader</code> and nifra resizes your own images — no third party in the
        path.
      </p>
      <CodeBlock code={SELFHOST} />
      <p>
        The handler is <b>hardened by default</b>, because <code>src</code>/<code>w</code>/<code>q</code>{" "}
        are untrusted input:
      </p>
      <ul>
        <li>
          <b>SSRF, fail-closed.</b> Local sources are confined to <code>root</code> with path-traversal{" "}
          <i>and</i> symlink containment checks; remote sources are refused unless their exact origin is in{" "}
          <code>allowedOrigins</code> (omit it ⇒ no remote fetch at all). Only <code>http(s)</code> URLs are
          considered, redirects are refused, and fetches are byte-capped + timed out.
        </li>
        <li>
          <b>DoS guards.</b> Strict integer parsing (no <code>Number()</code> coercion), width clamped to{" "}
          <code>maxWidth</code>, a source byte cap, a decompression-bomb pixel cap (via a cheap header-only
          probe), and a concurrency semaphore bounding the CPU-heavy codec work.
        </li>
        <li>
          <b>Correct + cacheable.</b> Never upscales past the intrinsic width; negotiates WebP via{" "}
          <code>Accept</code> (with <code>Vary: Accept</code>); serves{" "}
          <code>Cache-Control: …, immutable</code> + a strong <code>ETag</code> computed <i>before</i> any
          decode, so a conditional <code>If-None-Match</code> short-circuits the whole pipeline.
        </li>
      </ul>
      <p>
        The handler reads the filesystem, so its <i>local-source</i> path targets <b>Node/Bun servers</b>
        — but the codec itself is a pluggable <code>ImageBackend</code>, so it runs anywhere (see below).
      </p>

      <h2>Backends — Bun, sharp, or WASM (edge)</h2>
      <p>
        The codec is a seam: the handler owns all the security above; a backend just
        decodes/resizes/encodes. Three official backends, all from <code>@nifrajs/image/backends</code>:
      </p>
      <ul>
        <li>
          <code>bunImageBackend()</code> — the default; <code>Bun.Image</code> on Bun servers.
        </li>
        <li>
          <code>sharpImageBackend(sharp)</code> — libvips for Node. You pass your <code>sharp</code> import
          (nifra keeps zero dependency on it, and you pin the version).
        </li>
        <li>
          <code>wasmImageBackend(codecs)</code> — pure-WASM decode/resize/encode you wire up (jSquash is
          the common choice). The <b>only backend that runs on the edge</b> (Workers / Vercel-Edge /
          Deno-Deploy), where there's no native codec. <code>@nifrajs/image/backends</code> has no{" "}
          <code>node:</code> imports, so it bundles for the edge cleanly; the bomb-safe header probe is
          built in (it never decodes just to read dimensions).
        </li>
      </ul>
      <CodeBlock code={BACKENDS} />
      <p>
        Prefer not to run a codec on the edge at all? <code>cloudflareLoader</code> still resizes at the
        CDN — same <code>&lt;Image&gt;</code>, swap the loader.
      </p>

      <h2>Signed URLs</h2>
      <p>
        Because <code>src</code>/<code>w</code>/<code>q</code> are attacker-controllable, a public resize
        endpoint can be <b>resize-bombed</b> — enumerating widths/qualities to flood CPU + cache. Signing
        shuts that down: set a <code>secret</code> on the loader and the handler, and the endpoint{" "}
        <b>rejects any URL it didn't mint</b> (forged, tampered, or expired) with <code>403</code>, before
        any fetch or decode. The signature is a portable <b>synchronous</b> HMAC-SHA256, so the (sync)
        loader can sign inline — even on the edge.
      </p>
      <CodeBlock code={SIGNING} />
      <p>
        Signatures over <code>(src, w, q)</code> are <b>stable</b> (no expiry), so an SSR-rendered{" "}
        <code>&lt;Image&gt;</code> srcset hydrates and caches identically. The secret makes a loader{" "}
        config <b>server-only</b> — inject it from <code>env</code> and never import it into a route/client
        module (same discipline as a <a href="/docs/auth">session secret</a>). For time-limited links to
        private images, <code>signImageUrl(…, {`{ expiresIn }`})</code> adds an <code>&amp;exp=</code> the
        handler enforces.
      </p>

      <h2>Reading intrinsic dimensions</h2>
      <p>
        Don't want to hardcode <code>width</code>/<code>height</code>? Read them from the file{" "}
        <b>header</b> in pure JS — no decode, no native dependency — and bake them into a build-time
        manifest. Supports PNG, JPEG (scans <code>SOFn</code>, skipping earlier segments), GIF, and WebP
        (VP8 / VP8L / VP8X).
      </p>
      <CodeBlock code={DIMENSIONS} />

      <h2>Notes</h2>
      <ul>
        <li>
          The loader is the seam: on the edge, resizing belongs at the CDN (which caches variants and
          negotiates <code>format=auto</code>); on a Node/Bun server you can self-host it with{" "}
          <code>@nifrajs/image/server</code> instead. Same <code>&lt;Image&gt;</code>, swap the loader.
        </li>
        <li>
          Always set <code>sizes</code> for images that aren't a fixed pixel width, so the browser
          selects the smallest sufficient <code>srcSet</code> candidate.
        </li>
        <li>
          <code>&lt;Image&gt;</code> ships for <b>all five adapters</b> (React, Preact, Vue, Solid,
          Svelte) — import from <code>@nifrajs/web-&lt;framework&gt;/image</code>. Each builds the same{" "}
          <code>&lt;img&gt;</code> from the agnostic <code>resolveImage</code> (non-React adapters map to
          lowercase HTML attrs via <code>toHtmlAttrs</code>).
        </li>
      </ul>
    </div>
  )
}
