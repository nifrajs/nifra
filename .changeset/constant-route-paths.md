---
"@nifrajs/cli": minor
---

The static route scan reads a path given as a module-level string `const`, with or without `as const`, in the same file or exported from a project file it imports, and a template with no substitution. Capability provenance and the route lints now see those routes. A route whose path is another expression, such as an interpolated template, gets an NF-C036 finding (info) that names the expression; `// nifra-expect dynamic-route-path` above the registration accepts it.
