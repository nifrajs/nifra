---
"@nifrajs/cli": minor
"@nifrajs/web": patch
---

Enforce pipeline separation, and make the client-leak guards bundler-neutral.

nifra supports both Vite and Bun, and the config already keeps them in separate slots - `vitePlugins`
for the Vite pipeline, `clientPlugins` / `serverPlugins` for the Bun one. Nothing enforced the split,
and the failure mode is silent: `Bun.build` has no `transform` hook and Vite never calls `setup`, so a
plugin in the wrong slot is accepted, never invoked, and the build succeeds with the transform simply
missing.

Loading an app now refuses that config, naming the plugin, the slot it is in, the pipeline that slot
feeds, and where to move it. Checked at load rather than in `nifra check`, which holds a deliberate
pre-`loadApp` invariant - reading plugins means importing the app's config. So `dev`, `build` and
`start` are covered from one place, immediately before the plugins reach a bundler. Detection is by
hook shape and deliberately conservative: a plugin matching neither shape is left alone, because a
guard that fires on correct config is a guard people turn off.

The two client-leak guards - server-only code reaching the browser, `node:` builtins in client code -
now take a bundler-neutral module graph instead of Bun's metafile, with a `fromBunMetafile` adapter
behind it. Nothing changes today: Bun remains the only producer and the existing 19 tests pass
unchanged, now routed through the adapter so it is covered too.

The point is what it makes possible. These are security guards - one stops secrets and database access
shipping to a browser - so a second production pipeline must not arrive without them, and porting them
under pressure beside a new bundler is how a guard ends up "mostly" ported. Introducing the seam while
Bun is the only producer means the adapter can be verified against known-good behaviour, and adding
Rollup later is one more adapter rather than a second copy of the detection logic.
