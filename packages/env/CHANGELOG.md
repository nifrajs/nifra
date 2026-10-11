# @nifrajs/env

## 5.0.0

### Patch Changes

- 0ce3c61: `defineEnv` and an event contract's `parse` and `create` still refuse an async validator with their synchronous error, and now also observe the validator's promise, so a validator that rejects no longer surfaces as an unhandled rejection after the caller catches the refusal.
- 3c6bf66: `defineEnv()` no longer prints a variable's value when a bring-your-own validator quotes it. A valibot message such as `Invalid email: Received "sk_live_..."`, or a hand-rolled one that echoes its input, went into the startup error as is. The value is now replaced with `<redacted>`. The `env.*` helpers already wrote value-free messages and are unchanged.

## 4.0.2

## 4.0.1

## 4.0.0

## 3.5.0

## 3.4.0

## 3.3.0

## 3.2.0

## 3.1.0

## 3.0.0

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
