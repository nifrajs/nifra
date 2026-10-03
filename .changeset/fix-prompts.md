---
"@nifrajs/web": minor
"@nifrajs/cli": minor
---

Errors come with a prompt to paste into a coding agent: the error, where it is, the recognised cause, one fix, and steps that end in a check the agent runs itself (`nifra_errors` with a `since` cursor, then `nifra check`). App-supplied text is fenced and labeled as data, paths are project-relative, the home directory never appears, and the prompt is capped at 8000 characters.

- Codes with more than one right fix (`NIFRA_BACKEND_IN_CLIENT`, `NIFRA_BACKEND_ONLY_IN_CLIENT`, `NIFRA_OUTPUT_SENSITIVE_FIELD`, `NIFRA_OUTPUT_UNDECLARED_DEFERRED`, `NIFRA_OUTPUT_RAW_RESPONSE`, `NIFRA_OUTPUT_SCHEMA_MISMATCH`) list each as a labeled `fixOptions` entry on the `Diagnostic`, with one prompt per option.
- The dev overlay has a Copy prompt button per fix. A page load whose render throws gets the overlay on both dev pipelines; data requests and API calls keep the app's JSON 500.
- A dev page that reports a browser error shows a badge listing that page's errors with their code, message, codeframe, fix and Copy prompt buttons. It renders in a closed shadow root, loads under the page's CSP (nonce, exact URL, or `'strict-dynamic'`), is only fetched once a page errors, and turns off with `nifra dev --no-indicator` or `indicator: false` on `createDevServer`/`createViteDevServer`.
- `nifra errors --prompt` (and `nifra_errors` with `prompt: true`) prints the prompt for the newest entry; `--id` picks an entry and `--option` picks a fix by its label.
- `@nifrajs/web/diagnostic-prompt` exports `buildFixPrompt`, `fixPrompts` and `catalogFixPrompts` without Node APIs, for use in a browser bundle.
