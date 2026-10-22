import { hashSource } from "../../csp.ts"

/**
 * The PPR client runtime: one inline script in the shell, constant per release, listed in the CSP by
 * hash. It fills each hole host from that hole's inert JSON frame, keeps interactive holes' props for
 * the adapter, and on leaving the route sends the response's cancel token.
 *
 * `__nifraPpr(name)` is the only entry point a frame calls, so every invoker is constant per hole name
 * and hashable at build. Hole HTML goes in through `innerHTML`, where a `<script>` never runs, under a
 * Trusted Types policy named `nifra-ppr` when the browser has the API. The server has validated that
 * HTML before framing it; the policy only names the one sink.
 */
export const PPR_RUNTIME =
  '(()=>{var w=window,d=document,h={},s={},dead=0,p;var pol=function(){if(!p){try{p=w.trustedTypes?w.trustedTypes.createPolicy("nifra-ppr",{createHTML:function(x){return x}}):null}catch(_){}p=p||{createHTML:function(x){return x}}}return p};var f=function(n){if(dead)return;var e=d.getElementById("nifra-ppr:"+n);if(!e)return;var v;try{v=JSON.parse(e.textContent)}catch(_){return}e.remove();var t=d.querySelector(\'[data-nifra-hole="\'+n+\'"]\');if(!t||t.hasAttribute("data-nifra-filled"))return;t.innerHTML=pol().createHTML(typeof v.html==="string"?v.html:"");t.setAttribute("data-nifra-filled","");t.setAttribute("aria-busy","false");if(v.error)t.setAttribute("data-nifra-hole-error","");var o={props:v.props,error:!!v.error};h[n]=o;(s[n]||[]).slice().forEach(function(c){c(o)})};f.get=function(n){return h[n]};f.subscribe=function(n,c){(s[n]||(s[n]=[])).push(c);return function(){s[n]=(s[n]||[]).filter(function(x){return x!==c})}};f.leave=function(){if(dead)return;dead=1;s={};var r=d.getElementById("nifra-ppr-req");if(!r)return;var q;try{q=JSON.parse(r.textContent)}catch(_){return}if(q.cancel&&q.holes.some(function(n){return!h[n]})&&navigator.sendBeacon)navigator.sendBeacon(q.cancel,q.token)};f.dead=function(){return!!dead};f.boot=function(){var c=d.currentScript,e=c&&c.previousElementSibling;if(e&&e.rel==="modulepreload"&&e.href)import(e.href)};w.__nifraPpr=f})()'

/**
 * What loads each module script of a shell, after a `<link rel="modulepreload">` naming it. WebKit
 * evaluates a module script, `async` or not, only once the parser finishes, which on a streamed page
 * is after the slowest hole, and a dynamic import of the same URL waits with it. A dynamic import
 * from a classic script with no such element evaluates at once in every engine.
 */
export const PPR_BOOT = "__nifraPpr.boot()"

/** The script a frame runs to fill hole `name`. Constant per name, so it is listed by hash. */
export const holeInvoker = (name: string): string => `__nifraPpr(${JSON.stringify(name)})`

/**
 * The `script-src` hash sources a PPR route needs: the runtime, the boot call and one invoker per hole. Computed once
 * per route at startup, never per request.
 */
export async function pprScriptHashes(holeNames: readonly string[]): Promise<readonly string[]> {
  return Promise.all([PPR_RUNTIME, PPR_BOOT, ...holeNames.map(holeInvoker)].map(hashSource))
}
