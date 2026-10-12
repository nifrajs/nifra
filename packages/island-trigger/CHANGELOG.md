# @nifrajs/island-trigger

## 5.1.0

### Patch Changes

- abb4354: The package now ships the MIT `LICENSE` text, as every other @nifrajs package already did.

## 5.0.0

### Patch Changes

- 46b269a: `scheduleTrigger` ships smaller. Every strategy returns the same one-shot disposer, which stays safe to call after the trigger fired.

## 4.0.2

## 4.0.1

## 4.0.0

## 3.5.0

## 3.4.0

## 3.3.0

## 3.2.0

## 3.1.0

## 3.0.0

### Patch Changes

- 86a555b: The roadmap contract surfaces are now shipped across the public packages: shared island triggers,
  typed content indexes and joins, client loader/action hooks, and unified static, dynamic, and
  intercepting boundary modes. WebSocket routes also support opt-in synchronous outbound validation
  through `sendSchema` + `validateSend`; invalid or asynchronous outbound frames fail closed while the
  default remains type-level only.
