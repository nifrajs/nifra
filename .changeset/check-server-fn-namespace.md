---
"@nifrajs/cli": minor
---

`nifra check` adds NF-C056 (error): `serverFunctions("todo", todos)` where `todos` is a namespace import of `todos.fn.ts`. The client stubs call the namespace named by the file, so a mount under another word 404s on every call. A mount kept on purpose takes `// nifra-expect NF-C056: <reason>` above the call.
