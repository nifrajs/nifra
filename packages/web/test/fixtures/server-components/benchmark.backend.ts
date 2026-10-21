import {
  type ServerComponent,
  type ServerComponentContext,
  type ServerComponentRenderAdapter,
  type ServerComponentRuntime,
  serverComponentIdentity,
} from "@nifrajs/web/server-components"

/** The baseline calls the identical native renderer directly, with identical fabricated I/O. */
export function componentBenchmark<Props>(
  runtime: ServerComponentRuntime,
  adapter: ServerComponentRenderAdapter,
  Summary: ServerComponent<{}, Props>,
  Child: ServerComponent<{}, Props>,
  build: string,
) {
  async function run(enabled: boolean, refresh: boolean) {
    await new Promise((accept) => setTimeout(accept, 20))
    const request = new Request("https://fixture.test/")
    const props = { title: "Public title", revision: 1, islandKey: 0 }
    const context: ServerComponentContext = {
      request,
      req: request,
      signal: request.signal,
      params: {},
      search: {},
      api: undefined,
      env: undefined,
      draft: false,
      live() {},
      set: { headers: {}, cookie() {}, deleteCookie() {} },
      data: props,
      layoutData: [],
    }
    if (enabled)
      return runtime.execute(
        "product",
        context,
        refresh
          ? {
              v: 1,
              build,
              reference: Summary.reference!,
              key: "summary",
              parent: null,
              input: {},
              generation: 1,
              routeEpoch: 0,
              authEpoch: 0,
            }
          : undefined,
        "fixture_nonce",
      )
    const parent = await serverComponentIdentity("product", Summary, "summary")
    const child = await serverComponentIdentity("product", Child, "detail", parent)
    const childResult = await adapter.render(Child.view, props, {
      reference: Child.reference!,
      instance: child,
      signal: request.signal,
      children: [],
      nonce: "fixture_nonce",
    })
    const childRecord = {
      ...childResult,
      reference: Child.reference!,
      instance: child,
      key: "detail",
      parent,
      input: {},
    }
    const parentResult = await adapter.render(Summary.view, props, {
      reference: Summary.reference!,
      instance: parent,
      signal: request.signal,
      children: [childRecord],
      nonce: "fixture_nonce",
    })
    return {
      records: [
        {
          ...parentResult,
          reference: Summary.reference!,
          instance: parent,
          key: "summary",
          parent: null,
          input: {},
        },
        childRecord,
      ],
    }
  }
  return {
    baseline: (refresh = false) => run(false, refresh),
    enabled: (refresh = false) => run(true, refresh),
  }
}
