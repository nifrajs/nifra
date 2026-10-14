---
"@nifrajs/cli": patch
---

When `nifra mcp` takes SIGINT, SIGTERM or SIGHUP, it stops every child it runs in its own process group (warm workers, a hydration run, a `nifra check` typecheck), waits for each group to exit, sends SIGKILL to what is left after the kill grace period, and only then takes the signal. It took the signal at once, so a worker that catches SIGTERM, or a process it started that ignores it, outlived the server; a Ctrl+C in the terminal no longer reaches a child in its own group directly. A second signal while the children stop ends the server at once.
