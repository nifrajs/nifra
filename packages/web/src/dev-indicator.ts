/**
 * The in-page issues indicator: a badge a dev page shows once the browser reported an error, opening a
 * panel with each error's code, message, source location, recognised fix and a Copy prompt button per
 * fix. The dev client loads it on the first error the server answers for (so a page without errors
 * never fetches it), and the server only ever hands a page the errors that page itself reported.
 *
 * Rendered into a closed shadow root with a constructable stylesheet, so the page's styles and a strict
 * `style-src` leave it alone; every string goes through `textContent`. Dev only.
 */

/** One reported error, as the ingest endpoint answers it. */
export interface DevIssue {
  readonly id: string
  readonly seq: number
  readonly count: number
  readonly code: string
  readonly category: string
  readonly message: string
  readonly page?: string | undefined
  readonly at?: string | undefined
  readonly codeframe?:
    | { readonly lines: ReadonlyArray<{ number: number; text: string; caret: boolean }> }
    | undefined
  readonly cause?: string | undefined
  readonly fix?: string | undefined
  readonly docs?: string | undefined
  readonly prompts: ReadonlyArray<{ readonly label: string; readonly prompt: string }>
}

/** At most this many issues reach a page per batch, and the panel keeps the newest of this many. */
export const DEV_INDICATOR_MAX_ISSUES = 10

