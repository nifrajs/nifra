---
"@nifrajs/client": minor
"@nifrajs/core": patch
---

The response size limit is reachable, applies to text as well as JSON, and never applies to a download.

```ts
client<App>(url, { maxDecodedBytes: 64 * 1024 * 1024 })
```

`maxBytes` lived under `transport`, whose `codec` is required - so raising your own response limit
meant opting into a versioned transport representation you had not asked for, and the call did not
compile without it. The 16 MB default protected everyone while the knob was reachable by nobody. It is
a top-level option now, with a doc comment saying what it bounds.

It bounds text as well as JSON, because a 2 GB string costs what a 2 GB object costs and one number
should answer for both. It deliberately does NOT bound a binary body: that is a download, and a size
limit on a download is a bug rather than a defence.

Exceeding it is a result, not a throw: `{ ok: false, status: 0, error: { error: "response_too_large" } }`,
the shape a timeout already takes. It used to throw a `TransportCodecError` straight out of the client,
which meant the only safe way to use the option was the try/catch the client's contract exists to
remove. The older `transport.maxBytes` spelling still works and still wins for the transport path.
