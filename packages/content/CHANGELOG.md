# @nifrajs/content

## 3.1.0

## 3.0.0

### Patch Changes

- 6e43c15: A failed boundary load no longer publishes the thrown error's own message. Boundary states are serialized into the document, so a driver or fetch failure was putting hosts, credentials, and query text on the page for every visitor who loaded it while the dependency was down. The client slot is now always `Boundary failed`, an `Error` subclass name is withheld for the same reason it names the failing internal library, and the real error is reported to the server console - the split already used for a rejected deferred value. A boundary that wants to show the user something specific catches its own failure inside `load` and returns that as data.

  Opt-in outbound WebSocket validation (`validateSend`) contains a rejected diagnostic instead of recursing. An `error()` handler that answers a dropped frame by sending one of its own re-entered the reporter through the two paths that bypassed its guard - schema rejection and an async validator - and unwound only when the stack was exhausted, silently. Every failure path now reports through the guard.

  A content index cursor is checked for the query that issued it separately from running off the end: a cursor from a different sort or filter is rejected at any position, and a matching cursor left past the last row by an index that shrank between pages returns an exhausted page rather than throwing.

- 86a555b: The roadmap contract surfaces are now shipped across the public packages: shared island triggers,
  typed content indexes and joins, client loader/action hooks, and unified static, dynamic, and
  intercepting boundary modes. WebSocket routes also support opt-in synchronous outbound validation
  through `sendSchema` + `validateSend`; invalid or asynchronous outbound frames fail closed while the
  default remains type-level only.

## 2.14.1

## 2.14.0

## 2.13.0

## 2.12.1

## 2.12.0

## 2.11.0

## 2.10.0

## 2.9.1

## 2.9.0

## 2.8.2

## 2.8.1

## 2.8.0

## 2.7.1

## 2.7.0

## 2.6.1

## 2.6.0

## 2.5.0

## 2.4.0

## 2.3.0

## 2.2.0

## 2.1.0

## 2.0.0

## 1.13.0

## 1.12.0

## 1.11.0

## 1.10.0

## 1.9.1

## 1.9.0

## 1.8.0

## 1.7.0

## 1.6.0

## 1.5.0

## 1.4.0

## 1.3.1

## 1.3.0

## 1.2.2

## 1.2.1

## 1.2.0

## 1.1.0

## 1.0.0

## 1.0.0-beta.4

## 1.0.0-beta.3

## 0.1.0-beta.2
