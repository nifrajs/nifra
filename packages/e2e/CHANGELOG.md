# @nifrajs/e2e

## 5.13.0

### Minor Changes

- 2e7a043: Add `@nifrajs/e2e`: browser end-to-end tests for Nifra apps. `e2e(app)` serves the app on an ephemeral port and drives it through a browser engine (Playwright by default, an in-memory engine at `@nifrajs/e2e/fake`). `open()` takes only paths the app declares and requires their `:params`. Locators (`getByRole`, `getByLabel`, `getByText`, `getByTestId`, `filter`) and retrying assertions (`toBeVisible`, `toHaveText`, `toHaveCount`, `toHaveURL` and more, each with `.not`) run in any test runner. On a page that loads a module script, actions wait for `data-nifra-hydrated`. `t.agent` adds goal-driven steps over a model you supply: `act`, `assert`, `waitFor` and `extract`, with call, action and time budgets, `Secret` params the model never reads, and a pruned page outline. A replay cache makes the second run of an `act` model-free: it is written only after a later check passes, replays only when each control still matches exactly, and hands off to the model from where it stopped. Modes are `read-write`, `read-only`, `strict` and `off`; `unique()` keeps run-varying data from missing.

### Patch Changes

- Updated dependencies [591f74e]
- Updated dependencies [b427443]
- Updated dependencies [3b39e39]
- Updated dependencies [16023e9]
- Updated dependencies [d75437b]
- Updated dependencies [9c8a464]
  - @nifrajs/core@5.13.0
  - @nifrajs/node@5.13.0
  - @nifrajs/testing@5.13.0

## 5.12.1

- Initial release: browser end-to-end tests for Nifra apps, with typed paths, locators, retrying assertions, agent steps and a replay cache.
