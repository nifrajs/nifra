/**
 * The opt-in MCP runtime plugin.
 *
 * `.use(mcp())` enables `.tool()`, `.resource()`, and `.prompt()`. Without it those methods throw at
 * registration (fail-closed), so an ordinary HTTP app never evaluates or bundles the MCP wiring. This
 * is the same install seam as `.use(idempotency())` / `.use(effectLedger())` - one consistent `.use()`
 * opt-in, not a side-effect import.
 */
import { INSTALL_MCP } from "./server/install.ts"
import type { McpRuntime } from "./server/mcp-hook.ts"
import type { IdentityPlugin } from "./server/plugin.ts"
import type { AnyServer } from "./server/server.ts"

const MCP_RUNTIME: McpRuntime = {
  tool(name, config, handler) {
    const path = `/_nifra/tool/${name}`
    return {
      path,
      schema:
        config.output !== undefined
          ? { body: config.input, response: config.output }
          : { body: config.input },
      run: (context) => handler(context.body, context),
      descriptor: {
        name,
        description: config.description,
        ...(config.annotations !== undefined ? { annotations: config.annotations } : {}),
      },
    }
  },
  resource(uri, config, read) {
    return {
      uri,
      name: config.name,
      ...(config.description !== undefined ? { description: config.description } : {}),
      ...(config.mimeType !== undefined ? { mimeType: config.mimeType } : {}),
      read,
    }
  },
  prompt(name, config, handler) {
    return {
      name,
      description: config.description,
      ...(config.arguments !== undefined ? { arguments: config.arguments } : {}),
      handler,
    }
  },
}

/** The install seam a server exposes so the `mcp()` plugin can hand it the runtime. */
interface McpInstallable {
  [INSTALL_MCP](runtime: McpRuntime): void
}

/**
 * Enable MCP declarations on a server: `.use(mcp())` turns on `.tool()`, `.resource()`, and
 * `.prompt()`. Applying it twice is a no-op (named plugin dedupe).
 */
export function mcp(): IdentityPlugin {
  const apply = <S extends AnyServer>(app: S): S => {
    ;(app as unknown as McpInstallable)[INSTALL_MCP](MCP_RUNTIME)
    return app
  }
  return Object.assign(apply, { pluginName: "nifra:mcp" }) as IdentityPlugin
}
