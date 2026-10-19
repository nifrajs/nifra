---
"@nifrajs/auth": patch
"@nifrajs/web": patch
"@nifrajs/cli": patch
"@nifrajs/client": patch
---

Close five release-audit findings. Session managers now refuse eventually consistent adapters,
including KVSessionStore: stale reads could restore a logged-out session and let it keep renewing.
Existing KV-session applications must migrate to a strongly consistent shared SessionStore; the
legacy adapter remains exported for reading and migration. Host reachability reports truncation
when declared pages remain and cancels binary asset bodies without decoding them. CLI scans honor
Git ignores for Unicode and literal special filenames. WebSocket message iterators queue concurrent
reads and settle all pending reads when they end.
