---
"@nifrajs/cli": patch
---

`nifra check` runs the checks that read zones (NF-C028 to NF-C033) and the server-only import check (NF-C004) only on nifra code. The directory the check runs in always counts. Below it, a package whose package.json names neither `nifra` nor a `@nifrajs/` package and has no `nifra` setting, with no `nifra.config.ts` or `backend/framework.ts` on the way up, is another project, such as another framework's app kept in the same repository, so its `routes/` folder is not read as nifra routes.
