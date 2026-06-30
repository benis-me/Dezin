/**
 * Serve a generated artifact file from an on-disk artifact directory, with
 * path-traversal protection. Prototype artifacts live at <dataDir>/projects/<id>/...
 * while Standard variants may live in git worktrees.
 */

import { readFile, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { ServerResponse } from "node:http";
import { send, sendError, contentTypeFor } from "./http-util.ts";

export function projectDir(dataDir: string, projectId: string): string {
  return join(dataDir, "projects", projectId);
}

/**
 * A tiny element-picker bridge injected into served prototype HTML. The workspace
 * toggles it via postMessage; on click it reports the clicked element's selector +
 * text back to the parent, so the user can point at a region and refine it in chat.
 */
const SELECT_BRIDGE = `<script data-dezin-bridge>(function(){
if(window.__dezinSelect)return;window.__dezinSelect=1;
var on=false,pinned=false,box;
function mkbox(){box=document.createElement('div');box.style.cssText='position:fixed;pointer-events:none;z-index:2147483647;border:2px solid #2563eb;background:rgba(37,99,235,.10);border-radius:3px;display:none';document.body.appendChild(box);}
function css(v){try{return CSS&&CSS.escape?CSS.escape(v):v.replace(/[^a-zA-Z0-9_-]/g,'\\\\$&');}catch(_){return v;}}
function attr(v){return String(v).replace(/\\\\/g,'\\\\\\\\').replace(/"/g,'\\\\"');}
function nth(el){var i=1,n=el;while((n=n.previousElementSibling)){if(n.tagName===el.tagName)i++;}return i;}
function stable(el){var target=el.getAttribute&&el.getAttribute('data-dezin-id');if(target)return '[data-dezin-id="'+attr(target)+'"]';var label=el.getAttribute&&el.getAttribute('data-screen-label');if(label)return '[data-screen-label="'+attr(label)+'"]';if(el.id)return el.tagName.toLowerCase()+'#'+css(el.id);return '';}
function path(el){if(!el||el===document.body||el===document.documentElement)return el?el.tagName.toLowerCase():'';var exact=stable(el);if(exact)return exact;var parts=[],n=el,depth=0;while(n&&n.nodeType===1&&n!==document.body&&depth<5){var st=stable(n);if(st){parts.unshift(st);break;}var p=n.tagName.toLowerCase();if(n.classList&&n.classList.length)p+='.'+[].slice.call(n.classList).slice(0,2).map(css).join('.');p+=':nth-of-type('+nth(n)+')';parts.unshift(p);n=n.parentElement;depth++;}return parts.join(' > ');}
function attrs(el){try{var cls=typeof el.className==='string'?el.className:(el.getAttribute&&el.getAttribute('class'))||'';return{id:el.id||'',className:cls,role:(el.getAttribute&&el.getAttribute('role'))||'',ariaLabel:(el.getAttribute&&el.getAttribute('aria-label'))||'',screenLabel:(el.getAttribute&&el.getAttribute('data-screen-label'))||'',href:(el.getAttribute&&el.getAttribute('href'))||'',src:(el.getAttribute&&el.getAttribute('src'))||''};}catch(_){return{};}}
function styles(el){try{var s=getComputedStyle(el);return{display:s.display,position:s.position,top:s.top,right:s.right,bottom:s.bottom,left:s.left,zIndex:s.zIndex,width:s.width,height:s.height,minWidth:s.minWidth,maxWidth:s.maxWidth,minHeight:s.minHeight,maxHeight:s.maxHeight,overflow:s.overflow,overflowX:s.overflowX,overflowY:s.overflowY,flexDirection:s.flexDirection,flexWrap:s.flexWrap,justifyContent:s.justifyContent,alignItems:s.alignItems,alignContent:s.alignContent,gap:s.gap,rowGap:s.rowGap,columnGap:s.columnGap,gridTemplateColumns:s.gridTemplateColumns,gridTemplateRows:s.gridTemplateRows,padding:s.padding,margin:s.margin,color:s.color,background:s.backgroundColor,backgroundImage:s.backgroundImage,fontFamily:s.fontFamily,fontSize:s.fontSize,fontWeight:s.fontWeight,lineHeight:s.lineHeight,letterSpacing:s.letterSpacing,textAlign:s.textAlign,textTransform:s.textTransform,borderRadius:s.borderRadius,opacity:s.opacity,borderColor:s.borderColor,borderWidth:s.borderWidth,borderStyle:s.borderStyle,borderTopColor:s.borderTopColor,borderTopWidth:s.borderTopWidth,borderTopStyle:s.borderTopStyle,borderRightColor:s.borderRightColor,borderRightWidth:s.borderRightWidth,borderRightStyle:s.borderRightStyle,borderBottomColor:s.borderBottomColor,borderBottomWidth:s.borderBottomWidth,borderBottomStyle:s.borderBottomStyle,borderLeftColor:s.borderLeftColor,borderLeftWidth:s.borderLeftWidth,borderLeftStyle:s.borderLeftStyle,outlineColor:s.outlineColor,outlineWidth:s.outlineWidth,outlineStyle:s.outlineStyle,boxShadow:s.boxShadow,filter:s.filter,backdropFilter:s.backdropFilter,transform:s.transform,mixBlendMode:s.mixBlendMode};}catch(_){return{};}}
function fit(el){if(!box)return;var r=el.getBoundingClientRect();box.style.display='block';box.style.left=r.left+'px';box.style.top=r.top+'px';box.style.width=r.width+'px';box.style.height=r.height+'px';}
function move(e){if(!on||pinned)return;fit(e.target);}
function click(e){if(!on)return;e.preventDefault();e.stopPropagation();var el=e.target;var r=el.getBoundingClientRect();fit(el);pinned=true;on=false;parent.postMessage({source:'dezin',type:'selected',selector:path(el),tag:el.tagName.toLowerCase(),text:(el.textContent||'').replace(/\\s+/g,' ').trim().slice(0,90),rect:{x:Math.round(r.left),y:Math.round(r.top),w:Math.round(r.width),h:Math.round(r.height)},styles:styles(el),attrs:attrs(el)},'*');}
function mode(v){on=v;if(v)pinned=false;if(box&&!v&&!pinned)box.style.display='none';try{document.body.style.cursor=v?'crosshair':'';}catch(_){}}
function clearMark(){pinned=false;if(box)box.style.display='none';try{document.body.style.cursor='';}catch(_){}}
function focusTarget(selector,rect){var el=null;try{if(selector)el=document.querySelector(selector);}catch(_){}if(el){try{el.scrollIntoView({behavior:'smooth',block:'center',inline:'center'});}catch(_){try{el.scrollIntoView();}catch(__){}}fit(el);window.setTimeout(function(){fit(el);},80);pinned=true;on=false;return;}if(rect&&box){box.style.display='block';box.style.left=rect.x+'px';box.style.top=rect.y+'px';box.style.width=rect.w+'px';box.style.height=rect.h+'px';pinned=true;on=false;}}
function init(){mkbox();document.addEventListener('mousemove',move,true);document.addEventListener('click',click,true);document.addEventListener('keydown',function(e){if((on||pinned)&&e.key==='Escape'){parent.postMessage({source:'dezin',type:'cancel'},'*');mode(false);clearMark();}},true);window.addEventListener('message',function(e){var d=e.data;if(!d||d.source!=='dezin-parent')return;if(d.type==='select-mode')mode(!!d.on);else if(d.type==='clear')clearMark();else if(d.type==='focus-target')focusTarget(d.selector,d.rect);});}
if(document.body)init();else document.addEventListener('DOMContentLoaded',init);
})();</script>`;

/** Inject the picker bridge before </body> (or append) for HTML responses. */
export function injectSelectBridge(html: string): string {
  const i = html.lastIndexOf("</body>");
  return i >= 0 ? html.slice(0, i) + SELECT_BRIDGE + html.slice(i) : html + SELECT_BRIDGE;
}

/** Resolve a relative request path inside `root`, or null if it escapes. */
export function safeJoin(root: string, rel: string): string | null {
  const target = resolve(root, rel);
  const base = resolve(root);
  if (target !== base && !target.startsWith(base + sep)) return null;
  return target;
}

export async function serveProjectFile(res: ServerResponse, dataDir: string, projectId: string, relPath: string): Promise<void> {
  return serveFileFromBase(res, projectDir(dataDir, projectId), relPath);
}

export async function serveFileFromBase(res: ServerResponse, root: string, relPath: string): Promise<void> {
  const rel = relPath === "" ? "index.html" : relPath;
  const target = safeJoin(root, rel);
  if (!target) {
    sendError(res, 400, "invalid path");
    return;
  }
  try {
    const s = await stat(target);
    const file = s.isDirectory() ? safeJoin(target, "index.html") : target;
    if (!file) {
      sendError(res, 400, "invalid path");
      return;
    }
    const contentType = contentTypeFor(file);
    // Inject the element-picker bridge into the previewed HTML document only.
    if (contentType.startsWith("text/html")) {
      const html = injectSelectBridge(await readFile(file, "utf8"));
      send(res, 200, html, contentType);
      return;
    }
    const bytes = await readFile(file);
    send(res, 200, bytes, contentType);
  } catch {
    sendError(res, 404, "not found");
  }
}
