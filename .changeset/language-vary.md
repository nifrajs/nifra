---
"@nifrajs/i18n": patch
"@nifrajs/middleware": patch
---

`localeDetector()` and `language()` add `Vary: Accept-Language` to every response, and `localeDetector()` adds `Cookie` too when it reads a locale cookie, so a shared cache no longer serves one visitor's language to another. An existing `Vary` is extended, never replaced, and `Vary: *` is left alone.
