---
"create-nifra": patch
---

A site scaffold is composed from one model instead of copied from five directories.

`create-nifra --template site --framework <react|preact|vue|solid|svelte>` produces the same app it
always did. What changed is where it comes from: thirteen of a site's twenty-six files are identical
whatever you render with, eight are emitted from a framework model, and five are genuinely the
framework's own.

Five hand-maintained copies had already drifted, which is the argument for this rather than a
consequence of it. `.vercel` was excluded from four `tsconfig.json` files and not React's, though
`build-vercel.ts` writes there in all five. React's Vercel entry explains the Build Output API layout
it emits and the three copies made later had dropped that. Vue's feature-flag defines are explained in
its Cloudflare entry and nowhere else. Composing restores all of it.

The `@nifrajs/*` range a scaffold installs is now one constant. It used to be a regex sweep across
eight `package.json` files with nothing checking the result, and the release script's own comment
warned that a missed bump ships templates installing the previous release. A test now fails when that
constant drifts from the version being published.

What is NOT generated is deliberate. `nifra.config.ts` explains why Solid wants a `solid` resolve
condition and what `@preact/preset-vite` is; the routes are the app a reader opens first. That prose
stays in files you can read and edit, because moving it into TypeScript string literals would put it
somewhere strictly worse.
