# @nifrajs/webmcp

## 5.9.0

### Patch Changes

- Updated dependencies [8cdb138]
- Updated dependencies [be1c677]
- Updated dependencies [f399e06]
- Updated dependencies [93e7078]
- Updated dependencies [2c2f58b]
- Updated dependencies [123409c]
- Updated dependencies [7ee17d0]
- Updated dependencies [68d9f31]
- Updated dependencies [ddeb735]
- Updated dependencies [a3fb195]
- Updated dependencies [ffcf41a]
- Updated dependencies [7a15327]
- Updated dependencies [866c8ec]
- Updated dependencies [bc42fd2]
- Updated dependencies [9942748]
- Updated dependencies [77b98ea]
- Updated dependencies [a3caf9b]
- Updated dependencies [7ba5c9b]
- Updated dependencies [0445564]
- Updated dependencies [180bf9d]
- Updated dependencies [ff9bc11]
- Updated dependencies [8094874]
- Updated dependencies [a7b89ee]
- Updated dependencies [d6e6617]
- Updated dependencies [6ba9740]
- Updated dependencies [5f4416a]
- Updated dependencies [c4ed3e9]
- Updated dependencies [5bc60b7]
- Updated dependencies [3299474]
  - @nifrajs/core@5.9.0

## 5.8.0

### Patch Changes

- Updated dependencies [8720338]
  - @nifrajs/core@5.8.0

## 5.7.0

### Patch Changes

- Updated dependencies [b141cf4]
- Updated dependencies [a97b081]
- Updated dependencies [b3d8ac9]
- Updated dependencies [25f97c2]
- Updated dependencies [d083ad2]
- Updated dependencies [b141cf4]
- Updated dependencies [a57b75c]
- Updated dependencies [911204f]
- Updated dependencies [911204f]
- Updated dependencies [0e59830]
  - @nifrajs/core@5.7.0

## 5.6.0

### Patch Changes

- Updated dependencies [676a1f0]
- Updated dependencies [f1a424d]
- Updated dependencies [0743b66]
- Updated dependencies [671a952]
- Updated dependencies [7c5fc94]
- Updated dependencies [13f6b38]
- Updated dependencies [d76bc3f]
- Updated dependencies [d76bc3f]
- Updated dependencies [4bc7d8d]
- Updated dependencies [aa567fa]
- Updated dependencies [6b90278]
- Updated dependencies [d43bc92]
- Updated dependencies [7810dc5]
- Updated dependencies [6126cb1]
- Updated dependencies [ef2d101]
- Updated dependencies [dec48fc]
- Updated dependencies [f48b257]
- Updated dependencies [0222181]
- Updated dependencies [a6010f9]
- Updated dependencies [87f475d]
- Updated dependencies [3e1e275]
- Updated dependencies [9efc061]
- Updated dependencies [9889273]
- Updated dependencies [78e64e2]
- Updated dependencies [f25a8d2]
- Updated dependencies [db9f041]
- Updated dependencies [375711b]
- Updated dependencies [bb35ad0]
- Updated dependencies [c7d233d]
- Updated dependencies [feff82f]
- Updated dependencies [a540dad]
  - @nifrajs/core@5.6.0

## 5.5.1

### Patch Changes

- Updated dependencies [a0b1ab4]
  - @nifrajs/core@5.5.1

## 5.5.0

### Patch Changes

- 12d93b5: `registerWebMcpTools()` keeps refusing a duplicate tool name after a registration in the same call failed. A host refusal for the first capability used to drop the target's name record while later capabilities in that call registered into it, so registering one of them again reached the host a second time instead of failing as a duplicate.
- Updated dependencies [6cc9e11]
- Updated dependencies [28dd544]
- Updated dependencies [662afb0]
- Updated dependencies [662afb0]
- Updated dependencies [61113d8]
- Updated dependencies [389e1b6]
- Updated dependencies [662afb0]
- Updated dependencies [a11fe77]
- Updated dependencies [fa5b67c]
  - @nifrajs/core@5.5.0

