---
"@nifrajs/content": minor
---

`entry.html` is now rendered by marked 18 (was 15). A code span that wraps across lines inside a list item stays one span, and a single `~` before a number is text instead of strikethrough; HTML blocks and tables no longer carry the blank lines that followed them in the source. Re-bake collections to pick the change up, and review any snapshot of `entry.html`.
