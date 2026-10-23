---
"@nifrajs/agent-protocol": minor
"@nifrajs/acp": patch
"@nifrajs/pi": patch
"@nifrajs/coding-agent": patch
---

`@nifrajs/agent-protocol` exports `childProcessEnv` and `childProcessBaseEnv`: the environment a host
hands a process it spawns, built from the platform and host environment the caller passes. The ACP
and Pi backends and the coding agent's isolated extension worker build their child environments with
it, so all three pass the same Windows set. An ACP agent on Windows now also receives `BUN_INSTALL`
and `USERDOMAIN`.
