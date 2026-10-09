---
"@nifrajs/web": patch
"@nifrajs/web-react": patch
---

The React server-components pipeline is certified on React, React DOM and `react-server-dom-webpack` 19.2.8, which fixes GHSA-wx67-qw84-cm4g (a denial of service in server-function decoding) present in 19.2.7. The pipeline requires the three at exactly 19.2.8; upgrade them together.
