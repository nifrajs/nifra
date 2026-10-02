/**
 * The browser half of the dev feed: a small inline script a dev server puts first in each page's
 * `<head>`, so the agent sees what the page did after it left the server - uncaught errors, unhandled
 * rejections, failed script/stylesheet loads, hydration mismatches and console output.
 *
 * Inline and first, rather than a module, so it is listening before any module (the framework, the
 * HMR client, the app) runs. Dev only: nothing here is reachable from a production build.
 */

import { createHash } from "node:crypto"
import { type DevLogLevel, isDevLogLevel } from "./dev-feed.ts"
import { admitInlineScript } from "./internal/dev-csp.ts"

export interface DevClientConfig {
  /** Where the batches go (same origin). */
  readonly ingestPath: string
  /** Proves a batch came from a page this server served. */
  readonly pageToken: string
  /** The request that rendered this document: browser entries from it carry the same id. */
  readonly requestId?: string | undefined
  /** The document's path + search, so a client-side navigation away stops claiming that request. */
  readonly documentPath?: string | undefined
}

// ES2017, no dependencies, no globals beyond one idempotence flag. Keep it small: it ships in every dev
// page, and its hash goes into every CSP that needs one.
const CLIENT_SOURCE = String.raw`(function(C){
if(window.__nifraDevClient)return;window.__nifraDevClient=1;
var q=[],timer=0,inside=0,MSG=8000,STACK=16000;
function cap(s,n){s=String(s);return s.length>n?s.slice(0,n)+"...":s}
function where(){return location.pathname+location.search}
function ser(v,d){
if(typeof v==="string")return v;
if(v instanceof Error)return v.stack||v.name+": "+v.message;
if(typeof v==="function")return"[Function "+(v.name||"anonymous")+"]";
if(typeof v!=="object"||v===null)return String(v);
if(typeof Element!=="undefined"&&v instanceof Element)return"<"+v.tagName.toLowerCase()+(v.id?"#"+v.id:"")+">";
if(d>2)return Array.isArray(v)?"[Array]":"[Object]";
var seen=[];
try{return JSON.stringify(v,function(k,x){
if(typeof x==="object"&&x!==null){if(seen.indexOf(x)!==-1)return"[Circular]";seen.push(x)}
if(typeof x==="bigint")return x+"n";
if(x instanceof Error)return x.name+": "+x.message;
return x})}catch(e){return Object.prototype.toString.call(v)}}
function fmt(a){
var args=Array.prototype.slice.call(a),out=[];
if(typeof args[0]==="string"&&args[0].indexOf("%")!==-1){
var rest=args.slice(1);
out.push(args[0].replace(/%([sdifoOjc%])/g,function(m,k){
if(k==="%")return"%";
if(!rest.length)return m;
var v=rest.shift();
if(k==="c")return"";
if(k==="d"||k==="i")return String(parseInt(v,10));
if(k==="f")return String(parseFloat(v));
return ser(v,0)}));
args=rest}
for(var i=0;i<args.length;i++)out.push(ser(args[i],0));
return out.join(" ")}
function send(keep){
clearTimeout(timer);timer=0;
while(q.length){
var body=JSON.stringify({token:C.t,events:q.splice(0,50)});
try{fetch(C.u,{method:"POST",body:body,keepalive:!!keep&&body.length<60000,headers:{"content-type":"application/json"},credentials:"same-origin"}).catch(function(){})}catch(e){}}}
function push(e){
e.page=cap(where(),2000);
if(C.r&&e.page===C.p)e.requestId=C.r;
q.push(e);
if(q.length>=50)send(false);else if(!timer)timer=setTimeout(send,100)}
["debug","info","log","warn","error"].forEach(function(level){
var orig=console[level];if(typeof orig!=="function")return;
console[level]=function(){
if(!inside){inside=1;try{
var ev={kind:"console",level:level,message:cap(fmt(arguments),MSG)};
if(level==="error")for(var i=0;i<arguments.length;i++){var x=arguments[i];
if(x instanceof Error){ev.error={name:cap(x.name,200),message:cap(x.message,MSG),stack:cap(x.stack||"",STACK)};break}}
push(ev)}catch(e){}inside=0}
return orig.apply(this,arguments)}});
addEventListener("error",function(ev){
var t=ev.target;
if(t&&t!==window&&t.tagName){
var tag=t.tagName.toLowerCase(),rel=(t.rel||"").toLowerCase();
if(tag==="script"||(tag==="link"&&/stylesheet|modulepreload|preload/.test(rel)))push({kind:"resource",tag:tag,url:cap(t.src||t.href||"",2000)});
return}
var e=ev.error;
if(!e&&ev.message==="Script error.")return;
push({kind:"error",name:cap(e&&e.name?e.name:"Error",200),message:cap(e&&e.message!=null?e.message:ev.message,MSG),
stack:cap(e&&e.stack?e.stack:(ev.filename?"    at "+ev.filename+":"+ev.lineno+":"+ev.colno:""),STACK)})},true);
addEventListener("unhandledrejection",function(ev){
var r=ev.reason;
if(r instanceof Error)push({kind:"rejection",name:cap(r.name,200),message:cap(r.message,MSG),stack:cap(r.stack||"",STACK)});
else push({kind:"rejection",name:"UnhandledRejection",message:cap(ser(r,0),MSG)})});
addEventListener("pagehide",function(){send(true)});
document.addEventListener("visibilitychange",function(){if(document.visibilityState==="hidden")send(true)});
})`

