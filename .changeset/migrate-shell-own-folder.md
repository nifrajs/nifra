---
"@nifrajs/cli": patch
---

`nifra migrate layout` re-points the paths a moved shell script builds from its own folder: `$(dirname "$0")/..`, `$(dirname "${BASH_SOURCE[0]}")/../..` and `${0%/*}/x.sh` name the same place from the script's new folder. A script that uses its folder with no literal path after it, such as `$(cd "$(dirname "$0")" && pwd)`, is reported as an issue to check by hand.
