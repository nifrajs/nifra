---
"@nifrajs/cli": patch
---

`nifra migrate layout` rewrites an alias import of a moved module as a relative path when no target of that alias covers the new location (`"@/*": ["./src/*"]` cannot name `frontend/src/`), instead of leaving it as written. Every rewritten specifier, aliased or relative, is checked to resolve to its module in the layout the migration leaves, and one that does not is reported. An alias with a `?query` suffix resolves and keeps its suffix, a package.json `#import` keeps its leading `#`, and an import of a moved route export through an alias that cannot name the backend half is pointed at it by a relative path.
