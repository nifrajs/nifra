---
"@nifrajs/web": patch
---

The server-components HTML check (run before SSR, on decoded component state, and by the opt-in Trusted Types default policy) reads `title` and `textarea` content the way a browser does. A browser treats that content as text, so `<title><!--</title><img onerror=...>-->` showed the validator a comment while the browser built an `<img>`. Content of those two elements must now hold no raw `<` before its own end tag, which escaped framework output never does, and `noembed` and `noframes` are refused like the other text-mode elements.
