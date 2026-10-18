---
"@nifrajs/web": patch
"@nifrajs/web-react": patch
---

The React server-component pipeline is certified on React, React DOM and `react-server-dom-webpack` 19.3.1. The plugin's version guard and `nifra check` now expect 19.3.1, and `@nifrajs/web-react` peers on `react-server-dom-webpack` 19.3.1; an app on 19.2.8 upgrades all three together.
