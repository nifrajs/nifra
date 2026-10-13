---
"@nifrajs/cli": patch
---

`nifra check` reports a raw `Response` return (NF-C007) only inside a route handler: a function passed to `.get("/path", …)` and the other method registrations, a function value of an `implement(contract, {...})` map, a local function either one names, and a local function a handler returns a call to. A helper that returns a `Response` for an auth stage's `rejected`, or any other function no route registers, is no longer flagged. A handler registered from data, such as a loop over route objects, is not followed.
