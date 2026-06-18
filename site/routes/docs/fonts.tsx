import { CodeBlock } from "../../highlight"
import { pageMeta } from "../../meta"

// Pure content page — no React interactivity (TOC/copy/search are the layout enhancer +
// the Nira island), so ship zero framework JS and avoid hydrating the inline-script DOM.
export const hydrate = false

export const meta = pageMeta(
  "Nifra — Fonts",
  "Self-host web fonts with zero layout shift: a build-time Google Fonts downloader (the next/font equivalent) plus CLS-safe @font-face + preload primitives.",
)

const AUTOMATED = `// fonts.build.ts — run once at build time (a prebuild step). It hits the network.
import { loadGoogleFont } from "@nifrajs/web/fonts"

const inter = await loadGoogleFont(
  { family: "Inter", weights: [400, 700], subsets: ["latin"], sizeAdjust: "107%" },
  { outDir: "public/fonts", publicPath: "/fonts" },
)

await Bun.write("app/fonts.css", inter.css)                  // the @font-face stylesheet
await Bun.write("app/fonts.preloads.json", JSON.stringify(inter.preloads))`

const AUTOMATED_USE = `// app entry — bundled + content-hashed by nifra's CSS pipeline
import "./fonts.css"

// root layout — preload the primary file (one less render-blocking round trip)
import preloads from "./fonts.preloads.json" with { type: "json" }
export const meta = { link: preloads }`

const MANUAL = `// fonts.css — you dropped inter.woff2 into public/fonts/ yourself
import { fontFace } from "@nifrajs/web"

export default fontFace({
  family: "Inter",
  src: [{ url: "/fonts/inter.woff2" }],   // format() inferred from the extension
  weight: "100 900",                       // a variable-font range
  display: "swap",                         // the default — paints fallback text instantly
  sizeAdjust: "107%",                      // metric override → no fallback→web-font shift
})`

const PRELOAD = `// a root layout's meta — becomes <link rel="preload" as="font" crossorigin> in <head>
import { fontPreload } from "@nifrajs/web"

export const meta = { link: [fontPreload({ href: "/fonts/inter.woff2" })] }`

export default function Fonts() {
  return (
    <div className="prose">
      <h1 className="page">Fonts</h1>
      <p className="lead">
        Self-host your fonts with <b>zero layout shift</b> — Nifra's equivalent of{" "}
        <code>next/font</code>. Either let the build downloader fetch a Google font for you, or
        hand-write a <code>@font-face</code> from a file you already have. Both paths produce the same
        thing: a self-hosted, content-hashed font with <code>font-display: swap</code>, a preload, and
        metric overrides — no runtime CDN hotlink, and Google never learns what your users read.
      </p>

      <h2>Automated: download a Google font at build time</h2>
      <p>
        <code>loadGoogleFont</code> runs in your <b>build</b> (it touches the network and writes files,
        so it never sits on the request path). It downloads the font, content-hashes each{" "}
        <code>.woff2</code> into <code>outDir</code>, and returns a self-hosted <code>@font-face</code>{" "}
        stylesheet plus the matching preloads:
      </p>
      <CodeBlock code={AUTOMATED} />
      <p>Then wire the two outputs into your app:</p>
      <CodeBlock code={AUTOMATED_USE} />
      <p>
        Re-run the script when you change weights or subsets; commit the hashed{" "}
        <code>public/fonts/*.woff2</code> (or regenerate them in CI). A complete runnable example lives
        in <code>examples/fonts-google</code>.
      </p>
      <ul>
        <li>
          <b>weights</b> — numbers (<code>400</code>), a variable range (<code>"100 900"</code>), or the
          keywords <code>normal</code>/<code>bold</code>
        </li>
        <li>
          <b>styles</b> — <code>["normal", "italic"]</code>; defaults to <code>["normal"]</code>
        </li>
        <li>
          <b>subsets</b> — keep only the ones you serve (<code>["latin"]</code>); Google returns every
          subset as its own <code>@font-face</code> with a <code>unicode-range</code>
        </li>
        <li>
          <b>text</b> — glyph subsetting for a logo/heading: request only the characters you render, and
          you get one tiny file
        </li>
      </ul>

      <h2>Manual: self-host a file you already have</h2>
      <p>
        Already have the <code>.woff2</code>? <code>fontFace</code> builds a CLS-safe rule directly. Put
        the result in a stylesheet your app imports — Nifra's CSS pipeline bundles and content-hashes
        it.
      </p>
      <CodeBlock code={MANUAL} />

      <h2>Preload the font file</h2>
      <p>
        <code>fontPreload</code> emits a <code>&lt;link rel="preload" as="font"&gt;</code> for a root
        layout's <code>meta.link</code> — the browser would otherwise discover the font only after
        parsing the CSS, a wasted round trip. It defaults to <code>crossorigin="anonymous"</code>{" "}
        because fonts are always fetched in CORS mode (a mismatched preload is downloaded twice).
      </p>
      <CodeBlock code={PRELOAD} />
      <p>
        Preload the <i>primary</i> face only (e.g. latin 400). Preloading every weight and subset forces
        downloads the page may never use.
      </p>

      <div className="caveat">
        <b>Security:</b> <code>loadGoogleFont</code> validates the family, weights, and subsets,{" "}
        <b>allowlists the font-file host to <code>fonts.gstatic.com</code> over https</b> (a tampered
        stylesheet can't redirect the download elsewhere — an SSRF gate), and caps each download's size.
        Filenames are derived only from validated tokens plus a content hash, so there's no path
        traversal.
      </div>
    </div>
  )
}
