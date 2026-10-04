---
"@nifrajs/middleware": minor
---

Several response middlewares are stricter about what they read and write:

- `problemDetails()` inspects a raw error response only when it is JSON and not declared larger than `maxBytes`, so a streamed HTML error page or an endless stream is no longer read before the response is sent.
- `prettyJson()` re-indents JSON without re-serializing it, so an integer past 2^53, `1e400`, `-0`, and string escapes reach the client exactly as written.
- `multipartResponse()` quotes a boundary that holds a parameter delimiter (`( ) , / : = ?` or a space), so a parser reads the whole boundary.
- `requestId()` uses an inbound id only when it is 1-200 visible ASCII characters, replacing anything else with a generated id. A new `accept` option replaces that rule.
- `language()` reads at most the first 32 ranges of `Accept-Language`.
- `compression()` weakens a strong `ETag` on the gzip representation, which is a different byte sequence from the one the tag named.
