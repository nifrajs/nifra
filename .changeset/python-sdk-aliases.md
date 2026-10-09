---
"@nifrajs/cli": patch
---

The generated Python SDK imports when a named array or union schema refers to a model declared after it: model aliases are now lazy `type` statements. Responses and error bodies typed by an alias now decode into their models instead of staying plain dicts.
