# @nifrajs/skills

## 3.3.0

## 3.2.0

### Minor Changes

- ab0db9e: Register the Nifra MCP server from the Claude Code plugin manifest, so installing the plugin brings up the live tools the skills point at instead of leaving them to a separate setup step. The launch spec stays unpinned so one installed plugin serves projects on different Nifra versions.

## 3.1.0

## 3.0.0

## 2.14.1

## 2.14.0

## 2.13.0

## 2.12.1

## 2.12.0

### Minor Changes

- 6c2b38a: New package: `@nifrajs/skills` - portable agent skills for Nifra.

  Four `SKILL.md` bundles (`nifra`, `nifra-api`, `nifra-web`, `nifra-verify`) covering the core loop,
  typed routes and the never-throwing client, the full-stack client/server boundary, and the
  check/assure/capabilities gates. They teach shape and rules, not signatures: signatures come from the
  MCP server, which is typechecked against the version installed in the project being edited.

  One source, every surface - installable from npm on Pi (`pi install npm:@nifrajs/skills`), as a Claude
  Code plugin from the repo marketplace, or copied into any `skills/` directory.
