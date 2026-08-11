---
"@nifrajs/web": patch
---

`loadGoogleFont` emits a variable weight range in the dotted form the fonts endpoint expects. A
range spelled CSS-style (`"100 900"`) was passed through with its literal space, which the endpoint
answers with a `400`; both spellings are accepted now and normalized to `"100..900"`. A reversed or
degenerate range (min not less than max) throws at the call site instead of producing a request that
fails at load time.
