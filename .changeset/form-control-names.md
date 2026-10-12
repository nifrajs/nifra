---
"@nifrajs/web": patch
---

Client form handling reads a form's `method`, `action` and `target` through the `HTMLFormElement` accessors and its `data-nifra-revalidate` attribute through `getAttribute`. A control named `target`, `action` or `method` shadows the form property of that name, so a form with `<input name="target">` was treated as targeting another frame and submitted with a full page load instead of the client router.
