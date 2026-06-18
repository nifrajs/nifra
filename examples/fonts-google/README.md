# fonts-google — build-time font self-hosting

The `next/font/google` equivalent for nifra. At **build time** (never on the request path),
[`loadGoogleFont`](../../packages/web/src/fonts-google.ts) downloads a Google font, content-hashes the
`.woff2` files next to your assets, and returns a self-hosted `@font-face` stylesheet plus the matching
`<link rel="preload">`s. No runtime CDN hotlink, no layout shift, immutable hashed filenames.

## Run

```sh
bun run build-fonts.ts
```

This writes:

- `public/fonts/inter-latin-normal-400-<hash>.woff2` (and `700`)
- `app/fonts.css` — the self-hosted `@font-face` rules
- `app/fonts.preloads.json` — preload `<link>` attribute sets

## Use it in an app

```ts
// app entry — bundle + content-hash the font CSS through nifra's CSS pipeline
import "./fonts.css"

// root layout — preload the primary font file (removes a render-blocking round trip)
import preloads from "./fonts.preloads.json" with { type: "json" }
export const meta = { link: preloads }
```

```css
/* now `Inter` is available everywhere, self-hosted */
body { font-family: "Inter", system-ui, sans-serif; }
```

## Why build-time?

`loadGoogleFont` touches the network and writes files, so it runs in your build, not your server.
Re-run it when you change weights/subsets; commit the hashed `public/fonts/*.woff2` (or regenerate in
CI). The runtime ships only the stylesheet link + the font files — zero dependency on Google at
request time, and the user's browser never tells Google what they're reading.

## Security

`loadGoogleFont` validates the family/weights/subsets, **allowlists the font-file host to
`fonts.gstatic.com` over https** (a tampered stylesheet can't redirect the download elsewhere — an
SSRF gate), and caps each download's size. See the module header for the full model.
