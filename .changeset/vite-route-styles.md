---
"@nifrajs/web": patch
---

With the Vite builder, a page now links every stylesheet it needs. Each route's list held only the CSS of its own chunk, so a component two routes share (Vite gives it a chunk of its own) was unstyled on both, as was a stylesheet the client module imports. Because a route's list replaces the app-wide one, those pages rendered without that CSS. The list now follows the chunk's static imports, starts with the bootstrap's stylesheets, and includes the `_loading` pages', as the Bun builder already does.
