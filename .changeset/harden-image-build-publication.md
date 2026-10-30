---
"@nifrajs/image": patch
"@nifrajs/web": patch
---

Publish cached and emitted image files atomically, and name the file to delete when one does not match its content hash. Keep animated images as the original instead of failing a build that resizes others. Reuse processed variants across the client and server builds. Keep image files out of the size report and write each emitted file once per build. Open source images through a pinned descriptor. Accept an absolute http(s) `publicPath` and refuse a plugin built for a different one. Answer dev requests outside the image prefix without parsing them.
