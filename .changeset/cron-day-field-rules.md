---
"@nifrajs/cron": patch
---

A day-of-month or day-of-week field that starts with `*`, such as `*/2`, no longer counts as restricted for the day-of-month/day-of-week OR rule, matching Vixie cron. `0 0 */2 * 1` now fires at midnight on an odd day that is also a Monday; before, it fired on every odd day and on every Monday. Day-of-week `7` is now accepted as Sunday, alone or in a range such as `5-7`; before, it was refused as out of range. A star or a bare step in day-of-week still stops at 6, so `1/2` keeps meaning Monday, Wednesday and Friday.
