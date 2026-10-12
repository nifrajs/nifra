---
"@nifrajs/coding-agent": patch
---

On Windows, an extension module on a different drive from the project root is refused as outside the project, by both the in-process `ExtensionHost` and `IsolatedExtension`. A project directory whose name starts with `..` (such as `..cache`) is no longer mistaken for one outside it.
