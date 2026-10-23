---
"@nifrajs/coding-agent": patch
---

`migrateLegacySession` refuses overlapping roots on Windows. A `targetRoot` inside `sourceRoot`, or the
reverse, was accepted there because only `/` counted as a separator; it now fails with
`overlapping_roots` as it does on macOS and Linux. On Windows, roots that differ only in letter case
also count as the same directory.