// `</script` inside a JSON value would end the element early; `<!--` can start a script-data escape.
const scriptSafe = (json: string): string =>
  json
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029")

/** The script's text (without the `<script>` element). */
export function devClientSource(config: DevClientConfig): string {
  const settings: Record<string, string> = { u: config.ingestPath, t: config.pageToken }
  if (config.requestId !== undefined && config.documentPath !== undefined) {
    settings.r = config.requestId
    settings.p = config.documentPath
  }
  return `${CLIENT_SOURCE}(${scriptSafe(JSON.stringify(settings))})`
}

/** The CSP source that admits exactly `source`. */
export function scriptHash(source: string): string {
  return `'sha256-${createHash("sha256").update(source).digest("base64")}'`
}

/** Whether a response is a page the script belongs in: HTML, with a body nobody has encoded yet. */
export function isInjectablePage(response: Response, method: string): boolean {
  if (method === "HEAD" || response.body === null) return false
  if (response.status === 204 || response.status === 304) return false
  if (response.headers.has("content-encoding")) return false
  return (response.headers.get("content-type") ?? "").toLowerCase().includes("text/html")
}

/**
 * Prepare `headers` for the script: admit it in the page's CSP, by hash unless `nonced` (the caller
 * puts a nonce on every script afterwards). Returns the `<script>` element to insert, or undefined
 * when the page's CSP forbids scripts and nothing should be inserted.
 */
export function devClientTag(
  config: DevClientConfig,
  headers: Headers,
  origin: string,
  nonced = false,
): string | undefined {
  const source = devClientSource(config)
  const hash = nonced ? undefined : scriptHash(source)
  if (!admitInlineScript(headers, hash, new URL(config.ingestPath, origin))) return undefined
  return `<script data-nifra-dev>${source}</script>`
}

// Latin-1 views keep string offsets equal to byte offsets, so a match position is a splice point.
const latin1 = new TextDecoder("latin1")
const HEAD_OPEN = /<head(?:\s[^>]*)?>/i
const META_CHARSET = /^\s*<meta\s[^>]*charset\s*=[^>]*>/i
// Past this, a page without `<head>` is a fragment: stop looking and stream it as it is.
const HEAD_SEARCH_LIMIT = 64 * 1024
// Enough to see a `<meta charset>` that immediately follows `<head>`.
const META_LOOKAHEAD = 256

/** Where the script goes in `text`: after `<head>`, and after a `<meta charset>` that leads it. */
function insertionPoint(text: string, final: boolean): number | "wait" | "none" {
  const head = HEAD_OPEN.exec(text)
  if (head === null) {
    const body = /<body[\s>]/i.test(text)
    return final || body || text.length > HEAD_SEARCH_LIMIT ? "none" : "wait"
  }
  const afterHead = head.index + head[0].length
  const rest = text.slice(afterHead)
  const meta = META_CHARSET.exec(rest)
  if (meta !== null) return afterHead + meta[0].length
  if (!final && rest.length < META_LOOKAHEAD && !/<(?!meta)/i.test(rest.replace(/^\s+/, "")))
    return "wait"
  return afterHead
}

/** `html` with `tag` inserted into its head; unchanged when there is no `<head>`. */
export function injectIntoHtml(html: string, tag: string): string {
  const at = insertionPoint(html, true)
  return typeof at === "number" ? html.slice(0, at) + tag + html.slice(at) : html
}

