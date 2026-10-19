---
"@nifrajs/events": patch
---

An event contract's `is` guard now works detached from its contract, so `events.filter(OrderPaid.is)` checks each value instead of throwing `TypeError`.
