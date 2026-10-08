---
"@nifrajs/core": minor
"@nifrajs/cli": minor
"@nifrajs/testing": minor
"@nifrajs/web": minor
---

An opaque mount can declare the routes it serves: `opaque: { reason, routes: [{ method, path, capabilities }] }` on `mount()`, `mountFetch()` and a `createWebApp` `mounts` entry. Capability assurance reports those routes with `analysis: "declared"` beside the known gap, checks their capabilities against the policy (an unknown id, or a domain write on a safe method, fails), and records them in the lockfile. `reflectMounts` returns them, project evidence carries them, the `nifra context` index lists them, and an adversarial contract run notes them as having no contract to test. A malformed declaration or a path outside the mount stops the analysis with an error that names it. A mount without a reason fails as before.
