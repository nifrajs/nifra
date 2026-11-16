---
"@nifrajs/node-uws": minor
"@nifrajs/core": minor
---

`staticResponse()` GET routes are answered by uWS itself, without a call into JavaScript, whenever nothing in the app can observe the request (no request or response hook, deadline, capacity gate, Host policy, schema, auth or other route-level stage). New `echoParam(name)` answers a GET route with its last path parameter as text, exactly as sent (percent-escapes kept), so node-uws can answer that route natively too when no other route can overlap it. Serving an app now seals it, as `listen()` does, so a hook or route added afterwards throws `SERVER_SEALED` instead of being skipped on those paths.
