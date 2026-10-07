---
"@nifrajs/web": minor
---

Under the default key, `withISR` no longer serves a stored page to a request carrying `Authorization` or a cookie: such a request renders fresh, because a signed-in visitor's page can differ from the anonymous one, and its private render no longer marks the URL uncacheable for everyone. The new `anonymousCookies` option lists cookie names that never change the page, such as consent or analytics cookies; a request whose cookies are all listed is served and stored like one with none. A custom `key` keeps deciding for itself.
