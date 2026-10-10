---
"@nifrajs/islets": patch
"@nifrajs/web": patch
"@nifrajs/web-react": patch
---

Dispose island event listeners and release mounted hosts so the same DOM can safely remount.

Ignore stale session reads after sign-out, unmount, or replacement of the auth client or loader seed.
A new auth client object keeps the session already shown, and a completed sign-out stays signed out.

Allow concurrent web assurance evidence reads while rejecting recursive mount cycles. Read mounted
in-process backend evidence for generated application guidance, preserving mount prefixes and
keeping loader-only backends out of the published route list. Generate callable paths for reserved
typed-client segments and keep declared DELETE bodies in call options.
