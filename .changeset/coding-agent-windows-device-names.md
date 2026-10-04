---
"@nifrajs/coding-agent": patch
---

On Windows, a session whose id starts with a reserved device name (`con`, `nul`, `aux`, `prn`, `com0`-`com9`, `lpt0`-`lpt9`, in any case, alone or before a `.`) is stored under a file name with its first character percent-encoded, since Windows treats `nul.jsonl` as the NUL device.
