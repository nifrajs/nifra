/**
 * Symbol-keyed install seams the opt-in feature plugins (`idempotency()`, `effectLedger()`) use to
 * hand their runtime to a server. Kept in a dependency-free leaf, and keyed by symbol, so:
 *   - the kernel can implement the seam without importing a feature's code (importing a bare symbol
 *     never drags the lane's implementation into the base bundle), and
 *   - the seam stays off the server's public typed surface (symbol-keyed methods are not part of it).
 * Both sides reference the SAME registered symbol, so no module has to import the other.
 */

/** @internal Install the idempotency runtime on a server (called by the `idempotency()` plugin). */
export const INSTALL_IDEMPOTENCY: unique symbol = Symbol.for("@nifrajs/core/install-idempotency")

/** @internal Install the effect-ledger runtime on a server (called by the `effectLedger()` plugin). */
export const INSTALL_EFFECT_LEDGER: unique symbol = Symbol.for(
  "@nifrajs/core/install-effect-ledger",
)

/** @internal Install the MCP runtime on a server (called by the `mcp()` plugin). */
export const INSTALL_MCP: unique symbol = Symbol.for("@nifrajs/core/install-mcp")

/** @internal Install the SSE streaming runtime on a server (called by the `sse()` plugin). */
export const INSTALL_SSE: unique symbol = Symbol.for("@nifrajs/core/install-sse")

/** @internal Install the Node-direct renderer on a server (called by the `nodeDirect()` plugin). */
export const INSTALL_NODE_DIRECT: unique symbol = Symbol.for("@nifrajs/core/install-node-direct")
