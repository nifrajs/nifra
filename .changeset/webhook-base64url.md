---
"@nifrajs/core": minor
---

`verifyWebhook` accepts `encoding: "base64url"` for providers that sign in the URL-safe alphabet. Padded and unpadded signatures verify; any character outside the alphabet, misplaced padding or an impossible length is refused as `malformed_signature`. Verification stays constant-time.
