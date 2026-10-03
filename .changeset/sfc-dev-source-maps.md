---
"@nifrajs/web": minor
"@nifrajs/web-vue": patch
"@nifrajs/web-svelte": patch
---

On the Bun dev pipeline, an error thrown from a `.vue` or `.svelte` file names the line written in that file, in the browser and on the server: the overlay, the in-page badge, `nifra errors` and the fix prompts all point there.

- `vueBunPlugin` and `svelteBunPlugin` attach their compile map while a dev server runs; `nifra build` output is unchanged.
- `@nifrajs/web/plugins/kit` exports `withDevSourceMap` and `concatSourceMaps` for other compiler plugins to do the same.
- Svelte's `hydration_html_changed` and `hydration_attribute_changed` warnings count as hydration mismatches. Vue's feature-flag warning, which names `__VUE_PROD_HYDRATION_MISMATCH_DETAILS__`, does not.
