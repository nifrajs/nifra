---
"@nifrajs/devtools": patch
---

The DevTools stream and `/state` snapshot require a loopback URL host (`localhost`, `127.0.0.1`, `[::1]` or `*.localhost`) as well as a loopback socket peer, as `allowRemote` documents. A request from this machine naming another host is refused unless `allowRemote` is set.
