#!/usr/bin/env node
// dezin-probe — a dedicated CLI the Sharingan build Agent uses to drive the capture browser and read
// the captured bundle, INSTEAD of hand-writing curl/python. `BASE` is baked in when this file is
// copied into a project's .sharingan/ ; the daemon token comes from the environment. Run as:
//   node .sharingan/probe.mjs <command> [args]
import { readFileSync } from "node:fs";
import { join } from "node:path";

const BASE = "__BASE__";
const TOKEN = process.env.DEZIN_DAEMON_TOKEN || "";

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

async function api(method, endpoint, body) {
  const res = await fetch(BASE + endpoint, {
    method,
    headers: {
      "x-dezin-daemon-token": TOKEN,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed };
}

function print(result) {
  console.log(typeof result.body === "string" ? result.body : JSON.stringify(result.body, null, 2));
}

// Condense a captured nested dom.json into a compact indented tree, so the Agent reads THIS instead
// of loading + regexing the raw (often hundreds-of-KB) dom.json.
function shortColor(c) {
  return String(c || "").replace(/\s+/g, ""); // "rgb(0, 0, 0)" -> "rgb(0,0,0)"
}

// Compact per-node style summary so `outline` is a SUFFICIENT blueprint — the agent shouldn't need to
// open the raw dom.json. Defaults/inherited values are skipped to keep each line terse.
function styleSummary(s) {
  if (!s) return "";
  const p = [];
  if (s.display === "flex") p.push(s.flexDirection === "column" ? "flex-col" : "flex-row");
  else if (s.display === "grid") p.push("grid");
  else if (s.display === "none") p.push("hidden");
  if (s.display === "flex" || s.display === "grid") {
    if (s.gap && s.gap !== "normal" && s.gap !== "0px") p.push("gap:" + s.gap);
    if (s.justifyContent && s.justifyContent !== "normal") p.push("jc:" + s.justifyContent);
    if (s.alignItems && s.alignItems !== "normal") p.push("ai:" + s.alignItems);
  }
  if (s.backgroundColor && !/rgba\(0,\s*0,\s*0,\s*0\)|transparent/.test(s.backgroundColor)) p.push("bg:" + shortColor(s.backgroundColor));
  if (s.backgroundImage && s.backgroundImage !== "none") p.push("bg-img");
  if (s.color) p.push("fg:" + shortColor(s.color));
  if (s.fontSize && s.fontSize !== "16px") p.push("fs:" + s.fontSize + (s.fontWeight && s.fontWeight !== "400" ? "/" + s.fontWeight : ""));
  else if (s.fontWeight && s.fontWeight !== "400") p.push("fw:" + s.fontWeight);
  if (s.padding && s.padding !== "0px") p.push("p:" + s.padding);
  if (s.border && !/^0px/.test(s.border) && !/rgba\(0,\s*0,\s*0,\s*0\)/.test(s.border)) p.push("bd:" + shortColor(s.border));
  if (s.textAlign && s.textAlign !== "start" && s.textAlign !== "left") p.push("ta:" + s.textAlign);
  return p.length ? " {" + p.join(" ") + "}" : "";
}

function outline(domPathArg) {
  let domPath = domPathArg;
  if (!domPath) {
    const manifest = JSON.parse(readFileSync(join(".sharingan", "pages.json"), "utf8"));
    domPath = manifest.pages && manifest.pages[0] && manifest.pages[0].dom;
    if (!domPath) fail("no captured page in .sharingan/pages.json");
  }
  const root = JSON.parse(readFileSync(domPath, "utf8"));
  const roots = Array.isArray(root) ? root : [root];
  const MAX = 500;
  const lines = [];
  const walk = (node, depth) => {
    if (lines.length >= MAX || !node) return;
    const cls = node.classes ? "." + String(node.classes).trim().split(/\s+/).slice(0, 2).join(".") : "";
    const box = node.box ? ` [${Math.round(node.box.w)}x${Math.round(node.box.h)}]` : "";
    const txt = node.text ? ` "${String(node.text).replace(/\s+/g, " ").trim().slice(0, 48)}"` : "";
    lines.push("  ".repeat(depth) + (node.tag || "?") + cls + box + styleSummary(node.style) + txt);
    for (const child of node.children || []) walk(child, depth + 1);
  };
  for (const r of roots) walk(r, 0);
  console.log(lines.join("\n"));
  if (lines.length >= MAX) console.log(`… truncated at ${MAX} nodes — read ${domPath} for the full tree`);
}

const HELP = `dezin-probe — drive the Sharingan capture browser + read the capture (no curl/python needed).
Usage: node .sharingan/probe.mjs <command> [args]

  navigate <url>        open a URL in the live capture browser
  read-dom              visible DOM nodes (tag/role/text/box) as JSON
  styles                computed style tokens (colors / fonts / radii / shadows)
  links                 same-origin links discovered on the current page
  click <selector>      click an element
  scroll <y>            scroll to a Y offset (px)
  capture [url]         capture the current (or given) page into .sharingan/
  outline [dom.json]    condensed indented tree of a captured page — READ THIS instead of parsing dom.json`;

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === "outline") return outline(args[0]);
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") return void console.log(HELP);
  if (!BASE || BASE === "__BASE__" || !TOKEN) fail("dezin-probe: not in a Sharingan run (base/token missing).");
  switch (cmd) {
    case "navigate":
      if (!args[0]) fail("usage: navigate <url>");
      print(await api("POST", "/navigate", { url: args[0] }));
      break;
    case "read-dom":
      print(await api("GET", "/read-dom"));
      break;
    case "styles":
    case "computed-styles":
      print(await api("GET", "/computed-styles"));
      break;
    case "links":
      print(await api("GET", "/links"));
      break;
    case "click":
      if (!args[0]) fail("usage: click <selector>");
      print(await api("POST", "/click", { selector: args[0] }));
      break;
    case "scroll": {
      const y = Number(args[0]);
      if (!Number.isFinite(y)) fail("usage: scroll <y-offset-number>");
      print(await api("POST", "/scroll", { y }));
      break;
    }
    case "capture":
      if (args[0] && !/^https?:\/\//i.test(args[0])) fail("capture: url must start with http(s):// (or omit it to capture the current page)");
      print(await api("POST", "/capture", args[0] ? { url: args[0] } : undefined));
      break;
    default:
      fail(`unknown command: ${cmd}\n\n${HELP}`);
  }
}

main().catch((e) => fail("dezin-probe error: " + (e && e.message ? e.message : e)));
