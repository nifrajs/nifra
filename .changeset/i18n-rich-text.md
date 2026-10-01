---
"@nifrajs/i18n": minor
"@nifrajs/web-react": minor
"@nifrajs/web-preact": minor
"@nifrajs/web-solid": minor
"@nifrajs/web-vue": minor
"@nifrajs/web-svelte": minor
---

feat(i18n): rich text from catalog messages without HTML

`rich(formatter, key, tags, vars)` from the new `@nifrajs/i18n/rich` entry formats a message like
`t()` and turns its `<name>…</name>` and `<name/>` tags into calls to `tags[name]`, returning the
message as text and whatever the handlers returned. Tags are bare names (no attributes); a tag
without an own handler keeps its content as text, an unclosed or stray marker stays literal, and
interpolated values and `#` are never read for tags. `renderRich(renderer, ...)` is the same for a
UI framework.

React, Preact, Solid and Vue export `rich(t, key, tags, vars)` from `/i18n`, returning one node
(each handler receives its tag's content as one node, and `<br/>` renders a `<br>` unless `br` is
given). Svelte exports `<Rich key tags vars>`, which takes one snippet per tag, and `rich()` for the
parts array. `t()` is unchanged.
