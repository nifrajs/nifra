---
"@nifrajs/cli": minor
---

`nifra check` reads the JSX of `.tsx` files for accessibility, as two warning codes. NF-C062 reports ARIA that assistive technology cannot read: a role that does not exist or is abstract, a misspelled `aria-*` attribute, a value an attribute does not take, and a role missing an attribute it requires. NF-C063 reports markup that reads worse than it could: an `<img>`, `<input type="image">` or `<area href>` with no `alt`, a positive `tabindex`, a `<div role="button">` where a native element fits, a role the element already has, and an `<html>` with no `lang`. Only a lowercase element whose attributes are written out is judged, so an element with a spread, a component and a value built as an expression are left alone. `// nifra-expect NF-C063: <reason>` or `nifra-expect a11y: <reason>` above an element accepts a finding on purpose.
