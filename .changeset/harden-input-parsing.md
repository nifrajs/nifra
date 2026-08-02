---
"@nifrajs/web": patch
"@nifrajs/web-vue": patch
"@nifrajs/web-svelte": patch
"@nifrajs/core": patch
"@nifrajs/better-auth": patch
"@nifrajs/node": patch
"@nifrajs/cli": patch
---

Security hardening across input parsing and code generation. Every regex that runs on caller-influenced input (URL paths, route patterns, stylesheet and SVG sources, manifest text) is now linear - no polynomial backtracking on adversarial input. SVG preamble stripping and tag removal can no longer splice removed delimiters into new markers. Static file serving rejects `..` traversal in the request form outright and confines the resolved path with a `relative()` containment check. Generated code embeds strings through an escaper that neutralizes `</script>` breakout and the U+2028/U+2029 line separators, and HTML entity decoding resolves `&amp;` last so double-encoded entities cannot double-unescape.
