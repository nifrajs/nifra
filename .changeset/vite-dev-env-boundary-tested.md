---
"@nifrajs/web": patch
---

The dev server's public-env boundary is covered by a test that drives it.

Vite inlines any `VITE_*` variable into client source by default, which is a second boundary running
beside Nifra's `PUBLIC_` one - so a `VITE_DATABASE_URL` reached the browser without passing the policy
meant to decide that. Both pipelines were fixed, but only the production build was tested. A guard
holding in one pipeline while the option reads like protection in both is the exact shape of the bug
that motivated the fix.

The dev server now has the equivalent: a real dev server, a module asking for both variables, and an
assertion about what it actually serves. It fails without the fix, and it cannot pass on an error page.
