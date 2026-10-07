---
"@nifrajs/web": patch
---

The Vite dev server with `poll: true` (or `CHOKIDAR_USEPOLLING=1`) no longer loses a route file added or removed just after startup. The polling watcher reports ready before it has taken its first reading of a directory, so a change in that gap was never reported: the route stayed out of the route table and the client entry, or a deleted one stayed in, until something else in the directory changed. The dev server now rescans the routes directory on each poll and refreshes both for any route file the watcher did not report.
