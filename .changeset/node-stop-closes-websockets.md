---
"@nifrajs/node": patch
---

`stop()` closes open WebSockets with code 1001 and terminates any still open when `drainMs` runs out. Before, an upgraded socket kept serving messages after `stop()` returned. An upgrade still resolving when `stop()` runs is terminated instead of opened.
