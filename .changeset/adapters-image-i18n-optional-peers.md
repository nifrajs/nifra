---
"@nifrajs/web-react": minor
"@nifrajs/web-vue": minor
"@nifrajs/web-svelte": minor
"@nifrajs/web-solid": minor
"@nifrajs/web-preact": minor
---

`@nifrajs/image` and `@nifrajs/i18n` are optional peers of every UI adapter rather than
dependencies, so an app installs them only when it imports the adapter's `/image` or `/i18n` entry.
An app that imports either entry adds the matching package beside the adapter; one that already
imports it directly, as the image and i18n guides show, needs nothing more.
