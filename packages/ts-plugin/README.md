# @nifrajs/ts-plugin

A TypeScript language-service plugin for [nifra](https://github.com/nifrajs/nifra). It adds go-to-definition on route-path string literals: put your cursor on `"/orders"` in `navigate({ to: "/orders" })`, `<Link to="/orders">`, or `href="/orders"`, and jump straight to the `routes/` file that serves it.

The routing rules are nifra's own - it discovers routes with `@nifrajs/web` and matches them with `@nifrajs/core`'s pattern matcher - so a path resolves to exactly the file it would serve at runtime, dynamic segments included (`/users/42` → `routes/users/[id].tsx`).

## Install

```sh
npm install -D @nifrajs/ts-plugin
```

## Enable

Add it to your `tsconfig.json`:

```json
{
  "compilerOptions": {
    "plugins": [{ "name": "@nifrajs/ts-plugin" }]
  }
}
```

In VS Code, run "TypeScript: Select TypeScript Version" from the Command Palette and choose "Use Workspace Version" so the editor loads the plugin from your project.

## For agents

Start with [`LLM.md`](./LLM.md) - this package's contract card (the exports it ships and how it wires in). [`llms-full.txt`](../../llms-full.txt) is the full machine-readable corpus for the whole framework.

## License

MIT
