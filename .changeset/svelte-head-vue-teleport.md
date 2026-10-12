---
"@nifrajs/web": minor
"@nifrajs/web-svelte": patch
"@nifrajs/web-vue": patch
---

`<svelte:head>` and Vue's `<Teleport>` are server-rendered. Both were dropped from the HTML, so a `noindex` robots tag, a canonical link or a teleported dialog appeared only after hydration, and never with JavaScript off.

- `@nifrajs/web-svelte` puts what `<svelte:head>` renders at the end of the document's `<head>`.
- `@nifrajs/web-vue` puts each teleport's content as the first children of its target, where Vue's hydration reads it. `body` content goes first in `<body>`. An `#id` target the app renders empty receives the content, and one the app does not render gets a container before the app root. Any other selector, a target with children of its own, and a page that uses `defer()` keep rendering teleports on the client, now with a development warning.
- `@nifrajs/web`: a render adapter that sets `documentParts` is passed `options.parts` and adds `head` and `body` markup there. An adapter without it is unchanged.
