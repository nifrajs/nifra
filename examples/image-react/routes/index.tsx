import { selfHostedLoader } from "@nifrajs/image"
import { Image } from "@nifrajs/web-react/image"
import { localLoader } from "../loader"

export const meta = { title: "nifra — image demo" }

const frame = { display: "block", marginBottom: "1rem", borderRadius: 8 } as const

// Points <Image> at nifra's own resize endpoint (mounted at /_image in server.ts, backed by Bun.Image).
// A pure URL builder — safe to import into a client route module.
const resize = selfHostedLoader({ endpoint: "/_image" })

export default function Home() {
  return (
    <section>
      <h2 id="hero-heading">Above the fold — the LCP image</h2>
      <p style={{ color: "#555" }}>
        <code>priority</code> → <code>loading="eager"</code> + <code>fetchpriority="high"</code>.
        React 19 also emits a <code>&lt;link rel="preload" as="image"&gt;</code> for it.
      </p>
      {/* The hero is the LCP image — load it eagerly + at high priority, never lazily. */}
      <Image
        id="hero"
        src="/img/hero"
        width={800}
        height={450}
        alt="A labeled placeholder banner"
        priority
        loader={localLoader}
        sizes="(max-width: 840px) 100vw, 800px"
        style={frame}
      />

      {/* A tall spacer pushes the next images below the fold, so `loading="lazy"` actually defers them. */}
      <div style={{ height: "120vh" }} aria-hidden="true" />

      <h2>Below the fold — lazy by default</h2>
      <p style={{ color: "#555" }}>
        Default <code>loading="lazy"</code> + <code>decoding="async"</code>. The intrinsic{" "}
        <code>width</code>/<code>height</code> reserve layout space, so nothing shifts when they
        load.
      </p>
      <Image
        id="lazy-forest"
        src="/img/forest"
        width={800}
        height={450}
        alt="A labeled placeholder, lazy-loaded"
        loader={localLoader}
        sizes="(max-width: 840px) 100vw, 800px"
        style={frame}
      />
      <Image
        id="lazy-ocean"
        src="/img/ocean"
        width={800}
        height={450}
        alt="A labeled placeholder, lazy-loaded at quality 70"
        loader={localLoader}
        quality={70}
        sizes="(max-width: 840px) 100vw, 800px"
        style={frame}
      />

      <h2>Self-hosted resize — nifra's own endpoint (Bun.Image)</h2>
      <p style={{ color: "#555" }}>
        This one is a real <code>1600×900</code> PNG resized on the fly by{" "}
        <code>@nifrajs/image/server</code> at <code>/_image</code> — no third-party CDN. The browser
        negotiates WebP via <code>Accept</code>; open DevTools → Network and you'll see{" "}
        <code>/_image?src=%2Fphoto.png&amp;w=…</code> returning <code>image/webp</code>.
      </p>
      <Image
        id="selfhosted"
        src="/photo.png"
        width={800}
        height={450}
        alt="A real raster photo resized by nifra's self-hosted endpoint"
        loader={resize}
        quality={75}
        sizes="(max-width: 840px) 100vw, 800px"
        style={frame}
      />
    </section>
  )
}