// ES2017, no dependencies. `__nifraDevClient` is the inline client's state object: `issues` queues what
// arrived before this module ran, `indicator` is how the client hands over later ones.
export const DEV_INDICATOR_SOURCE = String.raw`(function(){
var C=window.__nifraDevClient;
if(!C||typeof C!=="object"||C.indicator)return;
var MAX=50,issues=[],hidden=false,open=false,host,root,badge,panel,list,status;
var CSS=":host{all:initial}"+
".badge{position:fixed;left:16px;bottom:16px;z-index:2147483647;display:flex;align-items:center;gap:8px;font:600 13px/1 ui-sans-serif,system-ui,sans-serif;color:#fff;background:#b42318;border:0;border-radius:999px;padding:9px 14px;cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,.3)}"+
".badge:focus-visible,button:focus-visible,a:focus-visible{outline:2px solid #fdb022;outline-offset:2px}"+
".panel{position:fixed;left:16px;bottom:60px;z-index:2147483647;width:min(600px,calc(100vw - 32px));max-height:min(70vh,640px);overflow:auto;box-sizing:border-box;font:13px/1.5 ui-sans-serif,system-ui,sans-serif;color:#1f2328;background:#fff;border:1px solid #d0d7de;border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,.25)}"+
".head{position:sticky;top:0;display:flex;align-items:center;gap:8px;padding:10px 14px;background:inherit;border-bottom:1px solid #d0d7de}"+
".head h2{margin:0;font-size:13px;flex:1}"+
".head button{font:inherit;background:none;border:1px solid #d0d7de;border-radius:6px;padding:3px 8px;cursor:pointer;color:inherit}"+
"ol{list-style:none;margin:0;padding:0}"+
"li{padding:12px 14px;border-bottom:1px solid #d0d7de}"+
".tags{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:6px}"+
".tag{font:600 11px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;padding:0 7px;border-radius:999px;background:#ffebe9;color:#a40e26}"+
".tag.cat{background:#eaeef2;color:#424a53}"+
".msg{margin:0 0 6px;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;word-break:break-word;max-height:9em;overflow:auto}"+
".at{font:12px ui-monospace,SFMono-Regular,Menlo,monospace;color:#57606a;margin:0 0 6px}"+
"pre{margin:0 0 8px;padding:8px;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;background:#f6f8fa;border-radius:6px;overflow:auto}"+
".caret{background:#ffebe9;display:block}"+
".fix{margin:0 0 8px;color:#424a53}"+
".actions{display:flex;flex-wrap:wrap;gap:6px;align-items:center}"+
".actions button{font:inherit;font-size:12px;color:#fff;background:#1f6feb;border:0;border-radius:6px;padding:5px 10px;cursor:pointer}"+
".actions a{font-size:12px;color:#0969da}"+
"textarea{width:100%;box-sizing:border-box;margin-top:6px;font:11px/1.4 ui-monospace,Menlo,monospace}"+
".status{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}"+
"@media (prefers-color-scheme:dark){.panel{color:#e6edf3;background:#161b22;border-color:#30363d}.head,li{border-color:#30363d}.head button{border-color:#30363d}.tag.cat{background:#30363d;color:#c9d1d9}.at,.fix{color:#9da7b3}pre{background:#0d1117}.caret{background:#3d1d20}.tag{background:#3d1d20;color:#ffa198}.actions a{color:#58a6ff}}";
function el(tag,cls,text){var e=document.createElement(tag);if(cls)e.className=cls;if(text!=null)e.textContent=String(text);return e}
function say(text){if(status)status.textContent=text}
function copy(text,into){
function manual(){var t=el("textarea");t.readOnly=true;t.rows=8;t.value=text;into.appendChild(t);t.focus();t.select();var ok=false;try{ok=document.execCommand("copy")}catch(e){}
if(ok){t.remove();say("Copied. Paste it into your coding agent.")}else say("Select the text and copy it.")}
if(window.isSecureContext&&navigator.clipboard)navigator.clipboard.writeText(text).then(function(){say("Copied. Paste it into your coding agent.")},manual);else manual()}
function item(issue){
var li=el("li"),tags=el("div","tags");
tags.appendChild(el("span","tag",issue.code));tags.appendChild(el("span","tag cat",issue.category+(issue.count>1?" x"+issue.count:"")));
li.appendChild(tags);li.appendChild(el("p","msg",issue.message));
if(issue.at)li.appendChild(el("p","at",issue.at));
if(issue.codeframe&&issue.codeframe.lines){var pre=el("pre");issue.codeframe.lines.forEach(function(l){var row=el("span",l.caret?"caret":"",(l.caret?"> ":"  ")+l.number+" | "+l.text);pre.appendChild(row);if(!l.caret)pre.appendChild(document.createTextNode("\n"))});li.appendChild(pre)}
if(issue.fix)li.appendChild(el("p","fix",issue.fix));
var actions=el("div","actions");
(issue.prompts||[]).forEach(function(p){var b=el("button","",issue.prompts.length>1?"Copy prompt: "+p.label:"Copy prompt");b.type="button";b.addEventListener("click",function(){copy(p.prompt,li)});actions.appendChild(b)});
if(issue.docs&&/^https:\/\//.test(issue.docs)){var a=el("a","","Docs");a.href=issue.docs;a.target="_blank";a.rel="noreferrer";actions.appendChild(a)}
li.appendChild(actions);return li}
function render(){
if(hidden)return;
var n=issues.length;badge.textContent=n+(n===1?" issue":" issues");badge.setAttribute("aria-expanded",open?"true":"false");
panel.hidden=!open;
while(list.firstChild)list.removeChild(list.firstChild);
for(var i=issues.length-1;i>=0;i--)list.appendChild(item(issues[i]))}
function toggle(to){open=to;render();if(open){var first=panel.querySelector("button");if(first)first.focus()}else badge.focus()}
function mount(){
host=document.createElement("nifra-dev-indicator");
root=host.attachShadow({mode:"closed"});
try{var sheet=new CSSStyleSheet();sheet.replaceSync(CSS);root.adoptedStyleSheets=[sheet]}catch(e){root.appendChild(el("style","",CSS))}
badge=el("button","badge");badge.type="button";badge.setAttribute("aria-controls","nifra-dev-panel");
badge.addEventListener("click",function(){toggle(!open)});
panel=el("section","panel");panel.id="nifra-dev-panel";panel.setAttribute("aria-label","nifra dev issues");panel.hidden=true;
var head=el("div","head");head.appendChild(el("h2","","nifra dev: browser errors"));
var hide=el("button","","Hide");hide.type="button";hide.addEventListener("click",function(){hidden=true;host.remove()});
var close=el("button","","Close");close.type="button";close.addEventListener("click",function(){toggle(false)});
head.appendChild(close);head.appendChild(hide);panel.appendChild(head);
list=el("ol");panel.appendChild(list);
status=el("div","status");status.setAttribute("role","status");status.setAttribute("aria-live","polite");
root.appendChild(badge);root.appendChild(panel);root.appendChild(status);
root.addEventListener("keydown",function(e){if(e.key==="Escape"&&open){e.stopPropagation();toggle(false)}});
(document.body||document.documentElement).appendChild(host)}
function add(list2){
if(hidden||!list2||!list2.length)return;
for(var i=0;i<list2.length;i++){var x=list2[i];if(!x||typeof x.id!=="string")continue;
for(var j=0;j<issues.length;j++)if(issues[j].id===x.id){issues.splice(j,1);break}
issues.push(x)}
while(issues.length>MAX)issues.shift();
if(!host)mount();
render()}
C.indicator={add:function(l){try{add(l)}catch(e){}}};
var queued=C.issues||[];C.issues=[];
if(document.body)C.indicator.add(queued);else document.addEventListener("DOMContentLoaded",function(){C.indicator.add(queued)});
})()`
