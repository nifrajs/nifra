---
"@nifrajs/islets": patch
---

`data-bind-attr` never binds an `on*` event-handler attribute or `srcdoc`, and a URL attribute (`href`, `src`, `action`, `formaction` and the like) is set only to an http(s), mailto, tel or relative URL; any other value removes it. Markup that names one of those is skipped with a one-time warning.
