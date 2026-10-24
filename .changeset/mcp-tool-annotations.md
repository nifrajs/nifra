---
"@nifrajs/cli": patch
"@nifrajs/content": patch
"@nifrajs/web-react": patch
"@nifrajs/web-preact": patch
"@nifrajs/web-solid": patch
---

Every `nifra mcp` project tool carries MCP tool annotations, so a host can tell the tools that only read the project from the ones that write files or run project code and ask before those. A tool that writes only under a flag, such as `nifra_review` with `fix` and `write`, is marked as a writer. A tool that imports the project's config or backend runs its top-level code, so `nifra_routes`, `nifra_context`, `nifra_openapi`, `nifra_diff`, `nifra_prove` and the `nifra_db_*` tools are marked as running project code. Each tool's input fields that had no description now have one. The `nifra --help` line for `nifra docs-mcp` names all six tools that server offers.

`entry.html` from `@nifrajs/content` is documented as unsanitized Markdown output: render it with `trustHtml(entry.html)` for content you wrote, or run it through `sanitizeHtml(entry.html, yourSanitizer)` when contributors or a CMS write it. The `<Content>` examples in the React, Preact and Solid adapters show the `trustHtml` call.
