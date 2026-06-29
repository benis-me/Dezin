// Dezin Capture — content script. Adds a hover "Capture" button to large images/videos
// on Pinterest / Behance / Dribbble. Clicking opens a panel where you Analyze the media
// (images become a reference; videos are sampled into frames at a fixed rate), review the
// generated recreation brief, and Import it into the Dezin app's composer.

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
    if (target) openPanel(target);
  });

  // ── media helpers ─────────────────────────────────────────────────────────
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

  // Sample a video into frames at a fixed cadence (~1 frame / 1.4s, 2–8 frames).
  async function captureVideoFrames(video, onProgress) {
    const dur = isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
    const w = video.videoWidth || 640;
    const h = video.videoHeight || 360;
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    const count = dur ? Math.min(8, Math.max(2, Math.round(dur / 1.4))) : 1;
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
        onProgress && onProgress(i + 1, count);
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
    throw new Error("Couldn't read this video (cross-origin protected). Try a still image instead.");
  }

  const briefFor = (isVideo, frameCount) =>
    isVideo
      ? `Recreate this ${SITE} UI from the ${frameCount} sampled frame${frameCount === 1 ? "" : "s"} as a responsive web page — match its layout, typography, colour, spacing, components, and the motion/interaction the frames imply.`
      : `Recreate this ${SITE} design faithfully as a responsive web page — match its layout, typography, colour, spacing, and components.`;

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
        .card { width: 332px; background: #fff; color: #18181b; border: 1px solid #e4e4e7; border-radius: 14px; box-shadow: 0 16px 48px -16px rgba(0,0,0,.35); overflow: hidden; }
        .hd { display:flex; align-items:center; gap:8px; padding:10px 12px; border-bottom:1px solid #f0f0f1; }
        .hd b { font-size:13px; font-weight:600; flex:1; }
        .hd .src { font-size:11px; color:#71717a; }
        .x { border:0; background:transparent; cursor:pointer; color:#71717a; font-size:16px; line-height:1; padding:2px 4px; border-radius:6px; }
        .x:hover { background:#f4f4f5; color:#18181b; }
        .bd { padding:12px; }
        .preview { width:100%; height:150px; border-radius:9px; overflow:hidden; border:1px solid #e4e4e7; background:#f4f4f5; display:flex; align-items:center; justify-content:center; }
        .preview img { width:100%; height:100%; object-fit:cover; display:block; }
        .kind { display:flex; align-items:center; gap:6px; margin:9px 0 0; font-size:12px; color:#52525b; }
        .kind .dot { width:6px; height:6px; border-radius:50%; background:#18181b; }
        .row { display:flex; gap:6px; flex-wrap:wrap; }
        .thumb { position:relative; width:62px; height:62px; border-radius:8px; overflow:hidden; border:2px solid transparent; cursor:pointer; background:#f4f4f5; }
        .thumb img { width:100%; height:100%; object-fit:cover; display:block; }
        .thumb[data-on="1"] { border-color:#18181b; }
        .thumb .chk { position:absolute; top:2px; right:2px; width:14px; height:14px; border-radius:50%; background:#18181b; color:#fff; font-size:9px; display:none; align-items:center; justify-content:center; }
        .thumb[data-on="1"] .chk { display:flex; }
        .lbl { font-size:11px; font-weight:600; color:#52525b; margin:11px 0 5px; }
        textarea { width:100%; min-height:64px; resize:vertical; border:1px solid #e4e4e7; border-radius:9px; padding:8px 10px; font-size:12px; line-height:1.5; outline:none; color:#18181b; }
        textarea:focus { border-color:#a1a1aa; }
        .btn { width:100%; margin-top:11px; border:0; border-radius:10px; background:#18181b; color:#fff; padding:10px; font-size:13px; font-weight:600; cursor:pointer; display:flex; align-items:center; justify-content:center; gap:6px; }
        .btn:hover { background:#000; }
        .btn:active { transform: translateY(1px); }
        .btn:disabled { opacity:.5; cursor:default; transform:none; }
        .btn.ghost { background:#fff; color:#18181b; border:1px solid #e4e4e7; margin-top:7px; }
        .btn.ghost:hover { background:#f4f4f5; }
        .muted { font-size:12px; color:#71717a; line-height:1.5; margin:0; }
        .center { text-align:center; padding:22px 8px; }
        .err { font-size:12px; color:#dc2626; line-height:1.5; margin:0 0 4px; }
        .spin { display:inline-block; width:15px; height:15px; border:2px solid #d4d4d8; border-top-color:#18181b; border-radius:50%; animation:s .7s linear infinite; vertical-align:-3px; }
        .big { width:26px; height:26px; border-width:3px; margin-bottom:10px; }
        .ok { width:30px; height:30px; border-radius:50%; background:#16a34a; color:#fff; display:inline-flex; align-items:center; justify-content:center; font-size:16px; margin-bottom:10px; }
        @keyframes s { to { transform: rotate(360deg); } }
      </style>
      <div class="card">
        <div class="hd"><b>Capture to Dezin</b><span class="src">${SITE}</span><button class="x" title="Close">✕</button></div>
        <div class="bd"></div>
      </div>`;
    const body = root.querySelector(".bd");
    root.querySelector(".x").addEventListener("click", () => (hostEl.style.display = "none"));

    let refs = []; // [{base64?|url, name, preview, on}]
    let brief = "";

    const api = {
      show: () => (hostEl.style.display = "block"),

      // Stage 1 — preview + Analyze
      ready({ isVideo, previewSrc, media }) {
        refs = [];
        body.innerHTML = `
          <div class="preview">${previewSrc ? `<img src="${previewSrc}" alt="">` : `<span class="muted">${isVideo ? "Video" : "Image"}</span>`}</div>
          <p class="kind"><span class="dot"></span>${isVideo ? "Video — frames will be sampled at a fixed rate" : "Image — used as a design reference"}</p>
          <button class="btn">✦ Analyze</button>`;
        body.querySelector(".btn").addEventListener("click", () => api.analyze({ isVideo, previewSrc, media }));
      },

      // Stage 2 — analyzing (loading)
      async analyze({ isVideo, previewSrc, media }) {
        body.innerHTML = `<div class="center"><span class="spin big"></span><p class="muted">${isVideo ? "Sampling frames…" : "Reading the design…"}</p></div>`;
        const progress = body.querySelector(".muted");
        try {
          if (isVideo) {
            const frames = await captureVideoFrames(media, (n, total) => (progress.textContent = `Sampling frames… ${n}/${total}`));
            refs = frames.map((f) => ({ ...f, on: true }));
          } else {
            const src = previewSrc || bestSrc(media);
            if (!src) throw new Error("Nothing to capture here.");
            refs = [{ url: src, name: nameFromUrl(src), preview: src, on: true }];
          }
          if (!refs.length) throw new Error("Nothing to analyze here.");
          brief = briefFor(isVideo, refs.length);
          api.result();
        } catch (err) {
          api.error(String(err && err.message ? err.message : err), () => api.ready({ isVideo, previewSrc, media }));
        }
      },

      // Stage 3 — recreation plan + Import
      result() {
        body.innerHTML = `
          <div class="lbl">Reference${refs.length > 1 ? "s" : ""} (${refs.length})</div>
          <div class="row"></div>
          <div class="lbl">Recreation brief</div>
          <textarea spellcheck="false"></textarea>
          <button class="btn">Import to Dezin →</button>`;
        const row = body.querySelector(".row");
        refs.forEach((im, i) => {
          const t = document.createElement("div");
          t.className = "thumb";
          t.dataset.on = im.on ? "1" : "0";
          t.innerHTML = `<img src="${im.preview}" alt=""><span class="chk">✓</span>`;
          t.addEventListener("click", () => {
            refs[i].on = !refs[i].on;
            t.dataset.on = refs[i].on ? "1" : "0";
          });
          row.appendChild(t);
        });
        const ta = body.querySelector("textarea");
        ta.value = brief;
        ta.addEventListener("input", () => (brief = ta.value));
        body.querySelector(".btn").addEventListener("click", () => api.doImport());
      },

      doImport() {
        const picked = refs.filter((im) => im.on);
        if (!picked.length) return;
        body.innerHTML = `<div class="center"><span class="spin big"></span><p class="muted">Importing to Dezin…</p></div>`;
        chrome.runtime.sendMessage(
          {
            type: "dezin-import",
            source: SITE,
            note: brief,
            images: picked.map((im) => (im.base64 ? { base64: im.base64, name: im.name } : { url: im.url, name: im.name })),
          },
          (resp) => {
            if (chrome.runtime.lastError) return api.error(chrome.runtime.lastError.message, () => api.result());
            if (resp && resp.ok) api.done();
            else api.error((resp && resp.error) || "Import failed. Is the Dezin app running?", () => api.result());
          },
        );
      },

      done() {
        body.innerHTML = `
          <div class="center">
            <div class="ok">✓</div>
            <p class="muted"><b>Imported to Dezin.</b><br>Open the Dezin app — the reference and brief are waiting in the composer.</p>
          </div>
          <button class="btn ghost">Done</button>`;
        body.querySelector(".btn").addEventListener("click", () => (hostEl.style.display = "none"));
      },

      error(msg, onBack) {
        body.innerHTML = `<p class="err">${msg}</p><button class="btn ghost">Back</button>`;
        body.querySelector(".btn").addEventListener("click", () => (onBack ? onBack() : (hostEl.style.display = "none")));
      },
    };

    ui = api;
    return ui;
  }

  function openPanel(media) {
    hide();
    const panel = ensurePanel();
    panel.show();
    const isVideo = media.tagName === "VIDEO";
    panel.ready({ isVideo, previewSrc: isVideo ? media.poster || "" : bestSrc(media), media });
  }
})();
