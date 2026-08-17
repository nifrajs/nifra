# @nifrajs/island-trigger

## 3.1.0

## 3.0.0

### Patch Changes

- 86a555b: The roadmap contract surfaces are now shipped across the public packages: shared island triggers,
  typed content indexes and joins, client loader/action hooks, and unified static, dynamic, and
  intercepting boundary modes. WebSocket routes also support opt-in synchronous outbound validation
  through `sendSchema` + `validateSend`; invalid or asynchronous outbound frames fail closed while the
  default remains type-level only.
