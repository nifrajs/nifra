---
"@nifrajs/web": patch
"@nifrajs/schema": patch
---

The output guard now validates a `t` schema's projected value without re-checking each projected object for undeclared keys, which projection had already removed. The check walked every object of loader, action and server-function data a second time on each request. One behavior changes with it: an object in that data carrying a non-enumerable undeclared property is no longer refused. The property is still never sent, since JSON skips it and client component props refuse it.
