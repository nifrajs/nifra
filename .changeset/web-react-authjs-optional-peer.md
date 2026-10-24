---
"@nifrajs/web-react": patch
---

`@nifrajs/authjs` is an optional peer of `@nifrajs/web-react` instead of a dependency, so a React app
installs Auth.js only when it uses it. An app that imports `@nifrajs/web-react/auth` installs
`@nifrajs/authjs` itself.
