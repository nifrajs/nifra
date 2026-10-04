---
"@nifrajs/web-react": patch
---

`<AuthSessionProvider>` follows its `initialSession` prop after mount: a new seed, such as a loader re-run on navigation, replaces the provider's session and status as a remount would. Re-rendering with the same seed keeps a session changed since, for example by `signOut()`.
