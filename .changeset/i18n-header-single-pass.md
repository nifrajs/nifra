---
"@nifrajs/i18n": patch
---

`resolveLocale` and `negotiateLocale` match `Accept-Language` in one pass with a map lookup per range, choosing the same locale as before. A 16 KB header of 1,333 ranges against 40 locales took 6.8 ms per request, because every range was sorted and compared with every locale. It now takes 0.19 ms. A normal header takes 5 us instead of 12 us.
