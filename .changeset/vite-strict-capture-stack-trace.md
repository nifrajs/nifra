---
"@nifrajs/web": patch
---

The Vite production build now works on runtimes whose `Error.captureStackTrace` is stricter than V8's.

`captureStackTrace` is a V8 API and V8 decorates any object handed to it. Some runtimes require a real
Error - one with the internal slot, which an object merely inheriting `Error.prototype` does not have -
and throw `First argument must be an Error object`.

Vite bundles `follow-redirects`, which defines its error types the pre-class way:

    CustomError.prototype = new (baseClass || Error)()

That constructs the base class while defining the subclass, so `captureStackTrace` receives an object
that inherits from Error but was never built by it. On a strict runtime the throw happens while vite's
own module is still evaluating, so `import("vite")` fails outright and every Vite build dies with a
message about stack traces that names nothing about vite.

`loadVite` now probes for that strictness and, only when present, restores the V8 contract: it delegates
to the runtime and swallows the refusal, since decorating a stack is best-effort. A runtime that already
follows V8 is left untouched.

Also: a Vite build that fails for any reason no longer reports "vite is not installed" when vite is
installed and merely failed to load - a resolution failure and an evaluation failure are now described
as what they are.
