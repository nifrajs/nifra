---
"@nifrajs/node": patch
---

A WebSocket on the Node adapter gets the `wsMaxPayloadBytes` of the app or mounted child that accepted it. Before, the first upgrade's cap applied to every later socket, so a child with a smaller cap could receive larger messages, or a larger cap could be cut short, depending on which child a client reached first. A cap of `0` now refuses every non-empty message with close code `1009`, as on Bun; before, `0` meant no limit.
