---
"create-nifra": patch
---

The project name is validated before any file is copied. It is substituted into generated deploy
scripts that a shell runs (`--name NAME`), so a directory name carrying shell metacharacters, spaces,
or a leading `-` used to reach those scripts intact. The accepted set is npm's own for an unscoped
name - letters, digits, `.`, `-`, `_`, starting with a letter or digit, up to 214 characters - so
ordinary names like `MyApp` still scaffold. Rejecting up front also means a bad name no longer leaves
a half-written project directory behind.

Every action in the generated CI workflows is pinned to a commit SHA rather than a mutable tag, so a
scaffolded repo starts on the same footing this one uses.
