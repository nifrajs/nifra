---
"@nifrajs/core": patch
---

A route with one `derive`, one `beforeHandle`, an optional `afterHandle` and a query or body schema runs through one fused lifecycle runner on the Node-direct lane and one on the Web lane, shared by query and body routes. On the Web lane a body route's lifecycle steps are built once when the route registers rather than on each request.
