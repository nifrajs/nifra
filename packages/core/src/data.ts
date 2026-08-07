/** Public, token-only data access contracts. Durable adapters and RLS policy enforcement stay outside
 * this package; this subpath defines the typed seam they implement. */

export const DATA_CAPABILITIES = Object.freeze({
  read: "db.read",
  write: "db.write",
} as const)

export type DataAccess = keyof typeof DATA_CAPABILITIES
export type DataCapability = (typeof DATA_CAPABILITIES)[DataAccess]

export interface DataOperationSpec {
  readonly access: DataAccess
  readonly input?: unknown
  readonly output?: unknown
}

export type DataOperationMap = Readonly<Record<string, DataOperationSpec>>

export interface DataContract<Operations extends DataOperationMap = DataOperationMap> {
  readonly version: string
  readonly operations: Operations
}

/** Opaque request-local RLS (or equivalent data-policy) scope passed to an adapter. */
export interface RlsScope {
  /** Caller-owned scope token. The public seam never interprets, logs, or derives identity from it. */
  readonly token: string
  /** Optional opaque digest for correlating a scope without exposing tenant or subject data. */
  readonly digest?: string
}

/** Backward-compatible name for the request scope carried by every data operation. */
export type DataScope = RlsScope

export interface DataRequest<Operation extends string = string, Input = unknown> {
  readonly operation: Operation
  readonly scope: DataScope
  readonly capability: DataCapability
  readonly input: Input
}

export interface DataDrift {
  readonly kind: "version" | "added" | "removed" | "access-changed"
  readonly operation?: string
  readonly declaredAccess?: DataAccess
  readonly observedAccess?: DataAccess
  readonly declaredVersion?: string
  readonly observedVersion?: string
}

type InputOf<Operation> = Operation extends { readonly input: infer Input } ? Input : never
type OutputOf<Operation> = Operation extends { readonly output: infer Output } ? Output : unknown
type CapabilityOf<Operation> = Operation extends { readonly access: "read" }
  ? typeof DATA_CAPABILITIES.read
  : Operation extends { readonly access: "write" }
    ? typeof DATA_CAPABILITIES.write
    : DataCapability
type InputField<Input> = [Input] extends [never]
  ? { readonly input?: never }
  : { readonly input: Input }

export type DataInput<
  Contract extends DataContract,
  Operation extends keyof Contract["operations"] & string,
> = Contract["operations"][Operation] extends infer Definition ? InputOf<Definition> : never

export type DataOutput<
  Contract extends DataContract,
  Operation extends keyof Contract["operations"] & string,
> = Contract["operations"][Operation] extends infer Definition ? OutputOf<Definition> : unknown

export type DataRequestFor<
  Contract extends DataContract,
  Operation extends keyof Contract["operations"] & string,
> = {
  readonly operation: Operation
  readonly scope: DataScope
  readonly capability: CapabilityOf<Contract["operations"][Operation]>
} & InputField<DataInput<Contract, Operation>>

export interface TypedDataPort<Contract extends DataContract> {
  execute<Operation extends keyof Contract["operations"] & string>(
    request: DataRequestFor<Contract, Operation>,
  ): Promise<DataOutput<Contract, Operation>>
}

/** Runtime capability beacon used by a request-bound data port. */
export type DataCapabilityBeacon = (context: object, capability: DataCapability) => void

/** Options for the public request-bound data port wrapper. */
export interface DataPortOptions {
  /** Usually `useCapability` from `@nifrajs/core/capabilities`. */
  readonly beacon?: DataCapabilityBeacon
}

/** A data port bound to one request context; every operation emits capability evidence first. */
export interface BoundDataPort<Contract extends DataContract> extends TypedDataPort<Contract> {}

/** Public factory for wiring a private data adapter into Nifra's capability evidence chain. */
export interface DataPort<Contract extends DataContract> {
  for(context: object): BoundDataPort<Contract>
}

/**
 * Bind a private data adapter to request-local capability evidence.
 *
 * The adapter remains responsible for RLS enforcement and durable storage. This wrapper owns the
 * framework-side proof boundary: it emits exactly the operation's typed `db.read`/`db.write` token
 * before invoking the adapter, and refuses to run when no beacon is configured or the beacon denies
 * the operation. The context is never copied into the request or retained by the port.
 *
 * The emitted token is derived from the **contract**, never from `request.capability`. The typed
 * request narrows that field, but types are erased before this line runs, and a request assembled
 * from decoded input would otherwise let a write operation announce itself as `db.read` - evidence
 * that names the wrong capability is worse than no evidence, because the ledger looks satisfied. An
 * unknown operation, or a declared capability that disagrees with the contract, fails closed.
 */
