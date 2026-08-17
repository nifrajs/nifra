# @nifrajs/skills

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
