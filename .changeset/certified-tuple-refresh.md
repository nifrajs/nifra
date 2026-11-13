---
"@nifrajs/web": minor
"@nifrajs/web-react": minor
---

The certified server-component tuple moves to Vite 8.3.8 and `@vitejs/plugin-rsc` 0.5.39 (was 8.3.4 and 0.5.35), with Vue 3.5.45 / plugin-vue 6.0.11, Svelte 5.57.3, Solid 1.9.19 / vite-plugin-solid 2.11.16 and preact-render-to-string 6.8.3 / preset-vite 2.10.6 in the consumer matrix. The pipeline's guard accepts only the certified Vite, and the `@vitejs/plugin-rsc` peer is exact: an app using server components must pin `vite@8.3.8` and `@vitejs/plugin-rsc@0.5.39` together. Apps that do not opt in to server components are unaffected.