## 5.4.0

### Patch Changes

- Updated dependencies [5183c00]
- Updated dependencies [01b97ec]
- Updated dependencies [e589893]
- Updated dependencies [ff66db6]
- Updated dependencies [529f8d2]
  - @nifrajs/core@5.4.0

## 5.3.0

### Patch Changes

- Updated dependencies [7ab9692]
- Updated dependencies [808bac8]
- Updated dependencies [d4bae56]
- Updated dependencies [007060d]
- Updated dependencies [190ab39]
- Updated dependencies [7cf8df3]
  - @nifrajs/core@5.3.0

## 5.2.1

### Patch Changes

- @nifrajs/core@5.2.1

## 5.2.0

### Patch Changes

- 9498cf8: The package ships its `CHANGELOG.md`, so the installed package has the notes for every version, as the GitHub release does. Before, the tarball held only the code, `README.md`, `LICENSE` and `package.json`.
- Updated dependencies [9498cf8]
- Updated dependencies [1f3ff32]
- Updated dependencies [4bb8e52]
- Updated dependencies [cdff19d]
- Updated dependencies [5edd0ba]
- Updated dependencies [000b4cb]
- Updated dependencies [c5455fb]
- Updated dependencies [6082ba5]
- Updated dependencies [fd58beb]
- Updated dependencies [ea25a61]
- Updated dependencies [ed13e36]
  - @nifrajs/core@5.2.0

## 5.1.0

### Patch Changes

- abb4354: The package now ships the MIT `LICENSE` text, as every other @nifrajs package already did.
- Updated dependencies [b276c67]
- Updated dependencies [2a0a5d3]
- Updated dependencies [72e1b4b]
  - @nifrajs/core@5.1.0

## 5.0.0

### Minor Changes

- bdd6231: A WebMCP tool's `execute(input, context)` forwards `context.signal` into the capability, so a host cancellation reaches the executor's `ctx.signal`, and a call the host already cancelled never runs. `WebMcpExecuteContext` types that second argument.

### Patch Changes

- Updated dependencies [a0a02f4]
- Updated dependencies [0aed425]
- Updated dependencies [eaf030b]
- Updated dependencies [7de0397]
- Updated dependencies [4199ff3]
- Updated dependencies [90d9ee6]
- Updated dependencies [364a234]
- Updated dependencies [c06cba5]
- Updated dependencies [f4d3852]
- Updated dependencies [4a82ae0]
- Updated dependencies [0ff867a]
- Updated dependencies [e7391bf]
- Updated dependencies [0b80a59]
- Updated dependencies [c64db12]
- Updated dependencies [3753104]
- Updated dependencies [4b3b1fa]
- Updated dependencies [3562557]
- Updated dependencies [53087f3]
- Updated dependencies [2def6c7]
- Updated dependencies [b5b5bc3]
- Updated dependencies [22e1777]
- Updated dependencies [3a483cd]
- Updated dependencies [35f52c7]
- Updated dependencies [343cb81]
- Updated dependencies [d91fd44]
- Updated dependencies [b13e071]
- Updated dependencies [077657f]
- Updated dependencies [a5963cb]
- Updated dependencies [05aac0e]
- Updated dependencies [1a6616f]
- Updated dependencies [7775c2b]
- Updated dependencies [846e2f6]
- Updated dependencies [aadd9fc]
- Updated dependencies [ea16748]
- Updated dependencies [fc0284a]
- Updated dependencies [5b22f4d]
- Updated dependencies [1b94593]
- Updated dependencies [9f58295]
- Updated dependencies [b9608ac]
- Updated dependencies [7a165de]
- Updated dependencies [4064f36]
- Updated dependencies [48aad8c]
- Updated dependencies [41050ed]
- Updated dependencies [fc837cb]
- Updated dependencies [b80ce77]
- Updated dependencies [9b1acc9]
- Updated dependencies [740109f]
- Updated dependencies [e0a25fe]
- Updated dependencies [3630b6e]
- Updated dependencies [1290c6d]
- Updated dependencies [d0a7d58]
  - @nifrajs/core@5.0.0

