---
"@nifrajs/web": minor
---

`servePublicDir({ hashedFiles })` also takes an array of RegExps or a `(pathname) => boolean` predicate, matched on the encoded URL path, so files a pre-build step content-hashed, such as the fonts `loadGoogleFont` writes into `public/fonts/`, are cached immutably without being in the build manifest. A predicate combines the manifest with a pattern: `(path) => assets.has(path) || FONT.test(path)`. A global or sticky pattern in the array is used without that flag, so `lastIndex` never skips a match; a predicate runs as written. Every file the option does not name keeps the one-day policy, the Set form is unchanged, and any other shape is refused when the handler is built, a `Map` included, since its `has` tests keys rather than values.
