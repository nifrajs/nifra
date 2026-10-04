---
"@nifrajs/agent-app": patch
---

The view models hold their input to one shape:

- `boundaryIsStale` treats an expiry or a clock that is not a number as stale, so `boundaryCommands` offers no command for that boundary.
- `toRunStudioView` refuses a run graph that lists the same node twice, instead of rendering it twice and counting it twice.
- `toReviewView` reads the `report` inside a host result as a review report only. A host result nested inside another projects as the `invalid-report` unavailable view. Duplicate finding ids are checked in linear time, so a report at the 4,096-finding cap parses in about 5 ms instead of 22 ms.
