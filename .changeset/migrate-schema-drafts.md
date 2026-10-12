---
"@nifrajs/cli": patch
---

`nifra migrate layout` drafts the missing `loaderOutput`/`actionOutput` of each backend half it writes from the function's return type, read from the layout as planned, so the dry run lists the drafts (`schemas` in the result) and `--write` writes them with the `nifra:generated` line. A half where no draft can be written (an unreadable type, `t` or the schema name already bound) is reported with the reason. NF-C030 now carries a fix: `nifra fix --code NF-C030` drafts only the declaration the finding names, the same draft `nifra schemas --write` writes, and leaves every other schema in the file as it is. A draft's marker line asks the author to review what the browser may see, and `nifra schemas` lists the returned fields a draft leaves out (credential-like names, values that are not JSON). TypeScript 7 reads a file that is not on disk yet under the root as the caller spells it.
