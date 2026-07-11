/**
 * `@nifrajs/devtools` — interactive DevTools overlay for `nifra dev`.
 *
 * Server-side: a middleware plugin that captures request traces into a ring buffer
 * and streams them via SSE at `/_nifra/devtools`.
 *
 * Client-side: a floating browser overlay that connects to the SSE stream and
 * renders a scrolling log of request traces with ISR status badges.
 *
 * **Zero production overhead** — register conditionally:
 * ```ts
 * if (process.env.NODE_ENV !== "production") app.use(devtools())
 * ```
 * When not registered, routes stay `bare` and the SSE endpoint doesn't exist.
 */

import { definePlugin } from "@nifrajs/core"
import {
  type ActiveObservation,
  type NifraSpan,
  type ObservationAdapter,
  tracing,
} from "@nifrajs/otel"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DevToolsEvent {
  readonly id: string
  readonly traceId: string
  readonly spanId: string
  readonly parentSpanId?: string | undefined
  readonly timestamp: number
  readonly method: string
  readonly path: string
  readonly status: number
  readonly durationMs: number
  readonly isrStatus?: string | undefined
  readonly bodyBytes: number
}

export interface DevToolsOptions {
  /** Maximum events to retain in the ring buffer (default 200). */
  readonly maxEvents?: number | undefined
  /** Maximum simultaneous SSE connections (default 5). */
  readonly maxConnections?: number | undefined
  /** SSE path (default `/_nifra/devtools`). */
  readonly path?: string | undefined
  /** Explicit enable switch. Defaults to true only when `NODE_ENV === "development"`. */
  readonly enabled?: boolean | undefined
  /** Permit non-loopback URL hosts. Default false. */
  readonly allowRemote?: boolean | undefined
  /** Additional origins permitted to open the stream. Same-origin requests are always allowed. */
  readonly allowedOrigins?: readonly string[] | undefined
  /** Optional request authorization for the stream. */
  readonly authorize?: ((request: Request) => boolean | Promise<boolean>) | undefined
  /**
   * Interval for SSE keep-alive comment frames, in milliseconds (default 15000). Pings stop
   * idle proxies/dev tunnels from dropping the stream and evict dead connections so they no
   * longer count against `maxConnections`.
   */
  readonly pingIntervalMs?: number | undefined
}

export interface DevToolsClientOptions {
  /** SSE path configured on the server plugin. */
  readonly path?: string | undefined
}

// ---------------------------------------------------------------------------
// Server middleware
// ---------------------------------------------------------------------------

const encoder = new TextEncoder()

/**
 * DevTools plugin. Its observation adapter projects the single request span into a
 * `DevToolsEvent`; its middleware only owns the secured SSE transport.
 * When configuring `tracing()` yourself, register it before this plugin so DevTools attaches to
 * that request owner.
 */
