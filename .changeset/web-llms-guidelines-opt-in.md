---
"@nifrajs/web": minor
---

`/llms.txt` and `/llms-full.txt` no longer publish the project's `AGENTS.md`. Those endpoints are
public and unauthenticated, while `AGENTS.md` is a repo file written for the team - unreleased feature
names, internal hostnames, and "don't touch X yet" notes live in it routinely, and every app that
happened to have one was serving it to anyone who asked. Set `publishLocalGuidelines: true` on
`createWebApp` to restore the old behaviour for a repo whose guidelines you would publish as a page.
Everything else in both endpoints (routes, pages, client-call examples) is unchanged.
