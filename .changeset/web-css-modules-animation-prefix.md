---
"@nifrajs/web": patch
---

The CSS Modules transform scopes the keyframe name in a vendor-prefixed `-webkit-animation` / `-webkit-animation-name` declaration and in a declaration that follows a comment (`/* slow */ animation: spin 3s`). Before, both kept the unscoped name and the animation silently did not run.
