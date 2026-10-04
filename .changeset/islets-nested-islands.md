---
"@nifrajs/islets": patch
---

Islands may nest: a binding belongs to its nearest island, so an outer island no longer binds the markup inside a nested island (which then followed the outer island's signals and handlers). The nested host element itself stays the outer island's markup and can still be bound by it.
