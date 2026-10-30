---
"@nifrajs/image": minor
"@nifrajs/i18n": minor
"@nifrajs/web": minor
"@nifrajs/web-react": minor
"@nifrajs/web-preact": minor
"@nifrajs/web-solid": minor
"@nifrajs/web-vue": minor
"@nifrajs/web-svelte": minor
"@nifrajs/cli": minor
---

Add opt-in local `?image` metadata imports and content-hashed build-time responsive variants using the existing injectable image backends. Emit images with client, SSR and static builds, and infer imported dimensions in all five UI adapters. String image URLs retain their existing dimension requirements.

Add explicit static translated-path mappings to i18n routing, with reciprocal URL/SEO helpers, availability-aware redirects and static-path enumeration. These mappings do not implicitly create filesystem route aliases.

Add `vercelRuntime: "node"` for ordinary SSR Vercel builds through both bundlers, using a shared streaming Node request bridge. Vercel Edge remains the default.
