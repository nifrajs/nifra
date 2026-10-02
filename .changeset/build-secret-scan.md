---
"@nifrajs/web": major
---

feat(web)!: client builds fail on what looks like a credential

Every client build (Bun and Vite), every `public/` copy and every prerendered page and `_data.json`
is scanned before it is written. The build fails, naming the file and line, on:

- a PEM private key, a URL with a password, or a known secret token format (AWS access keys, Stripe
  secret and webhook keys, GitHub, Slack, OpenAI, Anthropic, SendGrid, Twilio, Mailgun and npm tokens,
  service-role JWTs); publishable keys are not flagged;
- a random-looking string assigned to a secret-like name (`apiKey`, `clientSecret`, ...) in the app's
  own browser code;
- the value of a build environment variable that is not public, raw or URL, JSON, HTML or base64
  encoded, when its name says it is a secret or the value looks random.

A finding in a bundle names the module it came from. The report never prints the value. A reviewed
false positive is exempted with `secretExemptions` on the build options (`nifra.config.ts` for
`nifra build`): `{ rule, file, reason }`, or `{ rule: "private-env-value", env, reason }`. There is no
exemption by value. `prerenderRoutes` takes the same exemptions as `secrets`. `@nifrajs/web/zones`
exports the scanner as `scanForSecrets`.
