import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dezin previews this project by loading its dev server in an iframe. host + open
// allowedHosts let that work; Dezin assigns the port.

// Element-picker bridge — injected ONLY into the dev server's HTML (never the build),
// so Dezin's "select an element" tool works in standard mode too. Mirrors the prototype
// bridge in apps/daemon/src/serve-static.ts.
const PICKER_BRIDGE = `<script data-dezin-bridge>(function(){
	if(window.__dezinSelect)return;window.__dezinSelect=1;
	var on=false,pinned=false,hoverBox,selectedBox,selectedEl;
	function mkbox(){hoverBox=document.createElement('div');hoverBox.style.cssText='position:fixed;pointer-events:none;z-index:2147483646;border:2px solid #2563eb;background:rgba(37,99,235,.10);border-radius:3px;display:none';document.body.appendChild(hoverBox);selectedBox=document.createElement('div');selectedBox.style.cssText='position:fixed;pointer-events:none;z-index:2147483647;border:2px solid #f97316;background:rgba(249,115,22,.14);border-radius:3px;display:none';document.body.appendChild(selectedBox);}
	function css(v){try{return CSS&&CSS.escape?CSS.escape(v):v.replace(/[^a-zA-Z0-9_-]/g,'\\\\$&');}catch(_){return v;}}
	function attr(v){return String(v).replace(/\\\\/g,'\\\\\\\\').replace(/"/g,'\\\\"');}
	function nth(el){var i=1,n=el;while((n=n.previousElementSibling)){if(n.tagName===el.tagName)i++;}return i;}
	function stable(el){var target=el.getAttribute&&el.getAttribute('data-dezin-id');if(target)return '[data-dezin-id="'+attr(target)+'"]';var label=el.getAttribute&&el.getAttribute('data-screen-label');if(label)return '[data-screen-label="'+attr(label)+'"]';if(el.id)return el.tagName.toLowerCase()+'#'+css(el.id);return '';}
	function path(el){if(!el||el===document.body||el===document.documentElement)return el?el.tagName.toLowerCase():'';var exact=stable(el);if(exact)return exact;var parts=[],n=el,depth=0;while(n&&n.nodeType===1&&n!==document.body&&depth<5){var st=stable(n);if(st){parts.unshift(st);break;}var p=n.tagName.toLowerCase();if(n.classList&&n.classList.length)p+='.'+[].slice.call(n.classList).slice(0,2).map(css).join('.');p+=':nth-of-type('+nth(n)+')';parts.unshift(p);n=n.parentElement;depth++;}return parts.join(' > ');}
	function attrs(el){try{var cls=typeof el.className==='string'?el.className:(el.getAttribute&&el.getAttribute('class'))||'';return{id:el.id||'',className:cls,role:(el.getAttribute&&el.getAttribute('role'))||'',ariaLabel:(el.getAttribute&&el.getAttribute('aria-label'))||'',screenLabel:(el.getAttribute&&el.getAttribute('data-screen-label'))||'',href:(el.getAttribute&&el.getAttribute('href'))||'',src:(el.getAttribute&&el.getAttribute('src'))||''};}catch(_){return{};}}
	function styles(el){try{var s=getComputedStyle(el);return{display:s.display,position:s.position,top:s.top,right:s.right,bottom:s.bottom,left:s.left,zIndex:s.zIndex,width:s.width,height:s.height,minWidth:s.minWidth,maxWidth:s.maxWidth,minHeight:s.minHeight,maxHeight:s.maxHeight,overflow:s.overflow,overflowX:s.overflowX,overflowY:s.overflowY,flexDirection:s.flexDirection,flexWrap:s.flexWrap,justifyContent:s.justifyContent,alignItems:s.alignItems,alignContent:s.alignContent,gap:s.gap,rowGap:s.rowGap,columnGap:s.columnGap,gridTemplateColumns:s.gridTemplateColumns,gridTemplateRows:s.gridTemplateRows,padding:s.padding,margin:s.margin,color:s.color,background:s.backgroundColor,backgroundImage:s.backgroundImage,fontFamily:s.fontFamily,fontSize:s.fontSize,fontWeight:s.fontWeight,lineHeight:s.lineHeight,letterSpacing:s.letterSpacing,textAlign:s.textAlign,textTransform:s.textTransform,borderRadius:s.borderRadius,opacity:s.opacity,borderColor:s.borderColor,borderWidth:s.borderWidth,borderStyle:s.borderStyle,borderTopColor:s.borderTopColor,borderTopWidth:s.borderTopWidth,borderTopStyle:s.borderTopStyle,borderRightColor:s.borderRightColor,borderRightWidth:s.borderRightWidth,borderRightStyle:s.borderRightStyle,borderBottomColor:s.borderBottomColor,borderBottomWidth:s.borderBottomWidth,borderBottomStyle:s.borderBottomStyle,borderLeftColor:s.borderLeftColor,borderLeftWidth:s.borderLeftWidth,borderLeftStyle:s.borderLeftStyle,outlineColor:s.outlineColor,outlineWidth:s.outlineWidth,outlineStyle:s.outlineStyle,boxShadow:s.boxShadow,filter:s.filter,backdropFilter:s.backdropFilter,transform:s.transform,mixBlendMode:s.mixBlendMode};}catch(_){return{};}}
	function place(box,r){if(!box)return;box.style.display='block';box.style.left=r.left+'px';box.style.top=r.top+'px';box.style.width=r.width+'px';box.style.height=r.height+'px';}
function fit(el,box){if(!box||!el)return;place(box,el.getBoundingClientRect());}
function fitRect(box,rect){if(!box||!rect)return;box.style.display='block';box.style.left=rect.x+'px';box.style.top=rect.y+'px';box.style.width=rect.w+'px';box.style.height=rect.h+'px';}
function refreshSelected(){if(selectedEl)fit(selectedEl,selectedBox);}
function move(e){if(!on)return;fit(e.target,hoverBox);}
function click(e){if(!on)return;e.preventDefault();e.stopPropagation();var el=e.target;var r=el.getBoundingClientRect();selectedEl=el;fit(el,selectedBox);if(hoverBox)hoverBox.style.display='none';pinned=true;on=false;parent.postMessage({source:'dezin',type:'selected',selector:path(el),tag:el.tagName.toLowerCase(),text:(el.textContent||'').replace(/\\s+/g,' ').trim().slice(0,90),rect:{x:Math.round(r.left),y:Math.round(r.top),w:Math.round(r.width),h:Math.round(r.height)},styles:styles(el),attrs:attrs(el)},'*');}
function mode(v){on=v;if(v)pinned=false;if(hoverBox)hoverBox.style.display='none';try{document.body.style.cursor=v?'crosshair':'';}catch(_){}}
function clearMark(){pinned=false;selectedEl=null;if(hoverBox)hoverBox.style.display='none';if(selectedBox)selectedBox.style.display='none';try{document.body.style.cursor='';}catch(_){}}
function focusTarget(selector,rect){var el=null;try{if(selector)el=document.querySelector(selector);}catch(_){}if(el){try{el.scrollIntoView({behavior:'smooth',block:'center',inline:'center'});}catch(_){try{el.scrollIntoView();}catch(__){}}selectedEl=el;fit(el,selectedBox);window.setTimeout(refreshSelected,80);pinned=true;on=false;if(hoverBox)hoverBox.style.display='none';return;}if(rect&&selectedBox){selectedEl=null;fitRect(selectedBox,rect);pinned=true;on=false;if(hoverBox)hoverBox.style.display='none';}}
function init(){mkbox();document.addEventListener('mousemove',move,true);document.addEventListener('click',click,true);document.addEventListener('scroll',refreshSelected,true);window.addEventListener('resize',refreshSelected);document.addEventListener('keydown',function(e){if((on||pinned||selectedEl)&&e.key==='Escape'){parent.postMessage({source:'dezin',type:'cancel'},'*');mode(false);clearMark();}},true);window.addEventListener('message',function(e){var d=e.data;if(!d||d.source!=='dezin-parent')return;if(d.type==='select-mode')mode(!!d.on);else if(d.type==='clear')clearMark();else if(d.type==='focus-target')focusTarget(d.selector,d.rect);});}
if(document.body)init();else document.addEventListener('DOMContentLoaded',init);
})();</script>`;

function dezinPicker() {
  return {
    name: "dezin-picker",
    apply: "serve",
    transformIndexHtml(html) {
      return html.includes("</body>") ? html.replace("</body>", PICKER_BRIDGE + "</body>") : html + PICKER_BRIDGE;
    },
  };
}

export default defineConfig({
  plugins: [react(), dezinPicker()],
  server: { host: "127.0.0.1", allowedHosts: true },
});