export function devtools(options?: DevToolsOptions | undefined) {
  const maxEvents = options?.maxEvents ?? 200
  const maxConnections = Math.max(1, options?.maxConnections ?? 5)
  const endpoint = options?.path ?? "/_nifra/devtools"
  const enabled = options?.enabled ?? process.env.NODE_ENV === "development"
  const allowRemote = options?.allowRemote ?? false
  const allowedOrigins = new Set(options?.allowedOrigins ?? [])
  const pingIntervalMs = Math.max(1, options?.pingIntervalMs ?? 15_000)
  const buffer: DevToolsEvent[] = []
  const controllers = new Set<ReadableStreamDefaultController>()
  let eventCounter = 0
  let pingTimer: ReturnType<typeof setInterval> | undefined

  const pingFrame = encoder.encode(": ping\n\n")

  function stopPing(): void {
    if (pingTimer === undefined) return
    clearInterval(pingTimer)
    pingTimer = undefined
  }

  function startPing(): void {
    if (pingTimer !== undefined) return
    pingTimer = setInterval(() => {
      for (const ctrl of controllers) {
        try {
          ctrl.enqueue(pingFrame)
        } catch {
          controllers.delete(ctrl)
        }
      }
      if (controllers.size === 0) stopPing()
    }, pingIntervalMs)
    // Keep-alive frames must never keep the process alive.
    ;(pingTimer as { unref?: () => void }).unref?.()
  }

  function dropController(ctrl: ReadableStreamDefaultController): void {
    controllers.delete(ctrl)
    if (controllers.size === 0) stopPing()
  }

  function broadcast(event: DevToolsEvent): void {
    const data = encoder.encode(`data: ${JSON.stringify(event)}\n\n`)
    for (const ctrl of controllers) {
      try {
        ctrl.enqueue(data)
      } catch {
        dropController(ctrl)
      }
    }
  }

  const adapter: ObservationAdapter = {
    onEnd(span: NifraSpan) {
      const method = span.attributes["http.request.method"]
      const path = span.attributes["url.path"]
      const status = span.attributes["http.response.status_code"]
      if (typeof method !== "string" || typeof path !== "string" || typeof status !== "number") {
        return
      }
      if (path === endpoint) return

      const isrStatus = span.attributes["nifra.isr.status"]
      const bodyBytes = span.attributes["http.response.body.size"]
      const event: DevToolsEvent = {
        id: String(++eventCounter),
        traceId: span.traceId,
        spanId: span.spanId,
        parentSpanId: span.parentSpanId,
        timestamp: span.startTime,
        method,
        path,
        status,
        durationMs: Math.round((span.durationMs ?? 0) * 100) / 100,
        isrStatus: typeof isrStatus === "string" ? isrStatus : undefined,
        bodyBytes: typeof bodyBytes === "number" ? bodyBytes : 0,
      }

      buffer.push(event)
      if (buffer.length > maxEvents) buffer.splice(0, buffer.length - maxEvents)
      broadcast(event)
    },
  }

  return definePlugin("devtools", (app) => {
    // Disabled → wire nothing: no tracing pipeline, no SSE middleware, zero per-request overhead.
    if (!enabled) return app
    return app.use(tracing({ adapters: [adapter] })).use({
      name: "devtools-stream",

      async onRequest(request: Request): Promise<Response | undefined> {
        // Handle the SSE endpoint
        const url = new URL(request.url)
        if (url.pathname === endpoint) {
          const loopback =
            url.hostname === "localhost" ||
            url.hostname === "127.0.0.1" ||
            url.hostname === "[::1]" ||
            url.hostname.endsWith(".localhost")
          if (!allowRemote && !loopback) {
            return new Response("Nifra DevTools is restricted to loopback hosts", { status: 403 })
          }
          const origin = request.headers.get("origin")
          if (origin !== null && origin !== url.origin && !allowedOrigins.has(origin)) {
            return new Response("Origin not allowed", { status: 403 })
          }
          if (options?.authorize !== undefined && !(await options.authorize(request))) {
            return new Response("Unauthorized", { status: 401 })
          }
          if (controllers.size >= maxConnections) {
            return new Response("Too many DevTools connections", {
              status: 503,
              headers: { "retry-after": "5" },
            })
          }

          let activeController: ReadableStreamDefaultController | undefined
          const stream = new ReadableStream({
            start(controller) {
              activeController = controller
              controllers.add(controller)
              startPing()
              // Send buffered events as initial payload
              for (const evt of buffer) {
                try {
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify(evt)}\n\n`))
                } catch {
                  break
                }
              }
            },
            cancel() {
              if (activeController !== undefined) dropController(activeController)
            },
          })

          // Clean up dead controllers on cancel
          const response = new Response(stream, {
            headers: {
              "content-type": "text/event-stream",
              "cache-control": "no-store",
              connection: "keep-alive",
              "content-security-policy": "default-src 'none'",
              "x-content-type-options": "nosniff",
              "x-nifra-devtools": "true",
            },
          })

          return response
        }

        return undefined
      },

      beforeHandle(context) {
        ;(context as typeof context & { observation?: ActiveObservation }).observation?.addAdapter(
          adapter,
        )
        return undefined
      },
    })
  })
}

// ---------------------------------------------------------------------------
// Browser client script
// ---------------------------------------------------------------------------

/**
 * Returns a self-contained JavaScript string that creates a floating DevTools
 * overlay in the browser. Inject via `<script>` tag in dev mode.
 *
 * The overlay:
 * - Connects to `/_nifra/devtools` via EventSource
 * - Shows a scrolling log of request traces
 * - Color-coded method badges and status codes
 * - ISR hit/miss/stale indicators
 * - Collapsible with a ⚡ toggle button
 */
export function devtoolsClientScript(options: DevToolsClientOptions = {}): string {
  const endpoint = JSON.stringify(options.path ?? "/_nifra/devtools")
  return `(function(){
  if(typeof window==='undefined')return;
  var MAX=50,events=[],open=false;

  // Panel container
  var panel=document.createElement('div');
  panel.id='nifra-devtools';
  panel.style.cssText='position:fixed;bottom:12px;right:12px;z-index:99999;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,monospace;font-size:12px;';

  // Toggle button
  var btn=document.createElement('button');
  btn.textContent='⚡';
  btn.title='Nifra DevTools';
  btn.style.cssText='width:36px;height:36px;border-radius:50%;border:1px solid rgba(255,255,255,0.15);background:rgba(10,10,30,0.9);color:#7c3aed;font-size:16px;cursor:pointer;backdrop-filter:blur(8px);display:flex;align-items:center;justify-content:center;box-shadow:0 4px 20px rgba(0,0,0,0.4);transition:transform 0.2s;';
  btn.onmouseenter=function(){btn.style.transform='scale(1.1)'};
  btn.onmouseleave=function(){btn.style.transform='scale(1)'};

  // Log container
  var log=document.createElement('div');
  log.style.cssText='display:none;width:380px;max-height:400px;overflow-y:auto;background:rgba(10,10,30,0.92);backdrop-filter:blur(16px);border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:8px;margin-bottom:8px;box-shadow:0 8px 32px rgba(0,0,0,0.5);';

  // Header
  var hdr=document.createElement('div');
  hdr.style.cssText='display:flex;justify-content:space-between;align-items:center;padding:4px 8px 8px;border-bottom:1px solid rgba(255,255,255,0.06);margin-bottom:6px;';
  hdr.innerHTML='<span style="color:#7c3aed;font-weight:700;font-size:13px;">⚡ Nifra DevTools</span>';
  var counter=document.createElement('span');
  counter.style.cssText='color:#888;font-size:11px;';
  counter.textContent='0 events';
  var clearBtn=document.createElement('button');
  clearBtn.textContent='Clear';
  clearBtn.style.cssText='background:none;border:1px solid rgba(255,255,255,0.1);color:#888;font-size:10px;padding:2px 8px;border-radius:4px;cursor:pointer;margin-left:8px;';
  clearBtn.onclick=function(){events=[];list.innerHTML='';counter.textContent='0 events';};
  var right=document.createElement('span');
  right.appendChild(counter);right.appendChild(clearBtn);
  hdr.appendChild(right);
  log.appendChild(hdr);

  var list=document.createElement('div');
  log.appendChild(list);

  panel.appendChild(log);
  panel.appendChild(btn);

  btn.onclick=function(){
    open=!open;
    log.style.display=open?'block':'none';
  };

  function methodColor(m){
    switch(m){case'GET':return'#2ecc71';case'POST':return'#3b82f6';case'PUT':return'#f59e0b';case'DELETE':return'#ef4444';default:return'#888';}
  }
  function statusColor(s){
    if(s<300)return'#2ecc71';if(s<400)return'#3b82f6';if(s<500)return'#f59e0b';return'#ef4444';
  }

  function addEvent(evt){
    events.push(evt);
    if(events.length>MAX)events.shift();
    counter.textContent=events.length+' events';

    var row=document.createElement('div');
    row.style.cssText='padding:4px 8px;border-bottom:1px solid rgba(255,255,255,0.04);display:flex;align-items:center;gap:8px;';

    var method=document.createElement('span');
    method.textContent=evt.method;
    method.style.cssText='font-weight:700;font-size:10px;padding:1px 6px;border-radius:3px;color:#fff;background:'+methodColor(evt.method)+';min-width:36px;text-align:center;';

    var path=document.createElement('span');
    path.textContent=evt.path;
    path.style.cssText='color:#e0e0e0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';

    var status=document.createElement('span');
    status.textContent=String(evt.status);
    status.style.cssText='color:'+statusColor(evt.status)+';font-weight:600;';

    var dur=document.createElement('span');
    dur.textContent=evt.durationMs+'ms';
    dur.style.cssText='color:#888;font-size:11px;min-width:50px;text-align:right;';

    row.appendChild(method);row.appendChild(path);row.appendChild(status);row.appendChild(dur);

    if(evt.isrStatus){
      var isr=document.createElement('span');
      isr.textContent=evt.isrStatus;
      var ic=evt.isrStatus==='hit'?'#2ecc71':evt.isrStatus==='stale'?'#f59e0b':'#888';
      isr.style.cssText='font-size:9px;padding:1px 4px;border-radius:3px;background:'+ic+'22;color:'+ic+';border:1px solid '+ic+'44;';
      row.appendChild(isr);
    }

    list.insertBefore(row,list.firstChild);
    if(list.children.length>MAX)list.removeChild(list.lastChild);
  }

  // Connect SSE
  var es=new EventSource(${endpoint});
  es.onmessage=function(e){
    try{addEvent(JSON.parse(e.data));}catch(err){}
  };

  document.body.appendChild(panel);
})();`
}
