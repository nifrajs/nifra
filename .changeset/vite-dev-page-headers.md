---
"@nifrajs/web": patch
---

fix: Vite dev keeps a page's response headers, and a CSP page still boots

Under `nifra dev --vite` an HTML page reached the browser with only a `content-type`: the cookies a
loader set, the Content-Security-Policy, `cache-control`, `vary` and the `x-nifra-*` headers were
dropped, where the Bun dev pipeline kept them. They are kept now. On a page with a CSP, the tags
Vite adds (its HMR client, a framework's refresh preamble, the `<style>` it injects for each imported
stylesheet) carry the page's nonce - or a fresh one on a hash-based page - and each directive that
governs them names it, unless that directive already allows inline. Dev only; production responses
are unchanged.
