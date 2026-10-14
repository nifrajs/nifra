---
"@nifrajs/web": patch
---

Under a hash-based `createCspPolicy`, a buffered render that writes a script for that request alone (Solid serializing a server error an `ErrorBoundary` caught, for hydration) no longer ships it unauthorized. The render is handed a nonce; when the HTML it returns carries it, the document keeps the nonce in its `Content-Security-Policy` and becomes `private, no-store`, and every other document stays nonce-free and cacheable as before.
