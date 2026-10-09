---
"@nifrajs/web": patch
---

The draft-mode cookie now carries its expiry inside the signed value, and `isDraftEnabled` refuses it once that time passes. Before, every editor got the same signed marker, and the server never checked its age, so a copied cookie worked until the draft secret was rotated. `maxAgeSeconds` sets both the cookie's `Max-Age` and the signed expiry, and it must be a positive whole number of seconds. Cookies issued by earlier versions carry no expiry and are refused, so an editor enables draft mode once more after upgrading.