## 4.0.2

### Patch Changes

- @nifrajs/core@4.0.2

## 4.0.1

### Patch Changes

- @nifrajs/core@4.0.1

## 4.0.0

### Minor Changes

- 6323d38: `executePredicted()` applies the capability's `reconciliation` policy. Under `"accept-server-state"`, a successful call whose prediction conflicted with a newer commit still commits the server's state, so concurrent calls end on the latest server response. `PredictionStore.commit()` takes the policy as a new optional fourth argument, `{ reconciliation }`. `"manual"` and `"reload"` keep reporting `conflicted` and leave the base unchanged.

### Patch Changes

- Updated dependencies [dde125b]
- Updated dependencies [72b62fa]
- Updated dependencies [aa44e93]
- Updated dependencies [4a3ee60]
- Updated dependencies [aad6297]
- Updated dependencies [dad0d41]
- Updated dependencies [538adc2]
- Updated dependencies [f47edd1]
- Updated dependencies [df9530a]
- Updated dependencies [3e6973f]
- Updated dependencies [25e8edf]
- Updated dependencies [2b5e5fc]
- Updated dependencies [3b090de]
- Updated dependencies [da7d792]
- Updated dependencies [612a296]
- Updated dependencies [fb14dfa]
- Updated dependencies [8ae97f6]
- Updated dependencies [4af6f39]
- Updated dependencies [ca8b50d]
- Updated dependencies [b00a889]
- Updated dependencies [b53d64f]
- Updated dependencies [66fd712]
- Updated dependencies [9c3d524]
- Updated dependencies [738e7a1]
- Updated dependencies [4801cac]
- Updated dependencies [1b2d53a]
- Updated dependencies [25fe13d]
- Updated dependencies [0852290]
- Updated dependencies [0589dbe]
- Updated dependencies [2e2d8c0]
- Updated dependencies [856f5ce]
- Updated dependencies [18aa5aa]
- Updated dependencies [cfd86b3]
- Updated dependencies [8ff96c9]
- Updated dependencies [4c46199]
- Updated dependencies [eef4932]
- Updated dependencies [6de8686]
- Updated dependencies [d7892ea]
- Updated dependencies [4936309]
- Updated dependencies [ff5a779]
- Updated dependencies [bbdc5a1]
- Updated dependencies [10bc446]
- Updated dependencies [e8270d9]
- Updated dependencies [ff4a062]
- Updated dependencies [43ba944]
- Updated dependencies [46c741a]
- Updated dependencies [7bfa25e]
- Updated dependencies [4936309]
- Updated dependencies [6e257a6]
- Updated dependencies [4a03d30]
- Updated dependencies [8e30090]
- Updated dependencies [28f3aaf]
- Updated dependencies [6d20355]
- Updated dependencies [6907cbe]
- Updated dependencies [b64c3ee]
- Updated dependencies [bda9637]
- Updated dependencies [81c720e]
- Updated dependencies [ed60b23]
- Updated dependencies [a158b74]
- Updated dependencies [ff25d68]
  - @nifrajs/core@4.0.0

## 3.5.0

### Patch Changes

- Updated dependencies [6046984]
- Updated dependencies [d5b7c22]
  - @nifrajs/core@3.5.0

## 3.4.0

### Minor Changes

- 8d23613: Add the opt-in `@nifrajs/webmcp` package: typed WebMCP registration, core-backed receipts, deterministic predictive-UI reconciliation, and host-independent conformance checks. Also tighten agent execution cancellation cleanup so aborted local work cannot leak into later turns.

### Patch Changes

- Updated dependencies [719d82e]
  - @nifrajs/core@3.4.0
