---
"@nifrajs/web": patch
"@nifrajs/cli": patch
---

Identity-parity findings now state the install topology, and `nifra doctor` and the build guard now answer on the same basis.

Both tools already shared one walker, but they anchored it differently: doctor scanned the workspace that governs the project while the build guard scanned the app directory it was invoked in, so a duplicate that lives in a sibling workspace package could show up in one output and not the other. Since neither printed which directory it had scanned, that read as two tools contradicting each other about the same invariant. The scan is now always anchored on the governing workspace, both tools name the root they answered on, and a scan that stopped at the workspace-enumeration cap reports itself as partial instead of returning "no duplicates".

Each finding also carries a topology line: how many physical paths, how many install roots they fall under, and whether any of those roots sits outside the scanned root. That distinction is the whole fix decision - copies under one workspace collapse with a single reinstall from the root, while a copy under a linked checkout or a standalone sibling install belongs to another project and no reinstall here can remove it. Previously the error listed paths only, leaving that to be reverse-engineered.
