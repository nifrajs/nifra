---
"@nifrajs/core": patch
---

A body schema now reads an `application/x-www-form-urlencoded` body whatever the media type's case, and with whitespace before its parameters (`Application/X-WWW-Form-Urlencoded`, `application/x-www-form-urlencoded ; charset=UTF-8`), as it already did for JSON. Such requests were refused with 415.
