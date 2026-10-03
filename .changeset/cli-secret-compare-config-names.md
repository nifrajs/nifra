---
"@nifrajs/cli": patch
---

NF-S002 flags a comparison against a secret read from configuration: an `UPPER_SNAKE` member such as `process.env.API_TOKEN` or `env.WEBHOOK_SECRET`, and a string-keyed read such as `process.env["API_KEY"]`. PascalCase enum members such as `ts.SyntaxKind.PlusToken` stay unflagged.
