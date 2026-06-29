// Dezin Capture — content script. Adds a hover "Capture" button to large images/videos
// on Pinterest / Behance / Dribbble, opens a panel to preview and (for video) extract
// frames, then hands the references to Dezin via the background worker.

(function () {
  if (window.__dezinCapture) return;
  window.__dezinCapture = true;

  const SITE = location.hostname.includes("pinterest")
    ? "Pinterest"
    : location.hostname.includes("behance")
      ? "Behance"
      : "Dribbble";

  // ── hover capture button ──────────────────────────────────────────────────
  const btn = document.createElement("button");
  btn.className = "dezin-capture-btn";
  btn.type = "button";
  btn.textContent = "✦ Capture";
  btn.style.display = "none";
  document.documentElement.appendChild(btn);
  let target = null;

  const place = (media) => {
    const r = media.getBoundingClientRect();
    if (r.width < 180 || r.height < 130) return hide();
    target = media;
    btn.style.display = "block";
    btn.style.top = `${Math.max(8, r.top + 10)}px`;
    btn.style.left = `${r.left + 10}px`;
  };
  const hide = () => {
    btn.style.display = "none";
    target = null;
  };

  document.addEventListener(
    "mouseover",
    (e) => {
      const media = e.target.closest && e.target.closest("img, video");
      if (media) place(media);
    },
    true,
  );
  window.addEventListener("scroll", hide, true);

  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (target) void openPanel(target);
  });

  // ── media capture ─────────────────────────────────────────────────────────
  const bestSrc = (img) => img.currentSrc || img.src || "";
  const nameFromUrl = (url) => {
    try {
      const p = new URL(url).pathname.split("/").pop() || "capture";
      return /\.(png|jpe?g|webp|gif)$/i.test(p) ? p : `${p}.png`;
    } catch {
      return "capture.png";
    }
  };

  const seekTo = (video, t) =>
    new Promise((resolve, reject) => {
      const cleanup = () => {
        video.removeEventListener("seeked", onOk);
        video.removeEventListener("error", onErr);
        clearTimeout(to);
      };
      const onOk = () => (cleanup(), resolve());
      const onErr = () => (cleanup(), reject(new Error("seek failed")));
      const to = setTimeout(() => (cleanup(), reject(new Error("seek timeout"))), 3000);
      video.addEventListener("seeked", onOk);
      video.addEventListener("error", onErr);
      try {
        video.currentTime = t;
      } catch (e) {
        cleanup();
        reject(e);
      }
    });

  async function captureVideo(video) {
    const dur = isFinite(video.duration) ? video.duration : 0;
    const w = video.videoWidth || 640;
    const h = video.videoHeight || 360;
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    const count = 4;
    const was = video.currentTime;
    const paused = video.paused;
    try {
      video.pause();
    } catch {}
    const frames = [];
    for (let i = 0; i < count; i++) {
      try {
        await seekTo(video, dur ? (dur * (i + 0.5)) / count : 0);
        ctx.drawImage(video, 0, 0, w, h);
        const data = canvas.toDataURL("image/png"); // throws if the frame is cross-origin tainted
        frames.push({ base64: data.split(",")[1], name: `frame-${i + 1}.png`, preview: data });
      } catch {
        break;
      }
    }
    try {
      video.currentTime = was;
      if (!paused) void video.play();
    } catch {}
    if (frames.length) return frames;
    if (video.poster) return [{ url: video.poster, name: "poster.png", preview: video.poster }];
    throw new Error("Couldn't read this video (cross-origin). Capture a still image instead.");
  }

  // ── panel (shadow DOM) ────────────────────────────────────────────────────
  let ui = null;
  function ensurePanel() {
    if (ui) return ui;
    const hostEl = document.createElement("div");
    hostEl.style.cssText = "all:initial;position:fixed;z-index:2147483647;right:20px;bottom:20px;";
    document.documentElement.appendChild(hostEl);
    const root = hostEl.attachShadow({ mode: "open" });
    root.innerHTML = `
      <style>
        * { box-sizing: border-box; font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; }
        .card { width: 320px; background: #fff; color: #18181b; border: 1px solid #e4e4e7; border-radius: 14px; box-shadow: 0 12px 40px -12px rgba(0,0,0,.3); overflow: hidden; }
        .hd { display:flex; align-items:center; gap:8px; padding:10px 12px; border-bottom:1px solid #f0f0f1; }
        .hd b { font-size:13px; font-weight:600; flex:1; }
        .hd .src { font-size:11px; color:#71717a; }
        .x { border:0; background:transparent; cursor:pointer; color:#71717a; font-size:16px; line-height:1; padding:2px 4px; }
        .bd { padding:12px; }
        .row { display:flex; gap:6px; flex-wrap:wrap; }
        .thumb { position:relative; width:64px; height:64px; border-radius:8px; overflow:hidden; border:2px solid transparent; cursor:pointer; background:#f4f4f5; }
        .thumb img { width:100%; height:100%; object-fit:cover; display:block; }
        .thumb[data-on="1"] { border-color:#18181b; }
        .thumb .chk { position:absolute; top:2px; right:2px; width:14px; height:14px; border-radius:50%; background:#18181b; color:#fff; font-size:9px; display:none; align-items:center; justify-content:center; }
        .thumb[data-on="1"] .chk { display:flex; }
        .plan { margin:10px 0 8px; font-size:12px; color:#52525b; line-height:1.5; }
        textarea { width:100%; min-height:46px; resize:vertical; border:1px solid #e4e4e7; border-radius:8px; padding:7px 9px; font-size:12px; outline:none; }
        textarea:focus { border-color:#a1a1aa; }
        .btn { width:100%; margin-top:10px; border:0; border-radius:9px; background:#18181b; color:#fff; padding:9px; font-size:13px; font-weight:600; cursor:pointer; }
        .btn:disabled { opacity:.5; cursor:default; }
        .muted { font-size:12px; color:#71717a; }
        .err { font-size:12px; color:#dc2626; line-height:1.5; }
        .spin { display:inline-block; width:14px; height:14px; border:2px solid #d4d4d8; border-top-color:#18181b; border-radius:50%; animation:s .7s linear infinite; vertical-align:-2px; margin-right:6px; }
        @keyframes s { to { transform: rotate(360deg); } }
      </style>
      <div class="card">
        <div class="hd"><b>Capture to Dezin</b><span class="src">${SITE}</span><button class="x" title="Close">✕</button></div>
        <div class="bd"></div>
      </div>`;
    const body = root.querySelector(".bd");
    root.querySelector(".x").addEventListener("click", () => (hostEl.style.display = "none"));

    let images = [];
    let note = "";

    const api = {
      show: () => (hostEl.style.display = "block"),
      setState(state) {
        if (state === "capturing") body.innerHTML = `<p class="muted"><span class="spin"></span>Capturing…</p>`;
        if (state === "importing") body.innerHTML = `<p class="muted"><span class="spin"></span>Sending to Dezin…</p>`;
        if (state === "done") body.innerHTML = `<p class="muted">Opened in Dezin ✓ — the reference is in the composer.</p>`;
      },
      setError(msg) {
        body.innerHTML = `<p class="err">${msg}</p>`;
      },
      setImages(imgs) {
        images = imgs.map((im) => ({ ...im, on: true }));
        render();
      },
    };

    function render() {
      const plan = `Dezin will recreate this ${SITE} ${images.length > 1 ? "sequence" : "design"} — matching layout, type, colour, and spacing.`;
      body.innerHTML = `
        <div class="row"></div>
        <p class="plan">${plan}</p>
        <textarea placeholder="Add a note (optional) — e.g. 'make it a pricing page'"></textarea>
        <button class="btn">Import to Dezin →</button>`;
      const row = body.querySelector(".row");
      images.forEach((im, i) => {
        const t = document.createElement("div");
        t.className = "thumb";
        t.dataset.on = im.on ? "1" : "0";
        t.innerHTML = `<img src="${im.preview}" alt=""><span class="chk">✓</span>`;
        t.addEventListener("click", () => {
          images[i].on = !images[i].on;
          t.dataset.on = images[i].on ? "1" : "0";
        });
        row.appendChild(t);
      });
      const ta = body.querySelector("textarea");
      ta.addEventListener("input", () => (note = ta.value));
      body.querySelector(".btn").addEventListener("click", () => doImport());
    }

    function doImport() {
      const picked = images.filter((im) => im.on);
      if (!picked.length) return;
      api.setState("importing");
      chrome.runtime.sendMessage(
        {
          type: "dezin-import",
          source: SITE,
          note,
          images: picked.map((im) => (im.base64 ? { base64: im.base64, name: im.name } : { url: im.url, name: im.name })),
        },
        (resp) => {
          if (chrome.runtime.lastError) return api.setError(chrome.runtime.lastError.message);
          if (resp && resp.ok) api.setState("done");
          else api.setError((resp && resp.error) || "Import failed. Is Dezin running?");
        },
      );
    }

    ui = api;
    return ui;
  }

  async function openPanel(media) {
    hide();
    const panel = ensurePanel();
    panel.show();
    panel.setState("capturing");
    try {
      const imgs = media.tagName === "VIDEO" ? await captureVideo(media) : [{ url: bestSrc(media), name: nameFromUrl(bestSrc(media)), preview: bestSrc(media) }];
      if (!imgs.length || (!imgs[0].url && !imgs[0].base64)) throw new Error("Nothing to capture here.");
      panel.setImages(imgs);
    } catch (err) {
      panel.setError(String(err && err.message ? err.message : err));
    }
  }
})();
