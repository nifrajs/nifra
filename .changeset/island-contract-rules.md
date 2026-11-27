---
"@nifrajs/cli": minor
"@nifrajs/web": patch
---

`nifra check` reports three more island mistakes. NF-C064 flags a `data-island` host whose id no `mountIslands` map lists. NF-C065 flags the props a host passes when they differ from the enhancer's props type: a missing required prop, an undeclared one, or a literal of another primitive type. NF-C066 flags a `data-bind-attr` pair the runtime refuses.

The binding runtime now also refuses a URL attribute (`src`, `href`, `data` and the like) on `script`, `iframe`, `object`, `embed`, `link` and `base` elements, and every attribute on the SVG animation elements `set`, `animate`, `animateMotion` and `animateTransform`, which a bound value could previously set. A bound `to` or `values` on an animation can set a link's `href` to a script URL that the link then runs. The markup-island bundle grows by 74 B gzipped.
