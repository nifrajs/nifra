---
"@nifrajs/core": minor
"@nifrajs/client": minor
---

A route can declare that it returns bytes, and the client types it as `Blob`.

```ts
import { bytes } from "@nifrajs/core/binary"

app.get("/invoice.pdf", async (c) =>
  bytes(await render(c.params.id), { type: "application/pdf", filename: "invoice.pdf" }),
)
```

Sending bytes was always possible - return a raw `Response` - but a raw `Response` is exactly what the
typed client cannot describe. So a download route needed a `// nifra-expect raw-response` pragma to
quiet the drift advisory, and its caller got no type at all. One category of endpoint sat outside the
contract the framework is otherwise strict about.

`bytes()` closes that. The brand it carries is a phantom - nothing is added to the value at runtime -
and it exists so the type can say a thing the value cannot: that these bytes are the payload rather
than a serialization accident. A plain `Response` is unaffected and still types as it did.

`filename` is quoted and stripped of the characters that would end the header value early, because the
ordinary case is a name derived from user data - an upload's original name, a document title.
