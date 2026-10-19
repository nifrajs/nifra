---
"@nifrajs/core": patch
---

`multipartBody()` no longer refuses a form with `413 too_many_parts` because of a file input left empty. A part with no content is still counted before the body is parsed, but against a budget of its own (`maxFields + maxFiles` empty parts) rather than the one the filled parts share, matching how such a part is dropped once parsed.
