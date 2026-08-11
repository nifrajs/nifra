---
"@nifrajs/core": minor
---

Route-assurance rules can distinguish enforcement from assertion, and can select routes by data
sensitivity.

- **`requireProvenance`** on a rule: `"any"` (default, unchanged) accepts every evidence entry;
  `"runtime"` accepts only evidence installed by middleware, a plugin, or framework runtime policy
  and rejects an author's inline `schema.assurance` claim; `"declared"` is the inverse, useful for
  reviewing what handlers assert about themselves. Provenance is carried non-enumerably on each
  evidence entry, so existing reflected route descriptors keep their exact serialized shape.
- **`requireCsrfWithAuthenticated`** on a rule: an authenticated route selected by that rule must
  also carry runtime CSRF evidence. Intended for rules covering cookie- or session-authenticated
  browser routes; bearer-only APIs have no ambient-authority exposure and belong in their own rule.
- **`match.classificationAtLeast`**: select routes whose declared response classification is at
  least `"public"`, `"pii"`, or `"secret"`, so a policy can demand more of the routes that carry
  more.

A failure message names the required provenance when it is not `"any"`, so the report says which
kind of evidence is missing rather than only which id.
