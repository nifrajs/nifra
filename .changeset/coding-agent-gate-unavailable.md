---
"@nifrajs/coding-agent": minor
---

A post-turn gate whose command is not installed no longer starts repair turns. `runNifraVerification` returns `unavailable: true` when the gate's command cannot be found or run (a missing working directory still counts as a failure), and `createVerificationRepairTask` makes no task for it, so the host emits one `verification.completed` with `ok: false` and the turn ends. Before, a missing `nifra` binary sent the agent up to `maxRepairAttempts` repair turns asking it to fix the project. `isVerificationAvailable(name, { cwd, command?, env? })` answers the same question before a turn without running the gate.
