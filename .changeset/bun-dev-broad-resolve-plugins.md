---
"@nifrajs/web": patch
"@nifrajs/cli": patch
---

The Bun dev server starts and hydrates its pages when an app plugin's resolve filter matches every import, as a plugin built on unplugin does, whether the plugin comes from `clientPlugins` or from the app's `bunfig.toml` `[serve.static] plugins`. The generated client entry is now `.nifra-bun/nifra-dev-entry.tsx`.
