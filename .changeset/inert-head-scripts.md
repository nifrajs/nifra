---
"@nifrajs/web": minor
---

`head.script` carries data; executable code goes through a named escape hatch with a CSP nonce.

```ts
head: {
  script: [{ content: JSON.stringify(article) }],          // application/ld+json or application/json
  unsafeScript: [unsafeInlineScript("window.dataLayer = []", { nonce })],
}
```

**Breaking**, deliberately. The slot used to take any `type`, including `module`. Its escaping guards
against closing the element early - `</script>`, `<!--`, `]]>` - which is exactly what inert JSON needs
and is no protection whatsoever for code. A route interpolating loader data into an executable body
therefore had escaping that looked like a boundary and was not one. The slot now accepts only what it
can actually make safe: a wrong `type` is a compile error, and it throws at render for callers the
types do not reach.

`unsafeInlineScript()` is the replacement, named after what it is and requiring a nonce. Pass the same
nonce to `renderPage` and it reaches every framework-owned script in the document - the hydration
bootstrap, the pre-hydration guard, the data script, streamed deferred resolutions, island tags, and an
adapter's own hydration head - so a strict `script-src 'nonce-…'` policy becomes achievable rather than
aspirational. A render without a nonce emits exactly the bytes it did before.

Both `type` fields are allowlists rather than escaped values, checked in one place for the server
render and the client soft-navigation together: a head that renders and then throws on the next
navigation is worse than one that never rendered.
