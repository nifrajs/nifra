---
"@nifrajs/web": patch
---

A route file whose name has a space or non-ASCII characters, such as `routes/café.tsx` or `routes/a b.tsx`, now serves its page. Browsers request those paths percent-encoded (`/caf%C3%A9`), and the server and client routers compared them against the raw name, so the page always answered 404. Route patterns are now matched in their requested form, composed (NFC) first, while `route.pattern` keeps the name as written.
