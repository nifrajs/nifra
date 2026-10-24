import { narrowCapabilityContext } from "@nifrajs/core/capabilities"
import { validateStandard } from "@nifrajs/core/schema"
import { outputGuard, runGuard } from "../internal/output-guard.ts"
import { isControlFlow } from "../internal/render-document.ts"
import { isStatusSignal } from "../internal/status-page.ts"
import { ServerComponentError } from "./error.ts"
import { assertComponentSchema, componentValue } from "./schema.ts"
import type {
  PreparedServerComponent,
  ServerComponent,
  ServerComponentContext,
  ServerComponentDefinition,
} from "./types.ts"

interface RuntimeDefinition {
  readonly authorize: (ctx: ServerComponentContext, input: never) => void | Promise<void>
  readonly load: (ctx: ServerComponentContext, input: never) => unknown | Promise<unknown>
  readonly guard: ReturnType<typeof outputGuard>
  readonly capabilities: readonly string[]
}
const definitions = new WeakMap<object, RuntimeDefinition>()
const authorizations = new WeakMap<
  object,
  {
    component: ServerComponent
    definition: RuntimeDefinition
    input: unknown
    scope: ServerComponentContext
  }
>()

export function defineServerComponent<Input, Props, View>(
  definition: ServerComponentDefinition<Input, Props, View>,
  reference?: string,
): ServerComponent<Input, Props, View> {
  if (typeof definition.authorize !== "function" || typeof definition.load !== "function")
    throw new ServerComponentError("component_contract")
  assertComponentSchema(definition.input)
  assertComponentSchema(definition.props)
  const component: ServerComponent<Input, Props, View> = {
    view: definition.view,
    input: definition.input,
    props: definition.props,
  }
  if (reference !== undefined) Object.assign(component, { reference })
  Object.freeze(component)
  definitions.set(component, {
    authorize: definition.authorize,
    load: definition.load,
    guard: outputGuard(definition.props, "server component", "props"),
    capabilities: Object.freeze([...(definition.capabilities ?? [])]),
  })
  return component
}

export function isServerComponent(value: unknown): value is ServerComponent {
  return typeof value === "object" && value !== null && definitions.has(value)
}

export function serverComponentCapabilities(component: object): readonly string[] {
  const definition = definitions.get(component)
  if (definition === undefined) throw new ServerComponentError("component_contract")
  return definition.capabilities
}

export function inheritOwnerAuthorization(): void {}

/** Used for whole-owner preflight so an invalid sibling cannot follow successful work. */
export async function validateServerComponentInput(
  component: ServerComponent,
  input: unknown,
): Promise<void> {
  if (!definitions.has(component)) throw new ServerComponentError("component_unavailable", 404)
  componentValue(input, 1024)
  const parsed = await validateStandard(component.input, input)
  if (!parsed.ok) throw new ServerComponentError("component_input", 422)
  componentValue(parsed.value, 1024)
}

export async function prepareServerComponent<Input, Props, View>(
  component: ServerComponent<Input, Props, View>,
  input: unknown,
  ctx: ServerComponentContext,
): Promise<PreparedServerComponent<Props, View>> {
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: The private definition registry binds each schema to its callbacks; validation and authorization precede this erased generic invocation.
  return (await prepareAuthorizedServerComponent(
    // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: The private definition registry binds each schema to its callbacks; validation and authorization precede this erased generic invocation.
    await authorizeServerComponent(component as ServerComponent, input, ctx),
  )) as PreparedServerComponent<Props, View>
}
export async function authorizeServerComponent(
  component: ServerComponent,
  input: unknown,
  ctx: ServerComponentContext,
): Promise<object> {
  const definition = definitions.get(component)
  if (definition === undefined) throw new ServerComponentError("component_unavailable", 404)
  if (ctx.signal.aborted) throw new ServerComponentError("component_cancelled", 499)
  componentValue(input, 1024)
  const parsed = await validateStandard(component.input, input)
  if (!parsed.ok) throw new ServerComponentError("component_input", 422)
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: The private definition registry binds each schema to its callbacks; validation and authorization precede this erased generic invocation.
  const scope = narrowCapabilityContext(ctx, definition.capabilities) as ServerComponentContext
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: The private definition registry binds each schema to its callbacks; validation and authorization precede this erased generic invocation.
  await definition.authorize(scope, parsed.value as never)
  if (ctx.signal.aborted) throw new ServerComponentError("component_cancelled", 499)
  const token = Object.freeze({})
  authorizations.set(token, { component, definition, input: parsed.value, scope })
  return token
}
export async function prepareAuthorizedServerComponent(
  token: object,
): Promise<PreparedServerComponent> {
  const authorized = authorizations.get(token)
  if (authorized === undefined) throw new ServerComponentError("component_contract")
  authorizations.delete(token)
  const { component, definition, scope, input } = authorized
  if (scope.signal.aborted) throw new ServerComponentError("component_cancelled", 499)
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: The private definition registry binds each schema to its callbacks; validation and authorization precede this erased generic invocation.
  const data = await definition.load(scope, input as never)
  if (isControlFlow(data) || isStatusSignal(data)) throw data
  if (scope.signal.aborted) throw new ServerComponentError("component_cancelled", 499)
  const props = await runGuard(definition.guard, data, "server component props")
  const publicProps = componentValue(props)
  return { props: publicProps, view: component.view }
}
