---
"@nifrajs/web": patch
---

A form submitted without JavaScript re-renders the page with its layouts' loader data. After the action, the layout loaders run as they do for a GET of the page, so each layout renders its own data, its `meta` resolves from that data (a layout that loads the locale sets `<html lang>`), and the document's hydration data carries it. A gate still runs once, before the action. A layout or page loader that throws or calls `notFound()` after the action renders the same error boundary or status page a GET would, and an answer that shows layout data is `private, no-store`.