export function createDataPort<Contract extends DataContract>(
  contract: Contract,
  adapter: TypedDataPort<Contract>,
  options: DataPortOptions = {},
): DataPort<Contract> {
  if (contract === null || typeof contract !== "object" || contract.operations === undefined) {
    throw new TypeError("data: contract must be a defineDataContract result")
  }
  if (adapter === null || typeof adapter !== "object" || typeof adapter.execute !== "function") {
    throw new TypeError("data: adapter must implement execute(request)")
  }

  function bind(context: object): BoundDataPort<Contract> {
    if (context === null || typeof context !== "object") {
      throw new TypeError("data: context must be an object")
    }
    const beacon = options.beacon
    if (beacon === undefined) {
      throw new Error(
        "@nifrajs/core/data: for(context) needs a beacon - pass `beacon: useCapability` to createDataPort",
      )
    }
    return Object.freeze({
      execute<Operation extends keyof Contract["operations"] & string>(
        request: DataRequestFor<Contract, Operation>,
      ): Promise<DataOutput<Contract, Operation>> {
        const declared = contract.operations[request.operation]
        if (declared === undefined || !isDataAccess(declared.access)) {
          return Promise.reject(
            new TypeError(`data: ${String(request.operation)} is not declared by this contract`),
          )
        }
        const capability = DATA_CAPABILITIES[declared.access]
        if (request.capability !== capability) {
          return Promise.reject(
            new TypeError(`data: ${String(request.operation)} requires ${capability}`),
          )
        }
        try {
          beacon(context, capability)
        } catch (error) {
          return Promise.reject(error)
        }
        return adapter.execute(request)
      },
    })
  }

  return Object.freeze({ for: bind })
}

function assertToken(value: string, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 256 ||
    hasControlCharacter(value)
  ) {
    throw new TypeError(`data: ${label} must be a bounded opaque token`)
  }
  return value
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code <= 31 || code === 127) return true
  }
  return false
}

/** Create a bounded, opaque RLS/equivalent policy scope for a data adapter. */
export function rlsScope(token: string, digest?: string): RlsScope {
  const scope = {
    token: assertToken(token, "scope token"),
    ...(digest === undefined ? {} : { digest: assertToken(digest, "scope digest") }),
  }
  return Object.freeze(scope)
}

/** Backward-compatible constructor for {@link RlsScope}. */
export function dataScope(token: string, digest?: string): DataScope {
  return rlsScope(token, digest)
}

function isDataAccess(value: unknown): value is DataAccess {
  return value === "read" || value === "write"
}

function validVersion(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 128 &&
    !hasControlCharacter(value)
  )
}

function validOperationName(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9._-]{0,127}$/.test(value)
}

/** Define and freeze a token-only data contract. Input/output types are erased at runtime. */
export function defineDataContract<const Operations extends DataOperationMap>(input: {
  readonly version: string
  readonly operations: Operations
}): DataContract<Operations> {
  if (!validVersion(input.version)) throw new TypeError("data: version must be a bounded token")
  if (input.operations === null || typeof input.operations !== "object") {
    throw new TypeError("data: operations must be an object")
  }
  const operations: Record<string, DataOperationSpec> = {}
  for (const [name, operation] of Object.entries(input.operations)) {
    if (!validOperationName(name)) throw new TypeError(`data: invalid operation name ${name}`)
    if (operation === null || typeof operation !== "object" || !isDataAccess(operation.access)) {
      throw new TypeError(`data: ${name} must declare read or write access`)
    }
    // `input` and `output` are type witnesses only. Never retain runtime schemas, defaults, or
    // caller-owned values in the public contract object; adapters receive only token metadata.
    operations[name] = Object.freeze({ access: operation.access })
  }
  return Object.freeze({
    version: input.version,
    operations: Object.freeze(operations) as Operations,
  })
}

export interface DataContractSnapshot {
  readonly version: string
  readonly operations: Readonly<Record<string, { readonly access: DataAccess }>>
}

/** Strip a contract to its token-only version/access snapshot for CI or adapter drift checks. */
export function snapshotDataContract(contract: DataContract): DataContractSnapshot {
  const operations: Record<string, { readonly access: DataAccess }> = {}
  for (const [name, operation] of Object.entries(contract.operations)) {
    if (isDataAccess(operation.access)) operations[name] = { access: operation.access }
  }
  return Object.freeze({ version: contract.version, operations: Object.freeze(operations) })
}

/** Compare a declared contract with an adapter-observed token-only snapshot. */
export function diffDataContract(
  declared: DataContract,
  observed: DataContractSnapshot | DataContract,
): readonly DataDrift[] {
  const left = snapshotDataContract(declared)
  const right = "operations" in observed ? snapshotDataContract(observed) : observed
  const drift: DataDrift[] = []
  if (left.version !== right.version) {
    drift.push({
      kind: "version",
      declaredVersion: left.version,
      observedVersion: right.version,
    })
  }
  for (const [name, operation] of Object.entries(left.operations)) {
    const candidate = right.operations[name]
    if (candidate === undefined) {
      drift.push({ kind: "removed", operation: name })
    } else if (candidate.access !== operation.access) {
      drift.push({
        kind: "access-changed",
        operation: name,
        declaredAccess: operation.access,
        observedAccess: candidate.access,
      })
    }
  }
  for (const [name] of Object.entries(right.operations)) {
    if (left.operations[name] === undefined) drift.push({ kind: "added", operation: name })
  }
  return Object.freeze(drift)
}
