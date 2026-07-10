// Dezin Capture — background service worker. Fetches captured media (host_permissions
// let it read cross-origin image CDNs without canvas tainting) and hands it to the local
// Dezin daemon. The running Dezin app (desktop or web) picks the capture up in its home
// composer; the worker does not open a browser tab.

import { analyze, capture } from "./dezin-client.js";

function bytesToBase64(bytes) {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

async function urlToBase64(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${res.status}`);
  const buf = await res.arrayBuffer();
  return bytesToBase64(new Uint8Array(buf));
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // Fetch cross-origin media to base64 so the content script can decode it into a
  // same-origin (data:) image and read its pixels without tainting a canvas.
  if (msg?.type === "dezin-fetch") {
    (async () => {
      try {
        sendResponse({ ok: true, base64: await urlToBase64(msg.url) });
      } catch (e) {
        sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
      }
    })();
    return true;
  }
  // Run the configured agent's fast model on a captured image to generate a brief.
  if (msg?.type === "dezin-analyze") {
    (async () => {
      try {
        const data = await analyze({ image: msg.image, source: msg.source || "extension" });
        if (!data.brief) throw new Error("Dezin returned no analysis brief");
        sendResponse({ ok: true, brief: data.brief, agent: data.agent });
      } catch (e) {
        const m = String(e && e.message ? e.message : e);
        sendResponse({ ok: false, error: /Failed to fetch/i.test(m) ? "Couldn't reach Dezin to analyze." : m });
      }
    })();
    return true;
  }
  if (msg?.type !== "dezin-import") return;
  (async () => {
    try {
      const images = [];
      for (const item of msg.images || []) {
        if (item.base64) images.push({ name: item.name || "capture.png", base64: item.base64 });
        else if (item.url) images.push({ name: item.name || "capture.png", base64: await urlToBase64(item.url) });
      }
      if (!images.length) throw new Error("no images");
      await capture({ images, note: msg.note || "", source: msg.source || "extension" });
      sendResponse({ ok: true });
    } catch (e) {
      const m = String(e && e.message ? e.message : e);
      sendResponse({ ok: false, error: /Failed to fetch/i.test(m) ? "Couldn't reach Dezin. Open the Dezin app, then try again." : m });
    }
  })();
  return true; // keep the channel open for the async response
});
