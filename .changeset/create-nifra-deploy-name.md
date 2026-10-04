---
"create-nifra": patch
---

A project whose name has capitals, `_`, or `.` (`MyApp`, `my_app`) gets a Docker image tag, a `wrangler.toml` `name`, and Cloudflare Pages and Deno Deploy CI project names in lowercase letters, digits, and `-`, the form those platforms take. `package.json` keeps the name as given.
