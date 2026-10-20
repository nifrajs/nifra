# @nifrajs/cron

## 5.5.1

No changes in this release.

## 5.5.0

No changes in this release.

## 5.4.0

No changes in this release.

## 5.3.0

No changes in this release.

## 5.2.1

No changes in this release.

## 5.2.0

### Patch Changes

- 9498cf8: The package ships its `CHANGELOG.md`, so the installed package has the notes for every version, as the GitHub release does. Before, the tarball held only the code, `README.md`, `LICENSE` and `package.json`.

## 5.1.0

### Patch Changes

- 8ba483b: A day-of-month or day-of-week field that starts with `*`, such as `*/2`, no longer counts as restricted for the day-of-month/day-of-week OR rule, matching Vixie cron. `0 0 */2 * 1` now fires at midnight on an odd day that is also a Monday; before, it fired on every odd day and on every Monday. Day-of-week `7` is now accepted as Sunday, alone or in a range such as `5-7`; before, it was refused as out of range. A star or a bare step in day-of-week still stops at 6, so `1/2` keeps meaning Monday, Wednesday and Friday.

## 5.0.0

### Patch Changes

- dce480c: `parseCron` now accepts only plain decimal terms (`*`, `n`, `a-b`, each with an optional `/step`) and rejects `-5`, `1-2-3`, `0x1F`, `1e1`, `+3` and `*/5/7`, which used to parse into surprising schedules. A bare value with a step, such as `5/15`, now runs from that value to the end of the field (5, 20, 35, 50) as standard cron does; it used to mean only 5.

## 4.0.2

## 4.0.1

## 4.0.0

## 3.5.0

## 3.4.0

## 3.3.0

## 3.2.0

## 3.1.0

## 3.0.0

## 2.14.1

## 2.14.0

## 2.13.0

## 2.12.1

## 2.12.0

## 2.11.0

## 2.10.0

## 2.9.1

## 2.9.0

## 2.8.2

## 2.8.1

## 2.8.0

## 2.7.1

## 2.7.0

## 2.6.1

## 2.6.0

## 2.5.0

## 2.4.0

## 2.3.0

## 2.2.0

## 2.1.0

## 2.0.0

## 1.13.0

## 1.12.0

## 1.11.0

## 1.10.0

## 1.9.1

## 1.9.0

## 1.8.0

## 1.7.0

## 1.6.0

## 1.5.0

## 1.4.0

## 1.3.1

## 1.3.0

## 1.2.2

## 1.2.1

## 1.2.0

## 1.1.0

## 1.0.0

## 1.0.0-beta.4

## 1.0.0-beta.3

## 0.1.0-beta.2
