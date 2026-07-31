---
"@nifrajs/client": patch
---

A binary response arrives intact, as a `Blob`.

The client handled JSON and then fell back to `.text()` for everything else. Decoding bytes as UTF-8
does not fail, it SUBSTITUTES: every invalid sequence becomes U+FFFD, so a PNG came back as a string
of replacement characters that could not be turned back into the image.

    sent      89 50 4e 47 ff d8
    received  ef bf bd 50 4e 47 ef bf bd ef bf bd

That is worse than refusing the body, because it reads as a broken file rather than a broken client.

The media type decides now: JSON decodes as before, text decodes as before, everything else comes back
as a `Blob` carrying its type. `text/*` is untouched, and so is anything ending `+xml` or `+json` -
an SVG is a document, and returning one as a `Blob` would break callers reading it as markup. A
response with no content-type is still parsed as JSON-or-text, which is what a hand-written
`new Response("…")` produces.
