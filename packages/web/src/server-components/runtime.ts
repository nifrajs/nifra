import type { CapabilityDefinition } from "@nifrajs/core/capabilities"
import { isResponseResult, isStatusSignal, STATUS_SIGNAL } from "../internal/render-document.ts"
import {
  authorizeServerComponent,
  isServerComponent,
  prepareAuthorizedServerComponent,
  serverComponentCapabilities,
  validateServerComponentInput,
} from "./definition.ts"
import { ServerComponentError } from "./error.ts"
import { componentFrames } from "./frames.ts"
import { componentRangeHTML } from "./html.ts"
import {
  COMPONENT_LIMITS,
  COMPONENT_RESPONSE_HEADERS,
  componentFailure,
  componentKey,
  readComponentRequest,
} from "./protocol.ts"
import { BoundedComponentTasks, componentAbort } from "./scheduler.ts"
import { componentValue } from "./schema.ts"
import type {
  ComponentInstance,
  ComponentOwner,
  ComponentRecord,
  ServerComponent,
  ServerComponentContext,
  ServerComponentHandle,
  ServerComponentRenderAdapter,
  ServerComponentRuntime,
} from "./types.ts"
import { componentInputKey } from "./value.ts"

const admission = new BoundedComponentTasks(
  COMPONENT_LIMITS.activeLoads,
  COMPONENT_LIMITS.queuedLoads,
)
const encoder = new TextEncoder()
const token = /^[A-Za-z0-9_-]{1,128}$/

export interface ServerComponentsOptions {
  readonly build: string
  readonly adapter: ServerComponentRenderAdapter
  readonly owners: Readonly<Record<string, ComponentOwner>>
  readonly capabilities?: readonly CapabilityDefinition[]
  readonly assets?: readonly string[]
}

export function serverComponentInstance<Input, Props, View>(
  component: ServerComponent<Input, Props, View>,
  key: string | number,
  input: Input,
  parent?: string,
): ComponentInstance {
  const instance: ComponentInstance = { component, key, input }
  if (parent !== undefined) Object.assign(instance, { parent })
  return instance
}

export function defineComponentOwner<const Owner extends ComponentOwner>(owner: Owner): Owner {
  return owner
}

async function identity(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(JSON.stringify(value)))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}
export function serverComponentIdentity(
  owner: string,
  component: ServerComponentHandle,
  key: string | number,
  parent: string | null = null,
): Promise<string> {
  if (
    component.reference === undefined ||
    !componentKey(key) ||
    (parent !== null && !token.test(parent))
  )
    throw new ServerComponentError("component_contract")
  return identity([owner, component.reference, parent, key])
}

