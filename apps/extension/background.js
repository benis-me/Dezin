// Dezin Capture — background service worker. Fetches captured media (host_permissions
// let it read cross-origin image CDNs without canvas tainting) and hands it to the local
// Dezin daemon. The running Dezin app (desktop or web) picks the capture up in its home
// composer; the worker does not open a browser tab.

const DEFAULT_URL = "http://127.0.0.1:7457"; // the installed desktop app's daemon (the dev daemon uses the same port)

async function dezinUrl() {
  const { dezinUrl } = await chrome.storage.sync.get("dezinUrl");
  return (dezinUrl || DEFAULT_URL).replace(/\/+$/, "");
}

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
        const base = await dezinUrl();
        const r = await fetch(`${base}/api/analyze-image`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ image: msg.image, source: msg.source || "extension" }),
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok || !data.brief) throw new Error(data.error || `analyze ${r.status}`);
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
      const base = await dezinUrl();
      const r = await fetch(`${base}/api/capture`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ images, note: msg.note || "", source: msg.source || "extension" }),
      });
      if (!r.ok) throw new Error(`Dezin daemon returned ${r.status} — is the Dezin app running at ${base}?`);
      sendResponse({ ok: true });
    } catch (e) {
      const m = String(e && e.message ? e.message : e);
      sendResponse({ ok: false, error: /Failed to fetch/i.test(m) ? "Couldn't reach Dezin. Open the Dezin app, then try again." : m });
    }
  })();
  return true; // keep the channel open for the async response
});