function concat(chunks: readonly Uint8Array[], length: number): Uint8Array {
  const out = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

/**
 * Stream `body` with `tag` inserted into its head. Only the prefix up to the insertion point is held
 * back; the rest streams through untouched, so a streamed SSR page keeps its first-byte time.
 */
export function injectIntoStream(
  body: ReadableStream<Uint8Array>,
  tag: string,
): ReadableStream<Uint8Array> {
  const insert = new TextEncoder().encode(tag)
  const held: Uint8Array[] = []
  let heldBytes = 0
  let done = false
  const release = (
    controller: TransformStreamDefaultController<Uint8Array>,
    final: boolean,
  ): void => {
    const bytes = concat(held, heldBytes)
    const at = insertionPoint(latin1.decode(bytes), final)
    if (at === "wait") return
    held.length = 0
    heldBytes = 0
    done = true
    if (at === "none") {
      controller.enqueue(bytes)
      return
    }
    controller.enqueue(bytes.subarray(0, at))
    controller.enqueue(insert)
    controller.enqueue(bytes.subarray(at))
  }
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        if (done) {
          controller.enqueue(chunk)
          return
        }
        held.push(chunk)
        heldBytes += chunk.byteLength
        release(controller, false)
      },
      flush(controller) {
        if (!done && heldBytes > 0) release(controller, true)
      },
    }),
  )
}

// ---------------------------------------------------------------------------------------------------
// What the script sends
// ---------------------------------------------------------------------------------------------------

/** One batch is bounded by what `fetch(keepalive)` may carry. */
export const CLIENT_BATCH_MAX_BYTES = 64 * 1024
export const CLIENT_BATCH_MAX_EVENTS = 50

interface EventContext {
  readonly page: string
  readonly requestId?: string | undefined
}

export interface BrowserError {
  readonly name: string
  readonly message: string
  readonly stack: string
}

export type ClientEvent = EventContext &
  (
    | {
        readonly kind: "error" | "rejection"
        readonly name: string
        readonly message: string
        readonly stack: string
      }
    | { readonly kind: "resource"; readonly tag: string; readonly url: string }
    | {
        readonly kind: "console"
        readonly level: DevLogLevel
        readonly message: string
        /** The first Error a `console.error` call was given: frameworks report caught errors so. */
        readonly error?: BrowserError | undefined
      }
  )

export interface ClientBatch {
  readonly token: string
  readonly events: readonly ClientEvent[]
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const text = (value: unknown, max: number): string | undefined =>
  typeof value === "string" ? value.slice(0, max) : undefined

// The script only ever tags an event with the id the server put in it; anything else is dropped.
const REQUEST_ID = /^r\d{1,12}$/

function parseBrowserError(value: unknown): BrowserError | undefined {
  if (!isRecord(value)) return undefined
  const message = text(value.message, 8 * 1024)
  if (message === undefined) return undefined
  return {
    name: text(value.name, 200) || "Error",
    message,
    stack: text(value.stack, 16 * 1024) ?? "",
  }
}

function parseEvent(value: unknown): ClientEvent | undefined {
  if (!isRecord(value)) return undefined
  const page = text(value.page, 2048)
  if (page === undefined || !page.startsWith("/")) return undefined
  const requestId =
    typeof value.requestId === "string" && REQUEST_ID.test(value.requestId)
      ? value.requestId
      : undefined
  if (value.kind === "error" || value.kind === "rejection") {
    const error = parseBrowserError(value)
    return error === undefined ? undefined : { kind: value.kind, ...error, page, requestId }
  }
  if (value.kind === "resource") {
    const tag = text(value.tag, 20)
    const url = text(value.url, 2048)
    if (tag === undefined || url === undefined) return undefined
    return { kind: "resource", tag, url, page, requestId }
  }
  if (value.kind === "console") {
    const message = text(value.message, 8 * 1024)
    if (message === undefined || !isDevLogLevel(value.level)) return undefined
    const error = parseBrowserError(value.error)
    return { kind: "console", level: value.level, message, error, page, requestId }
  }
  return undefined
}

/** A batch the script could have sent, or undefined. Malformed events are dropped, not fatal. */
export function parseClientBatch(value: unknown): ClientBatch | undefined {
  if (!isRecord(value) || typeof value.token !== "string" || !Array.isArray(value.events))
    return undefined
  if (value.events.length > CLIENT_BATCH_MAX_EVENTS) return undefined
  const events: ClientEvent[] = []
  for (const raw of value.events) {
    const event = parseEvent(raw)
    if (event !== undefined) events.push(event)
  }
  return { token: value.token, events }
}