export function createServerComponents(options: ServerComponentsOptions): ServerComponentRuntime {
  if (
    !token.test(options.build) ||
    options.adapter.version !== 1 ||
    !["react", "vue", "svelte", "solid"].includes(options.adapter.name)
  )
    throw new ServerComponentError("component_contract")
  const owners = new Map<
    string,
    { owner: ComponentOwner; components: ReadonlyMap<string, ServerComponentHandle> }
  >()
  const assets = new Set(options.assets ?? [])
  if (
    [...assets].some(
      (path) => !/^\/assets\/[A-Za-z0-9_./-]+$/.test(path) || path.split("/").includes(".."),
    )
  )
    throw new ServerComponentError("component_contract")
  const capabilities = new Map(
    (options.capabilities ?? []).map((capability) => [capability.id, capability]),
  )
  if (capabilities.size !== (options.capabilities?.length ?? 0))
    throw new ServerComponentError("component_contract")
  for (const [routeId, owner] of Object.entries(options.owners)) {
    if (
      typeof owner.instances !== "function" ||
      (owner.scope !== "anonymous" && typeof owner.scope !== "function")
    )
      throw new ServerComponentError("component_contract")
    const components = new Map<string, ServerComponentHandle>()
    const allowed = new Set(owner.capabilities ?? [])
    for (const capability of allowed) {
      const declared = capabilities.get(capability)
      if (declared === undefined || (declared.zone === "domain" && declared.access !== "read"))
        throw new ServerComponentError("component_contract")
    }
    for (const component of owner.components) {
      if (
        !isServerComponent(component) ||
        component.reference === undefined ||
        !token.test(component.reference) ||
        components.has(component.reference)
      )
        throw new ServerComponentError("component_contract")
      components.set(component.reference, component)
      if (serverComponentCapabilities(component).some((capability) => !allowed.has(capability)))
        throw new ServerComponentError("component_contract")
    }
    owners.set(routeId, { owner, components })
  }
  return {
    owns: (routeId) => owners.has(routeId),
    capabilities: (routeId) => owners.get(routeId)?.owner.capabilities ?? [],
    classify(request, routeId) {
      const selection = readComponentRequest(request)
      if (selection === undefined) return undefined
      if (selection.build !== options.build)
        throw new ServerComponentError("component_version", 409)
      if (!owners.get(routeId)?.components.has(selection.reference))
        throw new ServerComponentError("component_unavailable", 404)
      return selection
    },
    async execute(routeId, context, selection, nonce) {
      const entry = owners.get(routeId)
      if (entry === undefined) throw new ServerComponentError("component_unavailable", 404)
      const signal = AbortSignal.any([
        context.signal,
        AbortSignal.timeout(COMPONENT_LIMITS.executionMs),
      ])
      const ctx: ServerComponentContext = Object.create(context, {
        signal: { value: signal, enumerable: true },
      })
      const { scope, instances } = await admission.run(signal, async () => ({
        scope: entry.owner.scope === "anonymous" ? "anonymous" : await entry.owner.scope(ctx),
        instances: await entry.owner.instances(ctx),
      }))
      if (typeof scope !== "string" || !token.test(scope))
        throw new ServerComponentError("component_contract")
      if (!Array.isArray(instances) || instances.length > COMPONENT_LIMITS.instances)
        throw new ServerComponentError("component_limit", 413)
      const candidates = await Promise.all(
        instances.map(async (instance) => {
          const reference = instance.component.reference
          if (
            reference === undefined ||
            entry.components.get(reference) !== instance.component ||
            !componentKey(instance.key) ||
            (instance.parent !== undefined && !token.test(instance.parent))
          )
            throw new ServerComponentError("component_contract")
          return {
            ...instance,
            reference,
            id: await serverComponentIdentity(
              routeId,
              instance.component,
              instance.key,
              instance.parent ?? null,
            ),
            input: componentValue(instance.input, COMPONENT_LIMITS.inputBytes),
          }
        }),
      )
      const byId = new Map(candidates.map((instance) => [instance.id, instance]))
      if (byId.size !== candidates.length) throw new ServerComponentError("component_contract")
      await admission.run(signal, () =>
        Promise.all(
          candidates.map((instance) =>
            // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: The owner allowlist and private definition registry identify this handle; input validation precedes callback execution.
            validateServerComponentInput(instance.component as ServerComponent, instance.input),
          ),
        ),
      )
      for (const instance of candidates) {
        const chain = new Set([instance.id])
        let parent = instance.parent
        while (parent !== undefined) {
          const ancestor = byId.get(parent)
          if (ancestor === undefined || chain.has(parent) || chain.size >= 16)
            throw new ServerComponentError("component_contract")
          chain.add(parent)
          parent = ancestor.parent
        }
      }
      const roots =
        selection === undefined
          ? candidates
          : candidates.filter(
              (item) =>
                item.reference === selection.reference &&
                item.key === selection.key &&
                (item.parent ?? null) === selection.parent &&
                componentInputKey(item.input) === componentInputKey(selection.input),
            )
      if (selection !== undefined && roots.length !== 1)
        throw new ServerComponentError("component_unavailable", 404)
      const selected = new Set(roots.map((item) => item.id))
      if (selection !== undefined)
        for (let depth = 0; depth < 16; depth++)
          for (const item of candidates)
            if (item.parent !== undefined && selected.has(item.parent)) selected.add(item.id)
      const picked =
        selection === undefined
          ? candidates
          : [
              ...roots,
              ...candidates.filter((item) => selected.has(item.id) && item.id !== roots[0]?.id),
            ]
      const authorized = new Map<string, object>()
      await admission.run(signal, async () => {
        for (const instance of picked)
          authorized.set(
            instance.id,
            await authorizeServerComponent(
              // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: The owner allowlist and private definition registry identify this handle; input validation precedes callback execution.
              instance.component as ServerComponent,
              instance.input,
              ctx,
            ),
          )
      })
      const requestTasks = new BoundedComponentTasks(
        COMPONENT_LIMITS.requestLoads,
        COMPONENT_LIMITS.instances,
      )
      let bytes = 0
      let count = candidates.length
      const pending = new Map<string, Promise<ComponentRecord>>()
      const render = (instance: (typeof candidates)[number]): Promise<ComponentRecord> => {
        const prior = pending.get(instance.id)
        if (prior !== undefined) return prior
        const task = (async () => {
          const children = await Promise.all(
            picked.filter((child) => child.parent === instance.id).map(render),
          )
          return requestTasks.run(signal, () =>
            admission.run(signal, async () => {
              const id = instance.id
              // The runtime allowlist verified the handle; prepare still validates the schema-derived input and output.
              const prepared = await prepareAuthorizedServerComponent(authorized.get(id)!)
              const renderContext: import("./types.ts").ComponentRenderContext = {
                reference: instance.reference,
                instance: id,
                signal,
                children,
              }
              if (nonce !== undefined) Object.assign(renderContext, { nonce })
              const rendered = await options.adapter.render(
                prepared.view,
                prepared.props,
                renderContext,
              )
              if (signal.aborted) throw componentAbort(signal)
              if (typeof rendered.html !== "string")
                throw new ServerComponentError("component_contract")
              const html = componentRangeHTML(rendered.html, assets)
              count += rendered.islands?.length ?? 0
              if (count > COMPONENT_LIMITS.instances)
                throw new ServerComponentError("component_limit", 413)
              const record: ComponentRecord = {
                instance: id,
                reference: instance.reference,
                key: instance.key,
                parent: instance.parent ?? null,
                input: instance.input,
                html,
              }
              if (rendered.payload !== undefined)
                Object.assign(record, {
                  payload: componentValue(rendered.payload, COMPONENT_LIMITS.outputBytes),
                })
              if (rendered.islands !== undefined)
                Object.assign(record, {
                  islands: rendered.islands.map((island) => ({
                    ...island,
                    props: componentValue(island.props),
                  })),
                })
              const size = encoder.encode(JSON.stringify(record)).length
              bytes += size
              if (
                size > COMPONENT_LIMITS.outputBytes ||
                bytes >
                  (selection === undefined
                    ? COMPONENT_LIMITS.documentBytes
                    : COMPONENT_LIMITS.outputBytes)
              )
                throw new ServerComponentError("component_limit", 413)
              return record
            }),
          )
        })()
        pending.set(instance.id, task)
        return task
      }
      const records = await Promise.all(picked.map(render))
      if (signal.aborted) throw componentAbort(signal)
      return {
        v: 1,
        build: options.build,
        adapter: options.adapter.name,
        owner: await identity(routeId),
        scope,
        records,
      }
    },
    response(state, selection) {
      return new Response(
        componentFrames(
          {
            ...selection,
            input: undefined,
            adapter: state.adapter,
            owner: state.owner,
            scope: state.scope,
            instance: state.records[0]?.instance,
          },
          state,
        ),
        { headers: COMPONENT_RESPONSE_HEADERS },
      )
    },
    failure(error) {
      if (isResponseResult(error)) return this.failure(error.toResponse())
      if (isStatusSignal(error)) {
        const status = error[STATUS_SIGNAL]
        const init: ResponseInit = { status: status.status }
        if (status.headers !== undefined) init.headers = status.headers
        return this.failure(new Response(null, init))
      }
      if (error instanceof Response) {
        const headers = new Headers(error.headers)
        headers.set("cache-control", "private, no-store")
        headers.delete("content-length")
        if (error.status >= 300 && error.status < 400)
          return new Response(null, { status: error.status, headers })
        if (error.status < 300) {
          headers.set("x-nifra-component-control", String(error.status))
          return Response.json({ v: 1, control: { status: error.status } }, { headers })
        }
        const code = [401, 403, 404].includes(error.status)
          ? "component_denied"
          : "component_failed"
        const response = componentFailure(
          new ServerComponentError(code, error.status >= 400 ? error.status : 500),
        )
        headers.set("content-type", "application/json")
        headers.set("x-content-type-options", "nosniff")
        return new Response(response.body, { status: response.status, headers })
      }
      return componentFailure(error)
    },
  }
}
