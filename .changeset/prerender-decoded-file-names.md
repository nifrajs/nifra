---
"@nifrajs/web": patch
---

Prerendering writes each page under the decoded path a static host looks up: `/caf%C3%A9` is written to `café/index.html` instead of `caf%C3%A9/index.html`. Hosts, and nifra's own static file serving, decode the request path before they look for a file, so a page whose path had a non-ASCII or space character was never found. A path with a segment that no file name maps back to, such as a param that decodes to `/`, `\` or `..`, is skipped instead and left to the server to render.
