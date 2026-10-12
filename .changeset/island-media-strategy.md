---
"@nifrajs/web-react": patch
---

`<Island strategy={{ media }}>` now renders `data-strategy="media"` and `data-media`, which the islands runtime reads. React dropped the object-valued attribute, so the runtime saw no strategy and ran the enhancer on load, ignoring the media query.
