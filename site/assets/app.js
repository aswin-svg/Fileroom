
"use strict";

const assetMeta = document.querySelector('meta[name="fileroom-assets"]');
const hostedAssets = assetMeta ? new URL(assetMeta.content, location.href) : null;
const assetUrl = (name, fallback) => hostedAssets ? new URL(name, hostedAssets).href : fallback;
const NETWORK_WARNING = "A required Fileroom library could not load. Reopen the complete HTML or reload the hosted page.";
const dependencyAlert = document.getElementById("dependency-alert");
const vendorBytes = key => Uint8Array.from(atob(document.getElementById("vendor-" + key).textContent), c => c.charCodeAt(0));

function loadVerifiedScript(url, integrity, key, timeout = 2500) {
  return new Promise(resolve => {
    const script = document.createElement("script");
    const settle = () => {
      clearTimeout(timer);
      script.onload = script.onerror = null;
      script.remove();
      resolve(Boolean(window[key]));
    };
    const timer = setTimeout(settle, timeout);
    script.src = url;
    script.integrity = integrity;
    script.crossOrigin = "anonymous";
    script.onload = script.onerror = settle;
    document.head.append(script);
  });
}

const vendorResources = {"PDFLib": ["vendor/pdf-lib.min.js?v=0f9a5cad0794", "sha384-weMABwrltA6jWR8DDe9Jp5blk+tZQh7ugpCsF3JwSA53WZM9/14PjS5LAJNHNjAI"], "JSZip": ["vendor/jszip.min.js?v=acc7e41455a8", "sha384-+mbV2IY1Zk/X1p/nWllGySJSUN8uMs+gUAN10Or95UBH0fpj6GfKgPmgC5EXieXG"], "pdfjsLib": ["vendor/pdf.min.js?v=5b5799e6f8c6", "sha384-/1qUCSGwTur9vjf/z9lmu/eCUYbpOTgSjmpbMQZ1/CtX2v/WcAIKqRv+U1DUCG6e"]};
const pendingLibraries = new Map();

function libraryReady(key) {
  if (window[key]) return Promise.resolve(true);
  if (!hostedAssets) return Promise.resolve(false);
  if (!pendingLibraries.has(key)) {
    const [url, integrity] = vendorResources[key];
    pendingLibraries.set(key, loadVerifiedScript(assetUrl(url), integrity, key, 15000)
      .finally(() => pendingLibraries.delete(key)));
  }
  return pendingLibraries.get(key);
}

if (!hostedAssets && Object.keys(vendorResources).some(key => !window[key])) {
  dependencyAlert.textContent = NETWORK_WARNING;
  dependencyAlert.hidden = false;
}

async function requireLibrary(key) {
  if (await libraryReady(key)) {
    dependencyAlert.hidden = true;
    return;
  }
  dependencyAlert.textContent = NETWORK_WARNING;
  dependencyAlert.hidden = false;
  throw new Error(NETWORK_WARNING);
}

/* =====================================================================
   1. HELPERS
   ===================================================================== */
const fmt = n => n < 1024 ? n + " B" : n < 1048576 ? (n / 1024).toFixed(1) + " KB" : (n / 1048576).toFixed(2) + " MB";

// Tiny element builder: h("div", {class:"x", onclick:fn}, child, "text")
const h = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  kids.flat().forEach(c => e.append(c));
  return e;
};

// Does a file match an accept string like ".pdf,image/*"?
const PDF_ACCEPT = ".pdf,application/pdf";
const isPdfFile = f => matches(f, PDF_ACCEPT);

const matches = (f, accept) => accept.split(",").some(a => {
  a = a.trim().toLowerCase();
  if (a.startsWith(".")) return f.name.toLowerCase().endsWith(a);
  if (a.endsWith("/*")) return f.type.startsWith(a.slice(0, -1));
  return f.type === a;
});

/* =====================================================================
   2. SHARED UPLOADER (drop zone, file list, progress, clear, download)
   Every tool reuses this. A tool only supplies a config object:
   { id, accept, multiple, action, options(), process(files, onProgress) }
   process() must resolve to { blob, filename }.
   ===================================================================== */
const uploaderInputs = new Map();
const fileLimit = file => (isPdfFile(file) ? 50 : 25) * 1024 * 1024;

function createUploader(cfg) {
  let files = [], result = null, busy = false;

  const input  = h("input", { type: "file", accept: cfg.accept, class: "sr", id: "f-" + cfg.id });
  if (cfg.multiple) input.multiple = true;
  const fileTypes = cfg.accept.includes(PDF_ACCEPT)
    ? (cfg.accept.includes(IMG_ACCEPT) ? "PDF up to 50 MB · JPG, PNG or WebP up to 25 MB" : "PDF up to 50 MB")
    : "JPG, PNG or WebP up to 25 MB";
  const zone   = h("label", { class: "zone", for: "f-" + cfg.id },
    iconEl(cfg.id),
    h("strong", {}, cfg.multiple ? "Choose or drop files" : "Choose or drop a file"),
    h("span", {}, fileTypes));
  const list   = h("ul", { class: "files" });
  const bar    = h("span");
  const track  = h("div", { class: "bar", role: "progressbar", "aria-label": "Processing progress", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": "0", hidden: "" }, bar);
  const status = h("p", { class: "status" });
  const announce = h("p", { class: "sr", role: "status", "aria-atomic": "true" });
  const run    = h("button", { class: "btn run", type: "button" }, cfg.action);
  const clear  = h("button", { class: "btn", type: "button" }, "Clear files");
  const dl     = h("button", { class: "btn dl", type: "button" }, "Download result");
  const summary = h("p", { class: "summary result-summary" });
  const resultActions = h("div", { class: "result-actions", hidden: "" }, dl, summary);
  const optsEl = h("fieldset", { class: "opts" }, h("legend", {}, "Settings"),
    typeof cfg.options === "function" ? cfg.options() : cfg.options);
  optsEl.hidden = !cfg.options;

  const nextTool = h("select", { class: "field", "aria-label": "Next tool" });
  const sendResult = h("button", { class: "btn", type: "button" }, "Open tool");
  const workflow = h("div", { class: "result-workflow", hidden: "" },
    h("label", {}, "Use result in another tool ", nextTool), sendResult);
  let transferable = [];

  const extracted = h("textarea", { class: "field", readonly: "", rows: "10", "aria-label": "Extracted text" });
  const copy = h("button", { class: "btn", type: "button", onclick: async () => {
    if (!result?.text) return;
    if (await copyText(result.text)) toast("Text copied.");
    else {
      extracted.focus();
      extracted.select();
      toast("Automatic copy is unavailable. The text is selected.", "error");
    }
  } }, "Copy text");
  const textResult = h("div", { class: "text-result", hidden: "" }, extracted, copy);

  const alert = h("p", { class: "upload-alert", role: "alert", hidden: "" });
  const cutoutImage = cfg.id === "background-remover" ? h("img", { alt: "Image with its background removed" }) : null;
  let cutoutBefore, cutoutAfter;
  const compare = cutoutImage && h("button", { class: "mini", type: "button", "aria-pressed": "false", onclick: async () => {
    const original = compare.getAttribute("aria-pressed") !== "true";
    compare.setAttribute("aria-pressed", String(original));
    cutoutImage.alt = original ? "Original image" : "Image with its background removed";
    await previewImage(cutoutImage, original ? cutoutBefore : cutoutAfter).catch(() => {});
  } }, "Show original");
  const cutout = cutoutImage && h("figure", { class: "cutout-result", hidden: "" },
    cutoutImage, h("figcaption", {}, "Checkerboard areas are transparent in the downloaded PNG."), compare);
  const uploader = h("div", { class: "uploader" },
    input, zone, alert, list, optsEl, track, status,
    h("div", { class: "actions" }, run, clear), resultActions, ...(cutout ? [cutout] : []), textResult, workflow);

  function warn(message = "") {
    alert.textContent = message;
    alert.hidden = !message;
  }

  // Clear the result whenever the file list changes (reorder, remove).
  function touch() { result = null; warn(); setProgress(0); status.textContent = ""; delete status.dataset.state; render(); }

  // Up / Down / Remove buttons for one row (used when a tool sets reorder: true).
  const rowTools = i => {
    const btn = (label, aria, off, fn) => { const b = h("button", { class: "mini", type: "button", "aria-label": aria }, label); b.disabled = off; b.addEventListener("click", fn); return b; };
    const name = files[i].name;
    const move = offset => {
      const next = i + offset;
      [files[next], files[i]] = [files[i], files[next]];
      touch();
      list.children[next]?.querySelector("button:last-child")?.focus();
    };
    const order = cfg.reorder && files.length > 1 ? [
      btn("Up", "Move " + name + " up", busy || i === 0, () => move(-1)),
      btn("Down", "Move " + name + " down", busy || i === files.length - 1, () => move(1))
    ] : [];
    return h("span", { class: "row-tools" }, order,
      btn("Remove", "Remove " + name, busy, () => {
        files.splice(i, 1);
        touch();
        const next = list.children[Math.min(i, files.length - 1)]?.querySelector("button:last-child");
        (next || input).focus();
      }));
  };

  const setProgress = p => {
    bar.style.width = p + "%";
    track.setAttribute("aria-valuenow", p);
    status.textContent = p > 0 && p < 100 ? "Working… " + p + "%" : status.textContent;
  };

  let previewBlob;
  function render() {
    list.replaceChildren(...files.map((f, i) =>
      h("li", {}, h("span", { class: "name" }, f.name), h("span", { class: "size" }, result?.sizes?.[i] != null ? fmt(f.size) + " → " + fmt(result.sizes[i]) : fmt(f.size)), rowTools(i), ...(result?.targetNotes?.[i] ? [h("span", { class: "fine target-note" }, result.targetNotes[i])] : []))));
    uploader.setAttribute("aria-busy", String(busy));
    input.disabled = optsEl.disabled = busy;
    run.textContent = busy ? "Processing…" : cfg.action;
    run.disabled   = busy || !files.length;
    clear.disabled = busy || !files.length;
    dl.disabled    = busy || !result;
    resultActions.hidden = !result;
    track.hidden = !busy;
    summary.textContent = result && result.summary ? result.summary : "";
    dl.textContent = result && result.dlLabel ? result.dlLabel : "Download result";
    const parts = result?.parts || (result ? [{ blob: result.blob, name: result.filename }] : []);
    if (cutout) {
      const blob = parts[0]?.blob;
      if (blob !== previewBlob) {
        previewBlob = blob;
        cutoutAfter = blob;
        cutoutBefore = result?.previewOriginal;
        compare.hidden = !cutoutBefore;
        compare.setAttribute("aria-pressed", "false");
        cutoutImage.alt = "Image with its background removed";
        cutout.hidden = true;
        cutoutImage.removeAttribute("src");
        if (blob) {
          previewImage(cutoutImage, blob).then(() => {
            if (previewBlob === blob) cutout.hidden = false;
          }).catch(() => {});
        }
      }
    }
    transferable = parts.map(({ blob, name }) => new File([blob], name, { type: blob.type }));
    const destinations = TOOLS.filter(tool =>
      tool.id !== cfg.id && transferable.length > 0 && (tool.multiple || transferable.length === 1) &&
      transferable.every(file => matches(file, tool.accept) && file.size <= fileLimit(file)));
    textResult.hidden = busy || !result?.text;
    extracted.value = result?.text || "";
    workflow.hidden = busy || !destinations.length;
    nextTool.replaceChildren(...destinations.map(tool => opt(tool.id, tool.title)));
    if (!busy && cfg.onFiles) cfg.onFiles(files);
  }

  function addFiles(fileList) {
    if (busy) return false;
    const all = [...fileList];
    if (!all.length) return false;
    const ok = [], messages = [];
    for (const file of all) {
      if (!file.size) messages.push(file.name + " is empty.");
      else if (!matches(file, cfg.accept)) messages.push(file.name + " is an unsupported file type.");
      else if (file.size > fileLimit(file)) messages.push(file.name + " exceeds the " + (isPdfFile(file) ? "50 MB PDF" : "25 MB image") + " limit.");
      else ok.push(file);
    }
    if (!cfg.multiple && ok.length > 1) messages.push("Only " + ok[0].name + " was added. This tool uses one file at a time.");
    warn(messages.join(" "));
    if (!ok.length) return false;
    result = null; setProgress(0);
    status.textContent = "";
    delete status.dataset.state;
    files = cfg.multiple ? files.concat(ok) : ok.slice(0, 1);
    render();
    return ok.length > 0;
  }

  function reset() {
    files = [];
    input.value = "";
    touch();
    input.focus();
  }

  uploaderInputs.set(cfg.id, incoming => {
    const replacing = !cfg.multiple && files.length > 0;
    if (!addFiles(incoming)) return false;
    const count = incoming.length;
    status.textContent = replacing ? "Replaced the previous input with this result." :
      "Added " + count + (count === 1 ? " file" : " files") + " from the previous tool.";
    return true;
  });

  sendResult.addEventListener("click", () => {
    if (busy || !result || workflow.hidden || !nextTool.value) return;
    const id = nextTool.value;
    const destination = ensureView(id);
    if (!uploaderInputs.get(id)(transferable)) {
      toast("That tool is currently processing. Try again when it finishes.", "error");
      return;
    }
    writeRoute("pushState", id);
    show();
    const heading = destination.querySelector("h1");
    heading.tabIndex = -1;
    heading.focus();
  });

  optsEl.addEventListener("fileroom-edit", () => {
    if (!busy && result) touch();
  });
  input.addEventListener("change", () => { addFiles(input.files); input.value = ""; });
  zone.addEventListener("dragover",  e => { e.preventDefault(); if (!busy) zone.classList.add("over"); });
  zone.addEventListener("dragleave", () => zone.classList.remove("over"));
  zone.addEventListener("drop", e => { e.preventDefault(); zone.classList.remove("over"); addFiles(e.dataTransfer.files); });
  clear.addEventListener("click", reset);

  run.addEventListener("click", async () => {
    if (busy || !files.length) return;
    busy = true;
    result = null;
    warn();
    setProgress(0);
    status.textContent = "Processing…";
    status.dataset.state = "working";
    announce.textContent = "Processing " + files.length + (files.length === 1 ? " file." : " files.");
    render();
    try {
      await new Promise(resolve => setTimeout(resolve, 0));
      if (cfg.beforeRun) await cfg.beforeRun();
      const output = await cfg.process(files, setProgress);
      if (!(output?.blob instanceof Blob) || !output.blob.size) throw new Error("Processing did not produce a valid output file");
      result = output;
      announce.textContent = "Processing finished. Your result is ready.";
      status.textContent = "Ready to download: " + output.filename;
      status.dataset.state = "done";
      toast(TOAST[cfg.id] || "Done. Your result is ready.");
    } catch (err) {
      const message = err?.message || "The file could not be processed";
      status.textContent = /[.!?]$/.test(message) ? message : message + ".";
      status.dataset.state = "error";
      announce.textContent = status.textContent;
      toast(status.textContent, "error");
    } finally {
      busy = false;
      render();
    }
  });

  dl.addEventListener("click", () => {
    if (!result) return;
    const url = URL.createObjectURL(result.blob);
    const a = h("a", { href: url, download: result.filename });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  });

  render();
  return h("div", {}, announce, uploader);
}

/* =====================================================================
   3. TOOL REGISTRY
   Each tool is one self-contained object. To add a tool later (PDF to JPG,
   Watermark, Background Remover), push one more object here. Nothing else
   changes: tabs, home card, and routing are generated from this list.
   ===================================================================== */

/* ---------- PDF TOOLS (pdf-lib + JSZip, everything stays in the browser) ---------- */
const pdfBlob = bytes => new Blob([bytes], { type: "application/pdf" });
const baseName = f => f.name.replace(/\.pdf$/i, "");

async function needLibs(zip) {
  await requireLibrary("PDFLib");
  if (zip) await requireLibrary("JSZip");
}

// Load one PDF, with friendly errors for damaged or password-protected files.
async function loadPdf(file, opts) {
  await requireLibrary("PDFLib");
  try { return await PDFLib.PDFDocument.load(await file.arrayBuffer(), opts); }
  catch (err) {
    const locked = /encrypt/i.test(err.name + err.message);
    throw new Error(file.name + (locked ? " is password-protected. Remove the password and try again" : " looks damaged or is not a valid PDF. Remove it and try another file"));
  }
}

// Radio helper: returns [input, label].
const radio = (value, text, checked) => {
  const input = h("input", { type: "radio", name: "split-mode", value });
  input.checked = checked;
  return [input, h("label", { class: "choice" }, input, " " + text)];
};

/* --- Merge --- */
async function mergePdfs(files, onProgress) {
  await needLibs();
  if (files.length < 2) throw new Error("Add at least two PDFs to merge");
  const out = await PDFLib.PDFDocument.create();
  for (let i = 0; i < files.length; i++) {
    const src = await loadPdf(files[i]);
    (await out.copyPages(src, src.getPageIndices())).forEach(p => out.addPage(p));
    onProgress(Math.round(((i + 1) / files.length) * 95));
  }
  const bytes = await out.save();
  onProgress(100);
  return { blob: pdfBlob(bytes), filename: "merged.pdf", summary: out.getPageCount() + " pages, " + fmt(bytes.length) };
}

/* --- Split --- */
const splitUI = { last: null };

function splitOptions() {
  const [extractIn, extractLabel] = radio("extract", "Extract specific pages or a range into one PDF", true);
  const [eachIn, eachLabel] = radio("each", "Split every page into its own file (bundled as a .zip)", false);
  splitUI.each = eachIn;
  splitUI.info = h("strong", {}, "Add a PDF to see how many pages it has.");
  splitUI.range = h("input", { type: "text", class: "field", placeholder: "For example 1-3, 5", "aria-label": "Pages to extract" });
  const sync = () => { splitUI.range.disabled = eachIn.checked; };
  extractIn.addEventListener("change", sync); eachIn.addEventListener("change", sync);
  return h("div", { class: "opt-stack" }, splitUI.info, extractLabel, splitUI.range, eachLabel);
}

// Runs whenever the file list changes: shows the page count right away.
async function splitOnFiles(files) {
  const f = files[0] || null;
  if (f === splitUI.last) return;
  splitUI.last = f;
  if (!f) { splitUI.info.textContent = "Add a PDF to see how many pages it has."; return; }
  splitUI.info.textContent = "Reading page count…";
  try {
    const n = (await loadPdf(f)).getPageCount();
    if (splitUI.last === f) splitUI.info.textContent = f.name + " has " + n + (n === 1 ? " page." : " pages.");
  } catch (err) {
    if (splitUI.last === f) splitUI.info.textContent = err.message + ".";
  }
}

// "1-3, 5" becomes [0, 1, 2, 4]
function parseRanges(text, total) {
  const out = [];
  for (const part of text.split(",").map(s => s.trim()).filter(Boolean)) {
    const m = part.match(/^(\d+)(?:\s*-\s*(\d+))?$/);
    if (!m) throw new Error("“" + part + "” is not a valid page or range. Try something like 1-3, 5");
    const a = +m[1], b = m[2] ? +m[2] : a;
    if (a < 1 || b < a || b > total) throw new Error("“" + part + "” is outside this PDF, which has " + total + " pages");
    for (let p = a; p <= b; p++) out.push(p - 1);
  }
  if (!out.length) throw new Error("Enter the pages you want, for example 1-3, 5");
  return out;
}

async function splitPdf(files, onProgress) {
  await needLibs(splitUI.each.checked);
  const src = await loadPdf(files[0]);
  const total = src.getPageCount(), base = baseName(files[0]);
  if (!splitUI.each.checked) {
    const idx = parseRanges(splitUI.range.value, total);
    const out = await PDFLib.PDFDocument.create();
    (await out.copyPages(src, idx)).forEach(p => out.addPage(p));
    onProgress(60);
    const bytes = await out.save();
    onProgress(100);
    return { blob: pdfBlob(bytes), filename: base + "-pages.pdf", summary: idx.length + " of " + total + " pages extracted" };
  }
  const zip = new JSZip(), parts = [];
  for (let i = 0; i < total; i++) {
    const out = await PDFLib.PDFDocument.create();
    out.addPage((await out.copyPages(src, [i]))[0]);
    const name = base.replace(/[\\/]/g, "_") + "-page-" + (i + 1) + ".pdf";
    const part = pdfBlob(await out.save());
    zip.file(name, part);
    parts.push({ name, blob: part });
    onProgress(Math.round(((i + 1) / total) * 90));
  }
  const blob = await zip.generateAsync({ type: "blob" });
  onProgress(100);
  return { blob, filename: base + "-pages.zip", parts, summary: total + " files in one .zip" };
}

/* --- Compress --- */
// Low keeps the PDF as is (text stays selectable). Medium and High render each page with pdf.js,
// save it as a JPEG, and rebuild the PDF with pdf-lib.
const compressUI = {};
const COMPRESS_LEVELS = { low: { scale: 0, quality: 0 }, medium: { scale: 1.2, quality: 0.65 }, high: { scale: 0.9, quality: 0.45 } };

function compressOptions() {
  compressUI.level = h("select", { class: "field", "aria-label": "Compression level" },
    h("option", { value: "low" }, "Low: lossless, keeps text selectable"),
    h("option", { value: "medium", selected: "" }, "Medium: balanced"),
    h("option", { value: "high" }, "High: maximum shrink"));
  compressUI.warn = h("p", { class: "fine warn", hidden: "" },
    "⚠️ Note: Medium/High compression converts vector pages into compressed JPEGs. Selectable text and form fields will become non-searchable.");
  const sync = () => { compressUI.warn.hidden = compressUI.level.value === "low"; };
  compressUI.level.addEventListener("change", sync);
  sync();
  compressUI.root = h("div", { class: "opt-stack" },
    h("label", {}, "Compression level ", compressUI.level),
    compressUI.warn,
    h("span", { class: "fine" }, "Low only cleans up the file’s structure, so scanned or image-heavy PDFs barely shrink. Medium and High give the biggest savings on those."));
  return compressUI.root;
}

// Show a live message (like "Compressing page 3 of 12…") in this tool's own status line.
const compressStatus = msg => {
  const box = compressUI.root && compressUI.root.closest(".uploader");
  if (box) box.querySelector(".status").textContent = msg;
};

// Low: pack existing PDF objects into streams without rasterizing or updating form appearances.
async function structureCompress(file, onProgress) {
  onProgress(10);
  const doc = await loadPdf(file, { updateMetadata: false });
  onProgress(60);
  return doc.save({ useObjectStreams: true, updateFieldAppearances: false });
}

async function withPdfSource(file, use) {
  await requireLibrary("pdfjsLib");
  const workerUrl = hostedAssets ? assetUrl("vendor/pdf.worker.min.js") :
    URL.createObjectURL(new Blob([vendorBytes("pdfWorker")], { type: "text/javascript" }));
  let loadingTask;
  try {
    const data = await file.arrayBuffer();
    pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;
    loadingTask = pdfjsLib.getDocument({
      data,
      isEvalSupported: false
    });
    let src;
    try {
      src = await loadingTask.promise;
    } catch (err) {
      if (err.name === "PasswordException") throw new Error(file.name + " is password-protected. Remove the password and try again");
      if (err.name === "InvalidPDFException") throw new Error(file.name + " looks damaged or is not a valid PDF");
      throw err;
    }
    return await use(src);
  } finally {
    try {
      if (loadingTask) await loadingTask.destroy();
    } finally {
      if (!hostedAssets) URL.revokeObjectURL(workerUrl);
    }
  }
}

async function renderPdfCanvas(page, canvas, scale, maxEdge = 16000, rotation = page.rotate) {
  const base = page.getViewport({ scale: 1, rotation });
  const safeScale = Math.min(scale, maxEdge / base.width, maxEdge / base.height,
    Math.sqrt(MAX_CANVAS_PIXELS / (base.width * base.height)));
  const viewport = page.getViewport({ scale: safeScale, rotation });
  canvas.width = Math.max(1, Math.floor(viewport.width));
  canvas.height = Math.max(1, Math.floor(viewport.height));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("The browser could not allocate a page canvas");
  await page.render({ canvasContext: context, viewport, background: "#fff" }).promise;
  return base;
}

// Render one page at a time for PDF compression and JPG export.
async function renderPdfJpegs(file, scale, quality, onProgress, onPage, onPageStart) {
  await withPdfSource(file, async source => {
    for (let n = 1; n <= source.numPages; n++) {
      onProgress(Math.round(((n - 1) / source.numPages) * 95));
      onPageStart?.(n, source.numPages);
      const page = await source.getPage(n);
      const canvas = document.createElement("canvas");
      let bitmap;
      try {
        const base = await renderPdfCanvas(page, canvas, scale);
        bitmap = await createImageBitmap(canvas);
        releaseCanvas(canvas);
        const jpg = await encodeCanvas(bitmap, bitmap.width, bitmap.height, "image/jpeg", quality);
        await onPage(jpg, base, n, source.numPages);
      } finally {
        bitmap?.close();
        releaseCanvas(canvas);
        page.cleanup();
      }
    }
  });
}

async function rasterCompress(file, scale, quality, onProgress) {
  const out = await PDFLib.PDFDocument.create();
  await renderPdfJpegs(file, scale, quality, onProgress, async (jpg, base) => {
    const img = await out.embedJpg(await jpg.arrayBuffer());
    out.addPage([base.width, base.height]).drawImage(img, { x: 0, y: 0, width: base.width, height: base.height });
  }, (page, total) => compressStatus("Compressing page " + page + " of " + total + "…"));
  return out.save({ useObjectStreams: true });
}

async function compressPdf(files, onProgress) {
  await needLibs();
  const file = files[0], cfg = COMPRESS_LEVELS[compressUI.level.value];
  const bytes = cfg.scale ? await rasterCompress(file, cfg.scale, cfg.quality, onProgress) : await structureCompress(file, onProgress);
  onProgress(100);
  const before = file.size, after = bytes.length, name = baseName(file) + "-compressed.pdf";
  if (after >= before) return { blob: file, filename: name, summary: fmt(before) + " → " + fmt(before) + " | No savings at this level, original kept" };
  return { blob: pdfBlob(bytes), filename: name, summary: fmt(before) + " → " + fmt(after) + " | Saved " + Math.round((1 - after / before) * 100) + "%" };
}

/* ---------- IMAGE TOOLS (Canvas API, everything stays in the browser) ---------- */
const MAX_CANVAS_PIXELS = 32_000_000;
const IMG_TYPES = ["image/jpeg", "image/png", "image/webp"];
const IMG_ACCEPT = ".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp";
const extOf = type => ({ "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" })[type];
const stem = f => f.name.replace(/\.[^.]+$/, "");
const sizeLine = (a, b) => fmt(a) + " → " + fmt(b) + (b < a ? " | Saved " + Math.round((1 - b / a) * 100) + "%" : "");
const filesSig = fs => fs.length + "|" + fs.map(f => f.name + f.size + f.lastModified).join("|");
const opt = (value, text) => h("option", { value }, text);

async function loadImage(file) {
  try { return await createImageBitmap(file); }
  catch { throw new Error(file.name + " could not be read as an image. Use a JPG, PNG, or WebP file"); }
}

const releaseCanvas = canvas => { canvas.width = canvas.height = 0; };

function drawToCanvas(canvas, bmp, w, ht, type, bg, cover) {
  if (w > 16000 || ht > 16000 || w * ht > MAX_CANVAS_PIXELS) {
    throw new Error("This image is too large to process at these dimensions. Try a smaller image or output size");
  }
  canvas.width = w;
  canvas.height = ht;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("The browser could not allocate an image canvas");
  if (type === "image/jpeg") {
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, ht);
  }
  if (cover) {
    const scale = Math.max(w / bmp.width, ht / bmp.height);
    const sw = w / scale, sh = ht / scale;
    ctx.drawImage(bmp, (bmp.width - sw) / 2, (bmp.height - sh) / 2, sw, sh, 0, 0, w, ht);
  } else {
    ctx.drawImage(bmp, 0, 0, w, ht);
  }
}

// Browsers can return PNG when the requested format is unsupported.
const toBlob = (canvas, type, q) => new Promise((res, rej) => canvas.toBlob(
  b => b && b.type === type ? res(b) : rej(new Error("This browser cannot save images as " + extOf(type).toUpperCase() + ". Pick another format")), type, q));

async function encodeCanvas(bmp, w, ht, type, quality, bg = "#ffffff", cover = false) {
  const canvas = document.createElement("canvas");
  try {
    drawToCanvas(canvas, bmp, w, ht, type, bg, cover);
    return await toBlob(canvas, type, quality);
  } finally {
    releaseCanvas(canvas);
  }
}

async function encodeImage(bmp, type, quality, target, cancelled = () => false) {
  if (!target) return encodeCanvas(bmp, bmp.width, bmp.height, type, quality);
  const lossy = type !== "image/png";
  const longest = Math.max(bmp.width, bmp.height);
  const limit = Math.max(1, Math.floor(longest * Math.min(1, 16000 / longest,
    Math.sqrt(MAX_CANVAS_PIXELS / (bmp.width * bmp.height)))));
  let best, smallest;
  const canvas = document.createElement("canvas");

  async function sample(q) {
    if (cancelled()) throw new DOMException("Preview superseded", "AbortError");
    const blob = await toBlob(canvas, type, q);
    if (!smallest || blob.size < smallest.size) smallest = blob;
    if (blob.size <= target && (!best || blob.size > best.size)) best = blob;
    return blob.size <= target;
  }

  async function trySize(longEdge) {
    const w = Math.max(1, Math.floor(bmp.width * longEdge / longest));
    const ht = Math.max(1, Math.floor(bmp.height * longEdge / longest));
    try {
      drawToCanvas(canvas, bmp, w, ht, type, "#ffffff", false);
      if (await sample(1)) return true;
      if (!lossy || !await sample(0)) return false;
      let low = 0, high = 100;
      while (high - low > 1 && best.size < target) {
        const mid = Math.floor((low + high) / 2);
        if (await sample(mid / 100)) low = mid;
        else high = mid;
      }
      return true;
    } finally {
      releaseCanvas(canvas);
    }
  }

  let tooLarge = limit, fits = 0;
  if (await trySize(limit)) fits = limit;
  // Find a fitting size, including the encoder's minimum at 1 × 1.
  while (!fits && tooLarge > 1) {
    const next = Math.max(1, Math.floor(tooLarge * 0.75));
    if (await trySize(next)) fits = next;
    else tooLarge = next;
  }
  // Refine dimensions and retain the closest under-budget sample.
  while (fits && tooLarge - fits > 1 && best.size < target) {
    const mid = Math.floor((fits + tooLarge) / 2);
    if (await trySize(mid)) fits = mid;
    else tooLarge = mid;
  }
  // Discrete quality steps can leave a gap. Try nearby dimensions to fill it.
  if (lossy && fits && best.size < target * 0.99) {
    const step = Math.max(1, Math.round(fits * 0.025));
    for (let edge = fits - step; edge > 0 && edge >= fits - 8 * step && best.size < target * 0.99; edge -= step) {
      await trySize(edge);
    }
  }
  return best || smallest;
}

// Runs fn(file, bitmap) -> { blob, name, note? } on every image.
// One result downloads as a file; several are bundled into a .zip.
async function runBatch(files, onProgress, fn, zipName, openBitmap = loadImage, label = "images") {
  const done = [], skipped = [], sizes = [], targetNotes = [];
  for (let i = 0; i < files.length; i++) {
    let bitmap;
    try {
      bitmap = await openBitmap(files[i]);
      const out = await fn(files[i], bitmap);
      if (out.targetNote) targetNotes[i] = out.targetNote;
      done.push(out); sizes.push(out.blob.size);
    } catch (err) {
      if (files.length === 1) throw err;
      skipped.push(files[i].name); sizes.push(null);
    } finally {
      bitmap?.close();
    }
    onProgress(Math.round(((i + 1) / files.length) * 95));
  }
  if (!done.length) throw new Error("None of the " + label + " could be processed. Check that they open correctly and try again");
  const before = files.reduce((s, f, i) => sizes[i] == null ? s : s + f.size, 0);
  const after = done.reduce((s, d) => s + d.blob.size, 0);
  const tail = skipped.length ? " | Skipped: " + skipped.join(", ") : "";
  if (done.length === 1) {
    onProgress(100);
    return { blob: done[0].blob, filename: done[0].name, sizes, targetNotes, summary: (done[0].note ? done[0].note + " | " : "") + sizeLine(before, after) + tail };
  }
  await requireLibrary("JSZip");
  const zip = new JSZip(), names = new Set();
  for (const item of done) {
    let name = item.name.replace(/[\\/]/g, "_");
    const cleanName = name;
    for (let n = 2; names.has(name); n++) {
      name = cleanName.replace(/(\.[^.]+)?$/, (_, ext = "") => "-" + n + ext);
    }
    names.add(name);
    zip.file(name, item.blob);
    item.name = name;
  }
  const blob = await zip.generateAsync({ type: "blob" });
  onProgress(100);
  return { blob, filename: zipName + ".zip", parts: done, dlLabel: "Download all as ZIP", sizes, targetNotes, summary: done.length + " " + label + " | " + sizeLine(before, after) + tail };
}

/* --- Image Compressor: live preview + size estimate --- */
const imgC = { files: [], sig: "", token: 0, previewPending: false, previewTask: Promise.resolve() };
const imgTarget = () => {
  const value = imgC.kb.valueAsNumber;
  return Number.isFinite(value) && value > 0 ? Math.max(1, Math.floor(value * 1024)) : 0;
};
const imgOutType = f => imgC.fmt.value === "keep" ? (IMG_TYPES.includes(f.type) ? f.type : "image/jpeg") : imgC.fmt.value;
const kb = bytes => (bytes / 1024).toLocaleString("en-US", { maximumFractionDigits: 3 });
const targetNote = (blob, target) => target && blob.size > target
  ? "Closest achieved size: " + kb(blob.size) + " KB (Target " + kb(target) + " KB was too low for dimensions)"
  : "";

async function previewImage(img, blob) {
  const url = URL.createObjectURL(blob);
  try {
    img.src = url;
    await img.decode();
  } finally {
    URL.revokeObjectURL(url);
  }
}

let previewTimer;
function stopPreview() {
  clearTimeout(previewTimer);
  imgC.token++;
  return imgC.previewTask;
}

function imgPreview() {
  stopPreview();
  imgC.previewPending = true;
  const token = imgC.token;
  previewTimer = setTimeout(() => {
    imgC.previewTask = imgC.previewTask.then(() => updatePreview(token));
  }, 200);
}

async function updatePreview(token) {
  const f = imgC.files[0];
  const cancelled = () => token !== imgC.token;
  if (!f || cancelled()) return;
  let bitmap;
  try {
    bitmap = await loadImage(f);
    if (cancelled()) return;
    const target = imgTarget();
    const blob = await encodeImage(bitmap, imgOutType(f), imgC.q.value / 100, target, cancelled);
    bitmap.close();
    bitmap = null;
    if (cancelled()) return;
    await previewImage(imgC.newImg, blob);
    if (cancelled()) return;
    const ratio = blob.size / f.size, n = imgC.files.length;
    imgC.newCap.textContent = targetNote(blob, target) || "Compressed · " + fmt(blob.size) + (blob.size < f.size ? " (" + Math.round((1 - ratio) * 100) + "% smaller)" : " (not smaller)");
    imgC.est.textContent = n > 1 ? "Estimated total for all " + n + " images: about " + fmt(imgC.files.reduce((s, x) => s + x.size, 0) * ratio) + ", based on the first image." : "";
  } catch (err) {
    if (!cancelled()) imgC.newCap.textContent = err.message + ".";
  } finally {
    bitmap?.close();
    if (!cancelled()) imgC.previewPending = false;
  }
}

function imgCompressOptions() {
  imgC.fmt = h("select", { class: "field", "aria-label": "Output format" }, opt("keep", "Keep original format"), opt("image/jpeg", "JPG"), opt("image/webp", "WebP"));
  imgC.q = h("input", { type: "range", min: "10", max: "100", value: "70", "aria-label": "Quality" });
  imgC.qOut = h("strong", {}, "70");
  imgC.kb = h("input", { type: "number", min: "0.001", step: "any", class: "field", placeholder: "e.g. 100", "aria-label": "Target size in KB" });
  imgC.origImg = h("img", { alt: "Original image preview" });
  imgC.newImg = h("img", { alt: "Compressed image preview" });
  imgC.origCap = h("figcaption"); imgC.newCap = h("figcaption");
  imgC.est = h("p", { class: "fine" });
  imgC.compare = h("div", { class: "compare", hidden: "" },
    h("figure", {}, imgC.origImg, imgC.origCap), h("figure", {}, imgC.newImg, imgC.newCap));
  imgC.q.addEventListener("input", () => { imgC.qOut.textContent = imgC.q.value; imgPreview(); });
  imgC.fmt.addEventListener("change", imgPreview);
  imgC.kb.addEventListener("input", imgPreview);
  return h("div", { class: "opt-stack" },
    h("label", {}, "Output format ", imgC.fmt),
    h("label", {}, "Quality ", imgC.q, " ", imgC.qOut, "%"),
    h("label", {}, "Target size in KB (optional) ", imgC.kb),
    h("span", { class: "fine" }, "PNG files stay lossless, so quality does not change them. Choose JPG or WebP to shrink them. With a target size, quality is lowered automatically, and the image shrunk if needed."),
    imgC.compare, imgC.est);
}

// Runs whenever the file list changes: shows the first image side by side with its compressed version.
function imgCompressOnFiles(files) {
  const s = filesSig(files);
  if (s === imgC.sig) return;
  imgC.sig = s; imgC.files = files.slice();
  stopPreview();
  imgC.origImg.removeAttribute("src");
  imgC.newImg.removeAttribute("src");
  imgC.est.textContent = "";
  imgC.compare.hidden = !files.length;
  if (!files.length) { imgC.previewPending = false; return; }
  previewImage(imgC.origImg, files[0]).catch(() => {});
  imgC.origCap.textContent = "Original · " + fmt(files[0].size) + (files.length > 1 ? " (first of " + files.length + ")" : "");
  imgC.newCap.textContent = "Compressing preview…";
  imgPreview();
}

async function compressImages(files, onProgress) {
  try {
    if (!imgC.kb.validity.valid) throw new Error("Enter a positive target size in KB or leave the field blank");
    const target = imgTarget(), q = imgC.q.value / 100;
    return await runBatch(files, onProgress, async (f, bmp) => {
      const type = imgOutType(f), blob = await encodeImage(bmp, type, q, target);
      if (!target && type === f.type && blob.size >= f.size) return { blob: f, name: f.name };
      return { blob, name: stem(f) + "-compressed." + extOf(type), targetNote: targetNote(blob, target) };
    }, "compressed-images");
  } finally {
    if (imgC.previewPending) imgPreview();
  }
}

/* --- Image Resizer --- */
const resUI = { last: "", dims: null, pct: 0, crop: false };
const RES_PRESETS = [["50%", { pct: 50 }], ["75%", { pct: 75 }], ["1080p", { w: 1920, h: 1080 }], ["Instagram Square", { w: 1080, h: 1080, crop: true }]];

// Work out the output size for an image of bw x bh from the current settings.
function targetDims(bw, bh) {
  if (resUI.pct) return [Math.max(1, Math.round(bw * resUI.pct / 100)), Math.max(1, Math.round(bh * resUI.pct / 100))];
  const w = Math.max(0, Math.round(+resUI.w.value)), ht = Math.max(0, Math.round(+resUI.h.value));
  if (!w && !ht) return null;
  if (resUI.crop || !resUI.lock.checked) return [w || bw, ht || bh];
  const s = Math.min(w ? w / bw : Infinity, ht ? ht / bh : Infinity);   // locked: fit inside the box
  return [Math.max(1, Math.round(bw * s)), Math.max(1, Math.round(bh * s))];
}

function resizeRefresh() {
  const d = resUI.dims;
  let t = "";
  if (resUI.pct) t = "Every image is scaled to " + resUI.pct + "% of its original size.";
  else if (resUI.crop) t = "Each image is cropped from the center to fill the square.";
  else if (d) { const r = targetDims(d.w, d.h); if (r) t = "New size: " + r[0] + " × " + r[1] + " px (from " + d.w + " × " + d.h + " px)"; }
  resUI.note.textContent = t;
}

function resizeOptions() {
  resUI.info = h("strong", {}, "Add an image to see its size.");
  resUI.note = h("span", { class: "fine" });
  resUI.w = h("input", { type: "number", min: "1", class: "field", "aria-label": "Width in pixels" });
  resUI.h = h("input", { type: "number", min: "1", class: "field", "aria-label": "Height in pixels" });
  resUI.lock = h("input", { type: "checkbox" });
  resUI.lock.checked = true;
  const manual = from => () => {   // typing a size cancels any preset; locked ratio fills in the other side
    resUI.pct = 0; resUI.crop = false;
    const d = resUI.dims;
    if (d && resUI.lock.checked) {
      if (from === "w") resUI.h.value = resUI.w.value ? Math.round(resUI.w.value * d.h / d.w) : "";
      else resUI.w.value = resUI.h.value ? Math.round(resUI.h.value * d.w / d.h) : "";
    }
    resizeRefresh();
  };
  resUI.w.addEventListener("input", manual("w"));
  resUI.h.addEventListener("input", manual("h"));
  resUI.lock.addEventListener("change", () => { resUI.crop = false; resizeRefresh(); });
  const presetBtn = ([label, p]) => h("button", { class: "mini", type: "button", onclick: () => {
    resUI.pct = p.pct || 0; resUI.crop = !!p.crop; resUI.lock.checked = !p.crop;
    const d = resUI.dims;
    if (p.pct) { resUI.w.value = d ? Math.round(d.w * p.pct / 100) : ""; resUI.h.value = d ? Math.round(d.h * p.pct / 100) : ""; }
    else { resUI.w.value = p.w; resUI.h.value = p.h; }
    resizeRefresh();
  } }, label);
  return h("div", { class: "opt-stack" }, resUI.info,
    h("div", { class: "presets" }, RES_PRESETS.map(presetBtn)),
    h("label", {}, "Width (px) ", resUI.w, "  Height (px) ", resUI.h),
    h("label", { class: "choice" }, resUI.lock, " Lock aspect ratio"),
    resUI.note);
}

async function resizeOnFiles(files) {
  const s = filesSig(files), f = files[0] || null;
  if (s === resUI.last) return;
  resUI.last = s; resUI.dims = null;
  if (!f) { resUI.info.textContent = "Add an image to see its size."; resizeRefresh(); return; }
  let b;
  try {
    b = await loadImage(f);
    if (resUI.last === s) {
      resUI.dims = { w: b.width, h: b.height };
      resUI.info.textContent = f.name + " is " + b.width + " × " + b.height + " px (" + fmt(f.size) + ")." + (files.length > 1 ? " Showing the first of " + files.length + " images." : "");
      resizeRefresh();
    }
  } catch {
    if (resUI.last === s) resUI.info.textContent = f.name + " could not be read as an image.";
  } finally {
    b?.close();
  }
}

function resizeImages(files, onProgress) {
  if (!resUI.pct && !+resUI.w.value && !+resUI.h.value) throw new Error("Enter a width, a height, or pick a preset");
  return runBatch(files, onProgress, async (f, bmp) => {
    const [w, ht] = targetDims(bmp.width, bmp.height);
    if (w > 16000 || ht > 16000) throw new Error(f.name + " would be too large for a browser to handle. Stay under 16000 pixels");
    const type = IMG_TYPES.includes(f.type) ? f.type : "image/png";
    const blob = await encodeCanvas(bmp, w, ht, type, 0.92, "#ffffff", resUI.crop);
    return { blob, name: stem(f) + "-" + w + "x" + ht + "." + extOf(type), note: bmp.width + " × " + bmp.height + " → " + w + " × " + ht + " px" };
  }, "resized-images");
}

/* --- Image Format Converter --- */
const cvUI = {};
function convertOptions() {
  cvUI.fmt = h("select", { class: "field", "aria-label": "Target format" }, opt("image/jpeg", "JPG"), opt("image/png", "PNG"), opt("image/webp", "WebP"));
  cvUI.q = h("input", { type: "range", min: "60", max: "100", value: "90", "aria-label": "Quality" });
  cvUI.qOut = h("strong", {}, "90");
  cvUI.bg = h("input", { type: "color", value: "#ffffff", "aria-label": "Background color for transparent areas" });
  const sync = () => {
    cvUI.q.disabled = cvUI.fmt.value === "image/png";      // PNG is lossless
    cvUI.bg.disabled = cvUI.fmt.value !== "image/jpeg";    // only JPG needs a fill color
    cvUI.qOut.textContent = cvUI.q.value;
  };
  cvUI.fmt.addEventListener("change", sync); cvUI.q.addEventListener("input", sync);
  sync();
  return h("div", { class: "opt-stack" },
    h("label", {}, "Convert to ", cvUI.fmt),
    h("label", {}, "Quality ", cvUI.q, " ", cvUI.qOut, "%"),
    h("label", {}, "Background for transparent areas (JPG only) ", cvUI.bg),
    h("span", { class: "fine" }, "JPG cannot be transparent, so transparent PNG areas are filled with the color above. Quality applies to JPG and WebP."));
}

function convertImages(files, onProgress) {
  const type = cvUI.fmt.value, q = cvUI.q.value / 100, bg = cvUI.bg.value;
  return runBatch(files, onProgress, async (f, bmp) => ({
    blob: await encodeCanvas(bmp, bmp.width, bmp.height, type, q, bg),
    name: stem(f) + "." + extOf(type)
  }), "converted-images");
}


/* --- PDF to JPG --- */
let jpgResolution;
function pdfJpgOptions() {
  jpgResolution = h("select", { class: "field", "aria-label": "JPG resolution" },
    opt("1", "72 DPI"), opt("2", "144 DPI"), opt("3", "216 DPI"));
  jpgResolution.value = "2";
  return h("div", { class: "opt-stack" },
    h("label", {}, "Resolution ", jpgResolution),
    h("span", { class: "fine" }, "Get one JPG per page. Multi-page PDFs download as a ZIP. Very large pages may be scaled to fit browser limits."));
}

async function pdfToJpg(files, onProgress) {
  const file = files[0], base = baseName(file).replace(/[\\/]/g, "_");
  let output, archive, pages;
  const parts = [];
  await renderPdfJpegs(file, Number(jpgResolution.value), 0.92, onProgress, async (jpg, viewport, page, total) => {
    pages = total;
    if (total === 1) {
      output = jpg;
      return;
    }
    if (!archive) {
      await requireLibrary("JSZip");
      archive = new JSZip();
    }
    const number = String(page).padStart(String(total).length, "0");
    const name = base + "-page-" + number + ".jpg";
    archive.file(name, jpg);
    parts.push({ name, blob: jpg });
  });
  if (archive) output = await archive.generateAsync({ type: "blob" });
  onProgress(100);
  return { blob: output, filename: base + (archive ? "-jpg.zip" : ".jpg"),
    parts: archive ? parts : undefined, dlLabel: archive ? "Download all as ZIP" : "Download JPG", summary: pages + (pages === 1 ? " page" : " pages") };
}

/* --- JPG to PDF --- */
const imagePdfUI = {};
function imagePdfOptions() {
  imagePdfUI.paper = h("select", { class: "field", "aria-label": "Paper size" }, opt("A4", "A4"), opt("Letter", "US Letter"));
  imagePdfUI.orientation = h("select", { class: "field", "aria-label": "Page orientation" },
    opt("auto", "Match each image"), opt("portrait", "Portrait"), opt("landscape", "Landscape"));
  return h("div", { class: "opt-stack" },
    h("label", {}, "Paper size ", imagePdfUI.paper),
    h("label", {}, "Orientation ", imagePdfUI.orientation),
    h("span", { class: "fine" }, "Each image gets its own page. Use Up and Down to set the page order."));
}

async function imagesToPdf(files, onProgress) {
  await requireLibrary("PDFLib");
  const { PDFDocument, PageSizes } = PDFLib;
  const pdf = await PDFDocument.create();
  const [short, long] = PageSizes[imagePdfUI.paper.value];
  const orientation = imagePdfUI.orientation.value;
  const margin = 24;
  for (const [index, file] of files.entries()) {
    const bitmap = await loadImage(file);
    try {
      const landscape = orientation === "landscape" || (orientation === "auto" && bitmap.width > bitmap.height);
      const [width, height] = landscape ? [long, short] : [short, long];
      const jpeg = matches(file, ".jpg,.jpeg,image/jpeg");
      // Canvas respects EXIF rotation. Limit the embedded raster to about 300 DPI.
      const fit = Math.min((width - 2 * margin) / bitmap.width, (height - 2 * margin) / bitmap.height);
      const rasterScale = Math.min(1, fit * (300 / 72));
      const normalized = await encodeCanvas(bitmap,
        Math.max(1, Math.round(bitmap.width * rasterScale)), Math.max(1, Math.round(bitmap.height * rasterScale)),
        jpeg ? "image/jpeg" : "image/png", 0.96);
      const bytes = await normalized.arrayBuffer();
      const image = await (jpeg ? pdf.embedJpg(bytes) : pdf.embedPng(bytes));
      const drawWidth = bitmap.width * fit, drawHeight = bitmap.height * fit;
      pdf.addPage([width, height]).drawImage(image, { x: (width - drawWidth) / 2, y: (height - drawHeight) / 2,
        width: drawWidth, height: drawHeight });
    } finally {
      bitmap.close();
    }
    onProgress(Math.round((index + 1) / files.length * 95));
  }
  const blob = pdfBlob(await pdf.save());
  const filename = files.length === 1 ? stem(files[0]) + ".pdf" : "images.pdf";
  onProgress(100);
  return { blob, filename, summary: files.length + (files.length === 1 ? " page" : " pages") + " | " + fmt(blob.size) };
}

/* --- Text watermark for PDFs and images --- */
const watermarkUI = {};
function watermarkOptions() {
  watermarkUI.text = h("input", { class: "field", maxlength: "100", placeholder: "e.g. CONFIDENTIAL", "aria-label": "Watermark text" });
  watermarkUI.position = h("select", { class: "field", "aria-label": "Watermark position" },
    opt("center", "Center"), opt("top-left", "Top left"), opt("bottom-right", "Bottom right"), opt("custom", "Custom"));
  watermarkUI.size = h("input", { class: "field", type: "number", min: "1", max: "25", value: "8", "aria-label": "Watermark size" });
  watermarkUI.opacity = h("input", { class: "field", type: "number", min: "1", max: "100", value: "45", "aria-label": "Watermark opacity" });
  watermarkUI.color = h("input", { type: "color", value: "#000000", "aria-label": "Watermark color" });
  watermarkUI.x = h("input", { class: "field", type: "number", min: "0", max: "100", step: "0.01", value: "50" });
  watermarkUI.y = h("input", { class: "field", type: "number", min: "0", max: "100", step: "0.01", value: "50" });
  watermarkUI.custom = h("div", { class: "pixel-fields", hidden: "" },
    h("label", {}, "Across (%) ", watermarkUI.x), h("label", {}, "Down (%) ", watermarkUI.y));
  watermarkUI.preview = pdfPreview("First page of the first PDF");
  watermarkUI.ink = h("canvas");
  watermarkUI.overlay = h("div", { class: "pdf-overlay", hidden: "", "aria-hidden": "true" }, watermarkUI.ink);
  const surface = watermarkUI.preview.surface;
  surface.append(watermarkUI.overlay);
  dragPdfOverlay(surface, watermarkUI.overlay, (x, y) => {
    watermarkUI.position.value = "custom";
    watermarkUI.x.value = (x * 100).toFixed(2);
    watermarkUI.y.value = (y * 100).toFixed(2);
    updateWatermarkPreview();
    edited(surface);
  });
  for (const field of [watermarkUI.text, watermarkUI.position, watermarkUI.size, watermarkUI.opacity, watermarkUI.color, watermarkUI.x, watermarkUI.y]) {
    field.addEventListener("input", () => { updateWatermarkPreview(); edited(field); });
  }
  return h("div", { class: "opt-stack" },
    h("label", {}, "Text ", watermarkUI.text),
    h("label", {}, "Position ", watermarkUI.position),
    h("label", {}, "Size (% of shorter side) ", watermarkUI.size),
    h("label", {}, "Opacity (%) ", watermarkUI.opacity),
    h("label", {}, "Color ", watermarkUI.color),
    watermarkUI.custom,
    h("span", { class: "fine" }, "Add a PDF and enter text to drag the watermark on the first page. The placement applies across all pages and files."),
    surface, watermarkUI.preview.info);
}

function watermarkOnFiles(files) {
  const file = files.find(isPdfFile);
  if (file === watermarkUI.file) return;
  watermarkUI.file = file;
  watermarkUI.preview.show(file, 1, 0, updateWatermarkPreview);
}

function updateWatermarkPreview() {
  const { canvas, surface } = watermarkUI.preview;
  const { ink, overlay } = watermarkUI;
  watermarkUI.custom.hidden = watermarkUI.position.value !== "custom";
  const settings = watermarkSettings();
  overlay.hidden = !settings || surface.hidden;
  if (overlay.hidden) return;
  const { width, height } = canvas;
  const ctx = ink.getContext("2d");
  const nominalSize = Math.min(width, height) * settings.size;
  ctx.font = "bold " + nominalSize + "px Arial, sans-serif";
  const measured = ctx.measureText(settings.text).width;
  const size = nominalSize * Math.min(1, width * 0.9 / Math.max(1, measured));
  const textWidth = measured * size / nominalSize;
  const [x, y] = watermarkPosition(settings, width, height, textWidth, size);
  const appearance = JSON.stringify([settings.text, size, textWidth, settings.color, settings.opacity]);
  if (watermarkUI.appearance !== appearance) {
    watermarkUI.appearance = appearance;
    ink.width = Math.max(1, Math.ceil(textWidth));
    ink.height = Math.max(1, Math.ceil(size));
    ctx.font = "bold " + size + "px Arial, sans-serif";
    ctx.fillStyle = settings.color;
    ctx.globalAlpha = settings.opacity;
    ctx.textBaseline = "bottom";
    ctx.fillText(settings.text, 0, ink.height, ink.width);
  }
  positionPdfOverlay(overlay, canvas, [x, height - y - size, textWidth, size]);
}

function watermarkPosition({ position, x, y }, width, height, textWidth, textHeight) {
  const margin = Math.min(width, height) * 0.05;
  if (position === "custom") return [clamp(width * x - textWidth / 2, 0, width - textWidth),
    clamp(height * (1 - y) - textHeight / 2, 0, height - textHeight)];
  if (position === "top-left") return [margin, height - margin - textHeight];
  if (position === "bottom-right") return [width - margin - textWidth, margin];
  return [(width - textWidth) / 2, (height - textHeight) / 2];
}

async function watermarkPdf(file, settings) {
  const { rgb, degrees, StandardFonts } = PDFLib;
  const doc = await loadPdf(file, { updateMetadata: false });
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  let unitWidth;
  try { unitWidth = font.widthOfTextAtSize(settings.text, 1); }
  catch { throw new Error("PDF watermarks support Latin characters. Try simpler text without emoji"); }
  const color = rgb(...settings.color.slice(1).match(/../g).map(hex => parseInt(hex, 16) / 255));
  for (const page of doc.getPages()) {
    const crop = page.getCropBox();
    const rotation = ((page.getRotation().angle % 360) + 360) % 360;
    const sideways = rotation === 90 || rotation === 270;
    const width = sideways ? crop.height : crop.width, height = sideways ? crop.width : crop.height;
    const size = Math.min(Math.min(width, height) * settings.size, width * 0.9 / unitWidth);
    const [x, y] = watermarkPosition(settings, width, height, unitWidth * size, size);
    const coordinates = {
      0: [x, y], 90: [crop.width - y, x],
      180: [crop.width - x, crop.height - y], 270: [y, crop.height - x]
    };
    const [px, py] = coordinates[rotation] || coordinates[0];
    page.drawText(settings.text, { x: crop.x + px, y: crop.y + py, size,
      font, color, opacity: settings.opacity, rotate: degrees(rotation) });
  }
  return pdfBlob(await doc.save({ updateFieldAppearances: false }));
}

async function watermarkImage(bitmap, settings) {
  const canvas = document.createElement("canvas");
  try {
    const { width, height } = bitmap;
    drawToCanvas(canvas, bitmap, width, height, "image/png", "", false);
    const ctx = canvas.getContext("2d");
    const size = Math.min(width, height) * settings.size;
    ctx.font = "bold " + size + "px sans-serif";
    const textWidth = Math.min(width * 0.9, ctx.measureText(settings.text).width);
    const [x, y] = watermarkPosition(settings, width, height, textWidth, size);
    ctx.globalAlpha = settings.opacity;
    ctx.fillStyle = settings.color;
    ctx.textBaseline = "bottom";
    ctx.fillText(settings.text, x, height - y, textWidth);
    return await toBlob(canvas, "image/png");
  } finally {
    releaseCanvas(canvas);
  }
}

function watermarkSettings() {
  const text = watermarkUI.text.value.trim();
  if (!text || [watermarkUI.size, watermarkUI.opacity, watermarkUI.x, watermarkUI.y].some(field => !field.value || !field.validity.valid)) return null;
  return { text, position: watermarkUI.position.value, size: Number(watermarkUI.size.value) / 100,
    x: Number(watermarkUI.x.value) / 100, y: Number(watermarkUI.y.value) / 100,
    opacity: Number(watermarkUI.opacity.value) / 100, color: watermarkUI.color.value };
}

async function addWatermarks(files, onProgress) {
  if (!watermarkUI.text.value.trim()) throw new Error("Enter watermark text");
  const settings = watermarkSettings();
  if (!settings) throw new Error("Enter a valid size, opacity, and position");
  if (files.some(isPdfFile)) await requireLibrary("PDFLib");
  return runBatch(files, onProgress, async (file, bitmap) => {
    const pdf = isPdfFile(file);
    const blob = await (pdf ? watermarkPdf(file, settings) : watermarkImage(bitmap, settings));
    return { blob, name: stem(file) + "-watermarked." + (pdf ? "pdf" : "png") };
  }, "watermarked-files", file => isPdfFile(file) ? null : loadImage(file), "files");
}

/* --- On-device background removal (U²-Netp + ONNX Runtime Web) --- */
const ORT_BASE = assetUrl("background/", "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/");
const BG_MODEL = assetUrl("background/u2netp.onnx");
let backgroundSession;
let backgroundEdge;

function backgroundOptions() {
  backgroundEdge = h("input", { class: "placement-slider", type: "range", min: "0", max: "100", value: "50" });
  const value = h("output", {}, "50%");
  backgroundEdge.addEventListener("input", () => {
    value.textContent = backgroundEdge.value + "%";
    edited(backgroundEdge);
  });
  return h("div", { class: "opt-stack" },
    h("label", {}, "Edge cleanup ", value, backgroundEdge),
    h("p", { class: "fine" }, "Lower it to keep hair and fine detail. Raise it to remove more leftover background. Adjust and run again to compare."),
    h("p", { class: "fine" }, hostedAssets ? "Your images stay on your device." : "Your images stay on your device. The first run may download the processing runtime."));
}

function getBackgroundSession() {
  if (!backgroundSession) {
    backgroundSession = (async () => {
      if (!window.ort && !await loadVerifiedScript(ORT_BASE + "ort.wasm.min.js", "sha384-epp8GDQUoLKx5qHa6SoDHKv7fSHILsEYk4uEsHdPRBztXEIVWCe/lhhrQJUBMZcf", "ort", 15000)) {
        throw new Error("Could not load the background remover. Check your internet connection and try again");
      }
      let bytes;
      if (hostedAssets) {
        bytes = await fetch(BG_MODEL, {
          credentials: "omit", signal: AbortSignal.timeout(45000), integrity: "sha384-UpjzLoU+lZEVpKFraDciVxXXwOeulVBvJo0I/V2HCFa+3IfH/NVWG+LnDKlaZDM4"
        }).then(response => response.ok ? response.arrayBuffer() : null).catch(() => null);
      } else {
        bytes = vendorBytes("bgModel");
      }
      if (!bytes?.byteLength) throw new Error("Could not load the background removal model. Check your connection and retry");
      ort.env.wasm.numThreads = 1;
      ort.env.wasm.wasmPaths = ORT_BASE;
      ort.env.wasm.initTimeout = 45000;
      return ort.InferenceSession.create(bytes, { executionProviders: ["wasm"] }).catch(err => {
        console.error("Background removal model initialization failed", err);
        throw new Error("Could not start background removal. Check your connection or try a recent browser");
      });
    })().catch(err => {
      backgroundSession = null;
      throw err;
    });
  }
  return backgroundSession;
}

async function removeBackground(bitmap, session, cleanup) {
  const edge = 320, area = edge * edge;
  const scale = edge / Math.max(bitmap.width, bitmap.height);
  const sampleWidth = Math.max(1, Math.round(bitmap.width * scale));
  const sampleHeight = Math.max(1, Math.round(bitmap.height * scale));
  const left = Math.floor((edge - sampleWidth) / 2);
  const top = Math.floor((edge - sampleHeight) / 2);
  const sample = document.createElement("canvas"), canvas = document.createElement("canvas");
  let input, outputs;
  try {
    sample.width = sample.height = edge;
    const ctx = sample.getContext("2d", { willReadFrequently: true });
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, edge, edge);
    ctx.drawImage(bitmap, left, top, sampleWidth, sampleHeight);
    const pixels = ctx.getImageData(0, 0, edge, edge);
    const rgb = pixels.data;
    let brightest = 1;
    for (let i = 0; i < rgb.length; i += 4) brightest = Math.max(brightest, rgb[i], rgb[i + 1], rgb[i + 2]);
    const mean = [0.485, 0.456, 0.406], deviation = [0.229, 0.224, 0.225];
    const inputData = new Float32Array(3 * area);
    for (let i = 0; i < area; i++) {
      for (let c = 0; c < 3; c++) inputData[c * area + i] = (rgb[i * 4 + c] / brightest - mean[c]) / deviation[c];
    }
    input = new ort.Tensor("float32", inputData, [1, 3, edge, edge]);
    const outputName = session.outputNames[0];
    outputs = await session.run({ [session.inputNames[0]]: input }, [outputName]);
    const mask = outputs[outputName].data;
    if (mask.length !== area) throw new Error("The background removal model returned an invalid mask");
    let lo = Infinity, hi = -Infinity;
    for (let y = top; y < top + sampleHeight; y++) {
      for (let x = left; x < left + sampleWidth; x++) {
        const value = mask[y * edge + x];
        lo = Math.min(lo, value);
        hi = Math.max(hi, value);
      }
    }
    if (!Number.isFinite(lo) || hi - lo < 0.00001) throw new Error("No clear subject was detected. Try an image with a distinct foreground");
    const floor = cleanup * 0.42;
    const ceiling = 0.76 + cleanup * 0.16;
    for (let i = 0; i < area; i++) {
      const confidence = (mask[i] - lo) / (hi - lo);
      const alpha = clamp((confidence - floor) / (ceiling - floor), 0, 1);
      rgb[i * 4 + 3] = 255 * alpha * alpha * (3 - 2 * alpha);
    }
    ctx.putImageData(pixels, 0, 0);
    drawToCanvas(canvas, bitmap, bitmap.width, bitmap.height, "image/png", "", false);
    const result = canvas.getContext("2d");
    result.globalCompositeOperation = "destination-in";
    result.drawImage(sample, left, top, sampleWidth, sampleHeight, 0, 0, canvas.width, canvas.height);
    return await toBlob(canvas, "image/png");
  } finally {
    input?.dispose();
    if (outputs) Object.values(outputs).forEach(tensor => tensor.dispose());
    releaseCanvas(sample);
    releaseCanvas(canvas);
  }
}

async function removeBackgrounds(files, onProgress) {
  onProgress(1);
  const cleanup = Number(backgroundEdge.value) / 100;
  const session = await getBackgroundSession();
  let firstOriginal;
  const result = await runBatch(files, onProgress, async (file, image) => {
    const blob = await removeBackground(image, session, cleanup);
    firstOriginal ??= file;
    return { blob, name: stem(file) + "-transparent.png" };
  }, "transparent-images");
  return { ...result, previewOriginal: firstOriginal };
}

/* --- PDF page editor --- */
function pdfPreview(label) {
  const canvas = h("canvas", { class: "editor-canvas", "aria-label": label, hidden: "" });
  const info = h("p", { class: "fine editor-info", role: "status" });
  const surface = h("div", { class: "editor-surface", hidden: "" }, canvas);
  let token = 0, queue = Promise.resolve();
  function show(file, number, rotation = 0, onReady) {
    const version = ++token;
    surface.hidden = canvas.hidden = true;
    releaseCanvas(canvas);
    info.textContent = file ? "Loading page preview…" : "";
    if (!file) return;
    queue = queue.then(async () => {
      if (token !== version) return;
      const temp = document.createElement("canvas");
      try {
        await withPdfSource(file, async source => {
          const page = await source.getPage(number);
          try { await renderPdfCanvas(page, temp, 1.5, 720, page.rotate + rotation); }
          finally { page.cleanup(); }
        });
        if (token !== version) return;
        canvas.width = temp.width;
        canvas.height = temp.height;
        canvas.getContext("2d").drawImage(temp, 0, 0);
        surface.hidden = canvas.hidden = false;
        info.textContent = "";
        onReady?.();
      } catch (err) {
        if (token === version) info.textContent = err.message || "Could not preview this page.";
      } finally { releaseCanvas(temp); }
    });
  }
  return { canvas, surface, info, show };
}

const edited = element => element.dispatchEvent(new Event("fileroom-edit", { bubbles: true }));

const organize = {};
function organizeOptions() {
  organize.list = h("select", { class: "field page-order", size: "5", "aria-label": "PDF page order" });
  organize.preview = pdfPreview("Selected PDF page preview");
  organize.info = h("p", { class: "fine editor-info", role: "status" });

  function reorder(direction) {
    const i = organize.list.selectedIndex;
    const next = i + direction;
    if (i < 0 || next < 0 || next >= organize.pages.length) return;
    [organize.pages[i], organize.pages[next]] = [organize.pages[next], organize.pages[i]];
    updateOrganize(next);
    edited(organize.list);
  }
  function rotate(direction) {
    const selected = organize.pages[organize.list.selectedIndex];
    if (!selected) return;
    selected.rotation = (selected.rotation + direction + 360) % 360;
    updateOrganize(organize.list.selectedIndex);
    edited(organize.list);
  }
  organize.up = h("button", { class: "mini", type: "button", onclick: () => reorder(-1) }, "Move up");
  organize.down = h("button", { class: "mini", type: "button", onclick: () => reorder(1) }, "Move down");
  organize.left = h("button", { class: "mini", type: "button", onclick: () => rotate(-90) }, "Rotate left");
  organize.right = h("button", { class: "mini", type: "button", onclick: () => rotate(90) }, "Rotate right");
  organize.remove = h("button", { class: "mini", type: "button", onclick: () => {
    const i = organize.list.selectedIndex;
    if (i < 0 || organize.pages.length < 2) return;
    organize.pages.splice(i, 1);
    updateOrganize(Math.min(i, organize.pages.length - 1));
    edited(organize.list);
  } }, "Delete page");
  organize.reset = h("button", { class: "mini", type: "button", onclick: () => {
    organize.pages = originalPages(organize.count);
    updateOrganize(0);
    edited(organize.list);
  } }, "Reset pages");
  organize.list.addEventListener("change", refreshOrganizePreview);
  organize.editor = h("div", { class: "page-editor", hidden: "" },
    h("div", { class: "opt-stack" }, organize.list,
      h("div", { class: "editor-actions" }, organize.up, organize.down, organize.left, organize.right, organize.remove, organize.reset)),
    h("div", { class: "opt-stack" }, organize.preview.surface, organize.preview.info));
  return h("div", { class: "opt-stack" }, h("span", {}, "Select a page to preview, move, rotate, or delete it."), organize.info, organize.editor);
}
const originalPages = count => Array.from({ length: count }, (_, index) => ({ index, rotation: 0 }));

function updateOrganize(index) {
  const options = document.createDocumentFragment();
  for (const page of organize.pages) {
    options.append(opt(String(page.index), "Page " + (page.index + 1) + (page.rotation ? " · rotated " + page.rotation + "°" : "")));
  }
  organize.list.replaceChildren(options);
  organize.list.selectedIndex = index;
  organize.editor.hidden = !organize.pages.length;
  refreshOrganizePreview();
}

function refreshOrganizePreview() {
  const i = organize.list.selectedIndex, page = organize.pages[i];
  organize.up.disabled = i <= 0;
  organize.down.disabled = i < 0 || i >= organize.pages.length - 1;
  organize.left.disabled = organize.right.disabled = !page;
  organize.remove.disabled = i < 0 || organize.pages.length < 2;
  organize.preview.show(page ? organize.file : null, page ? page.index + 1 : 0, page?.rotation);
}

function organizeOnFiles(files) {
  const file = files[0];
  if (organize.file === file) return;
  organize.file = file;
  organize.count = 0;
  organize.pages = [];
  updateOrganize(-1);
  organize.info.textContent = file ? "Reading pages…" : "";
  organize.pending = file && loadPdf(file, { updateMetadata: false }).then(doc => {
    if (organize.file !== file) return;
    organize.count = doc.getPageCount();
    organize.pages = originalPages(organize.count);
    organize.info.textContent = organize.count + (organize.count === 1 ? " page" : " pages");
    updateOrganize(0);
  }).catch(err => {
    if (organize.file === file) organize.info.textContent = err.message;
  });
}

async function organizePdf(files, progress) {
  await organize.pending;
  const doc = await loadPdf(files[0], { updateMetadata: false });
  const saved = organize.pages.map(page => ({ ...page }));
  if (!saved.length) throw new Error("Keep at least one page");
  const pages = doc.getPages().slice();
  for (let i = pages.length - 1; i >= 0; i--) doc.removePage(i);
  for (const item of saved) {
    const page = pages[item.index];
    page.setRotation(PDFLib.degrees((page.getRotation().angle + item.rotation + 360) % 360));
    doc.addPage(page);
  }
  progress(70);
  const blob = pdfBlob(await doc.save({ updateFieldAppearances: false }));
  progress(100);
  return { blob, filename: baseName(files[0]) + "-organized.pdf", summary: saved.length + (saved.length === 1 ? " page" : " pages") };
}

/* --- Image crop --- */
const cropUI = {};
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
function pointerFraction(event, surface) {
  const bounds = surface.getBoundingClientRect();
  return [clamp((event.clientX - bounds.left) / bounds.width, 0, 1),
    clamp((event.clientY - bounds.top) / bounds.height, 0, 1)];
}

function dragPdfOverlay(surface, overlay, place, resize) {
  surface.classList.add("pdf-placement");
  let drag;
  function move(event) {
    if (event.pointerId !== drag?.id) return;
    const bounds = surface.getBoundingClientRect();
    if (drag.resize) {
      resize(drag.width + 100 * (event.clientX - drag.start) / bounds.width);
      const box = overlay.getBoundingClientRect();
      place(clamp(drag.left + box.width / bounds.width / 2, 0, 1),
        clamp(drag.top + box.height / bounds.height / 2, 0, 1));
      return;
    }
    place(
      clamp((event.clientX - bounds.left) / bounds.width - drag.x, 0, 1),
      clamp((event.clientY - bounds.top) / bounds.height - drag.y, 0, 1)
    );
  }
  surface.addEventListener("pointerdown", event => {
    if (!event.isPrimary || event.button !== 0 || overlay.hidden || surface.closest('[aria-busy="true"]')) return;
    const box = overlay.getBoundingClientRect(), bounds = surface.getBoundingClientRect();
    const grabbing = overlay.contains(event.target);
    drag = {
      id: event.pointerId, resize: Boolean(resize && event.target.closest(".resize-grip")),
      width: 100 * box.width / bounds.width, start: event.clientX,
      left: (box.left - bounds.left) / bounds.width, top: (box.top - bounds.top) / bounds.height,
      x: grabbing ? (event.clientX - box.left - box.width / 2) / bounds.width : 0,
      y: grabbing ? (event.clientY - box.top - box.height / 2) / bounds.height : 0
    };
    surface.setPointerCapture(event.pointerId);
    if (!grabbing) move(event);
  });
  surface.addEventListener("pointermove", move);
  surface.addEventListener("lostpointercapture", () => { drag = null; });
}

function positionPdfOverlay(overlay, canvas, [x, y, width, height]) {
  overlay.style.left = (100 * x / canvas.width) + "%";
  overlay.style.top = (100 * y / canvas.height) + "%";
  overlay.style.width = (100 * width / canvas.width) + "%";
  overlay.style.height = (100 * height / canvas.height) + "%";
}
function cropOptions() {
  cropUI.canvas = h("canvas", { class: "editor-canvas", "aria-label": "Image crop preview" });
  cropUI.frame = h("div", { class: "crop-frame", "aria-hidden": "true" });
  cropUI.surface = h("div", { class: "editor-surface crop-surface" }, cropUI.canvas, cropUI.frame);
  cropUI.preset = h("select", { class: "field", "aria-label": "Crop aspect ratio" },
    opt("free", "Free crop"), opt("1", "Square (1:1)"), opt("0.8", "Portrait (4:5)"),
    opt("0.5625", "Story (9:16)"), opt(String(16/9), "Widescreen (16:9)"), opt("1.5", "Photo (3:2)"));
  cropUI.numbers = ["Left", "Top", "Width", "Height"].map(name =>
    h("input", { type: "number", class: "field", min: name === "Left" || name === "Top" ? "0" : "1",
      step: "1", "aria-label": "Crop " + name.toLowerCase() }));
  cropUI.info = h("p", { class: "fine editor-info", role: "status" });
  cropUI.controls = h("div", { class: "opt-stack", hidden: "" },
    h("label", {}, "Aspect ratio ", cropUI.preset),
    cropUI.surface,
    h("div", { class: "pixel-fields" }, cropUI.numbers.map((field, index) => h("label", {},
      ["Left (px)", "Top (px)", "Width (px)", "Height (px)"][index], field))));
  cropUI.preset.addEventListener("change", () => {
    centerCrop();
    edited(cropUI.preset);
  });
  for (const field of cropUI.numbers) {
    field.addEventListener("input", () => {
      cropUI.preset.value = "free";
      applyCrop(...cropUI.numbers.map(input => input.valueAsNumber), false);
      edited(field);
    });
    field.addEventListener("change", syncCropNumbers);
  }
  let anchor, dragId;
  cropUI.surface.addEventListener("pointerdown", event => {
    if (!cropUI.width || !event.isPrimary || event.button !== 0 || cropUI.surface.closest('[aria-busy="true"]')) return;
    anchor = pointerFraction(event, cropUI.surface);
    dragId = event.pointerId;
    cropUI.surface.setPointerCapture(dragId);
  });
  cropUI.surface.addEventListener("pointermove", event => {
    if (!anchor || event.pointerId !== dragId) return;
    const [x, y] = pointerFraction(event, cropUI.surface);
    const [startX, startY] = anchor;
    const { width, height } = cropUI;
    const ratio = Number(cropUI.preset.value);
    let w = Math.abs(x - startX) * width, ht = Math.abs(y - startY) * height;
    if (ratio) {
      w = Math.min(w, ht * ratio);
      ht = w / ratio;
    }
    if (w < 1 || ht < 1) return;
    applyCrop(startX * width - (x < startX ? w : 0), startY * height - (y < startY ? ht : 0), w, ht);
    edited(cropUI.surface);
  });
  for (const name of ["pointerup", "pointercancel", "lostpointercapture"]) {
    cropUI.surface.addEventListener(name, event => { if (event.pointerId === dragId) anchor = null; });
  }
  return h("div", { class: "opt-stack" },
    h("span", {}, "Drag to select an area, choose a preset, or enter exact pixel bounds."), cropUI.info, cropUI.controls);
}

function syncCropNumbers() {
  if (cropUI.rect) cropUI.numbers.forEach((field, index) => { field.value = cropUI.rect[index]; });
}

function applyCrop(x, y, w, ht, updateFields = true) {
  const { width, height } = cropUI;
  if (![x, y, w, ht].every(Number.isFinite)) return;
  x = clamp(Math.round(x), 0, width - 1);
  y = clamp(Math.round(y), 0, height - 1);
  w = clamp(Math.round(w), 1, width - x);
  ht = clamp(Math.round(ht), 1, height - y);
  cropUI.rect = [x, y, w, ht];
  if (updateFields) syncCropNumbers();
  const style = cropUI.frame.style;
  style.left = (x / width * 100) + "%";
  style.top = (y / height * 100) + "%";
  style.width = (w / width * 100) + "%";
  style.height = (ht / height * 100) + "%";
  cropUI.info.textContent = "Crop size " + w + " × " + ht + " px";
}

function centerCrop() {
  const { width, height } = cropUI, ratio = Number(cropUI.preset.value);
  const w = ratio ? Math.min(width, height * ratio) : width;
  const ht = ratio ? w / ratio : height;
  applyCrop((width - w) / 2, (height - ht) / 2, w, ht);
}

function cropOnFiles(files) {
  const file = files[0];
  if (cropUI.file === file) return;
  cropUI.file = file;
  cropUI.rect = null;
  cropUI.width = 0;
  cropUI.controls.hidden = true;
  cropUI.info.textContent = file ? "Preparing image preview…" : "";
  releaseCanvas(cropUI.canvas);
  cropUI.pending = file && (async () => {
    let bitmap;
    try {
      bitmap = await loadImage(file);
      if (file !== cropUI.file) return;
      cropUI.width = bitmap.width;
      cropUI.height = bitmap.height;
      const scale = Math.min(1, 720 / Math.max(bitmap.width, bitmap.height));
      drawToCanvas(cropUI.canvas, bitmap, Math.max(1, Math.round(bitmap.width * scale)),
        Math.max(1, Math.round(bitmap.height * scale)), "image/png", "", false);
      cropUI.controls.hidden = false;
      centerCrop();
    } catch (err) {
      if (file === cropUI.file) cropUI.info.textContent = err.message;
    } finally { bitmap?.close(); }
  })();
}

async function cropImage(files, progress) {
  await cropUI.pending;
  if (!cropUI.rect) throw new Error("Add an image and select a crop area");
  if (cropUI.numbers.some(field => !Number.isInteger(field.valueAsNumber))) throw new Error("Enter all four crop bounds in whole pixels");
  const file = files[0], [x, y, w, ht] = cropUI.rect;
  if (w > 16000 || ht > 16000 || w * ht > MAX_CANVAS_PIXELS) throw new Error("Select a smaller crop area");
  const bitmap = await loadImage(file), canvas = document.createElement("canvas");
  try {
    canvas.width = w;
    canvas.height = ht;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("The browser could not allocate an image canvas");
    ctx.drawImage(bitmap, x, y, w, ht, 0, 0, w, ht);
    progress(75);
    const type = IMG_TYPES.includes(file.type) ? file.type : "image/png";
    const blob = await toBlob(canvas, type, 0.95);
    progress(100);
    return { blob, filename: stem(file) + "-cropped." + extOf(type), summary: w + " × " + ht + " px" };
  } finally {
    releaseCanvas(canvas);
    bitmap.close();
  }
}

/* --- Visible signatures --- */
const signUI = { ink: null, inkVersion: 0, inkTask: Promise.resolve() };
function signOptions() {
  const pad = signUI.pad = h("canvas", { class: "sign-pad", width: "600", height: "160", "aria-label": "Signature drawing pad" });
  const upload = h("input", { class: "field", type: "file", accept: IMG_ACCEPT, "aria-label": "Upload signature image" });
  const removePaper = h("input", { type: "checkbox", checked: "" });
  const clear = h("button", { class: "mini", type: "button", onclick: () => {
    ++signUI.inkVersion;
    signUI.ink = null;
    signUI.inkTask = Promise.resolve();
    pad.getContext("2d").clearRect(0, 0, pad.width, pad.height);
    upload.value = "";
    signUI.inkInfo.textContent = "Signature cleared.";
    updateSignatureMarker();
    edited(pad);
  } }, "Clear signature");
  signUI.inkInfo = h("p", { class: "fine editor-info", role: "status" });
  signUI.page = h("input", { class: "field", type: "number", min: "1", step: "1", value: "1", "aria-label": "Signature page number" });
  signUI.x = h("input", { class: "field", type: "number", min: "0", max: "100", step: "0.01", value: "75", "aria-label": "Signature horizontal position" });
  signUI.y = h("input", { class: "field", type: "number", min: "0", max: "100", step: "0.01", value: "87", "aria-label": "Signature vertical position" });
  signUI.size = h("input", { class: "field", type: "number", min: "5", max: "85", value: "25", "aria-label": "Signature width" });
  const slider = h("input", { class: "placement-slider", type: "range", min: "5", max: "85", value: "25", "aria-label": "Resize signature" });
  signUI.preview = pdfPreview("PDF signature placement preview");
  signUI.marker = h("img", { alt: "", draggable: "false" });
  const grip = h("span", { class: "resize-grip", "aria-hidden": "true" }, "↘");
  signUI.overlay = h("div", { class: "pdf-overlay", hidden: "" }, signUI.marker, grip);
  signUI.preview.surface.append(signUI.overlay);
  signUI.pageInfo = h("p", { class: "fine editor-info", role: "status" });

  const ctx = pad.getContext("2d", { willReadFrequently: true });
  let last, drawingId;
  function draw(event) {
    const [x, y] = pointerFraction(event, pad);
    const position = [x * pad.width, y * pad.height];
    ctx.strokeStyle = "#172345";
    ctx.fillStyle = ctx.strokeStyle;
    ctx.lineWidth = 4;
    ctx.lineCap = "round";
    ctx.beginPath();
    if (last) {
      ctx.moveTo(...last);
      ctx.lineTo(...position);
      ctx.stroke();
    } else {
      ctx.arc(...position, 2, 0, Math.PI * 2);
      ctx.fill();
    }
    last = position;
  }
  pad.addEventListener("pointerdown", event => {
    if (!event.isPrimary || event.button !== 0 || pad.closest('[aria-busy="true"]')) return;
    last = null;
    drawingId = event.pointerId;
    pad.setPointerCapture(drawingId);
    draw(event);
    edited(pad);
  });
  pad.addEventListener("pointermove", event => { if (last && event.pointerId === drawingId) draw(event); });
  for (const name of ["pointerup", "pointercancel", "lostpointercapture"]) {
    pad.addEventListener(name, event => {
      if (!last || event.pointerId !== drawingId) return;
      last = null;
      setSignature(() => signatureFromCanvas(pad), "Drawn signature ready.");
      upload.value = "";
    });
  }
  upload.addEventListener("change", () => {
    const file = upload.files[0];
    upload.value = "";
    if (!file) return;
    if (!matches(file, IMG_ACCEPT) || file.size > fileLimit(file)) {
      signUI.inkInfo.textContent = "Choose a JPG, PNG, or WebP under 25 MB.";
      return;
    }
    edited(upload);
    const cleanPaper = removePaper.checked;
    setSignature(async () => {
      const bitmap = await loadImage(file), canvas = document.createElement("canvas");
      try {
        const scale = Math.min(1, 1400 / bitmap.width, 600 / bitmap.height);
        drawToCanvas(canvas, bitmap, Math.max(1, Math.round(bitmap.width * scale)),
          Math.max(1, Math.round(bitmap.height * scale)), "image/png", "", false);
        return await signatureFromCanvas(canvas, cleanPaper);
      } finally {
        bitmap.close();
        releaseCanvas(canvas);
      }
    }, "Uploaded signature ready.", () => ctx.clearRect(0, 0, pad.width, pad.height));
  });
  signUI.page.addEventListener("change", () => {
    refreshSignPage();
    edited(signUI.page);
  });
  for (const field of [signUI.x, signUI.y, signUI.size]) field.addEventListener("input", () => {
    if (signUI.size.validity.valid && signUI.size.value) slider.value = signUI.size.value;
    updateSignatureMarker();
    edited(field);
  });
  const surface = signUI.preview.surface;
  function resizeSignature(width) {
    signUI.size.value = slider.value = Math.round(clamp(width, 5, 85));
    updateSignatureMarker();
    edited(surface);
  }
  slider.addEventListener("input", () => resizeSignature(Number(slider.value)));
  dragPdfOverlay(surface, signUI.overlay, (x, y) => {
    signUI.x.value = (x * 100).toFixed(2);
    signUI.y.value = (y * 100).toFixed(2);
    updateSignatureMarker();
    edited(surface);
  }, resizeSignature);

  return h("div", { class: "opt-stack" },
    h("span", {}, "Draw your signature or upload a signature image."),
    pad, h("div", { class: "editor-actions" }, clear, h("label", {}, "Upload signature ", upload)), signUI.inkInfo,
    h("label", { class: "fine" }, removePaper, " Remove white paper from the next signature upload"),
    h("div", { class: "pixel-fields" },
      h("label", {}, "Page number", signUI.page), h("label", {}, "Across (%)", signUI.x),
      h("label", {}, "Down (%)", signUI.y), h("label", {}, "Width (%)", signUI.size)),
    signUI.pageInfo,
    h("label", {}, "Resize signature ", slider),
    h("span", { class: "fine" }, "Drag the signature to move it. Drag its corner or use the slider to resize it."),
    signUI.preview.surface, signUI.preview.info);
}

function setSignature(makeInk, success, onReady) {
  const version = ++signUI.inkVersion;
  signUI.ink = null;
  updateSignatureMarker();
  signUI.inkInfo.textContent = "Preparing signature…";
  signUI.inkTask = (async () => {
    try {
      const ink = await makeInk();
      if (signUI.inkVersion !== version) return;
      signUI.ink = ink;
      signUI.inkInfo.textContent = success;
      onReady?.();
      previewImage(signUI.marker, ink.blob).catch(() => {});
      updateSignatureMarker();
    } catch (err) {
      if (signUI.inkVersion === version) signUI.inkInfo.textContent = err.message;
    }
  })();
}

async function signatureFromCanvas(canvas, removePaper = false) {
  const { width, height } = canvas;
  const ctx = canvas.getContext("2d");
  const pixels = ctx.getImageData(0, 0, width, height);
  const rgba = pixels.data;
  if (removePaper) {
    for (let i = 0; i < rgba.length; i += 4) {
      const white = Math.min(rgba[i], rgba[i + 1], rgba[i + 2]);
      if (white >= 240) {
        rgba[i + 3] = 0;
      } else if (rgba[i + 3] === 255) {
        const alpha = 1 - white / 255;
        for (let channel = 0; channel < 3; channel++) rgba[i + channel] = (rgba[i + channel] - white) / alpha;
        rgba[i + 3] = Math.round(255 * alpha);
      }
    }
    ctx.putImageData(pixels, 0, 0);
  }
  let left = width, top = height, right = -1, bottom = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!rgba[(y * width + x) * 4 + 3]) continue;
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
    }
  }
  if (right < 0) throw new Error("The signature image is empty");
  const trimmed = document.createElement("canvas");
  try {
    trimmed.width = right - left + 1;
    trimmed.height = bottom - top + 1;
    trimmed.getContext("2d").drawImage(canvas, left, top, trimmed.width, trimmed.height, 0, 0, trimmed.width, trimmed.height);
    return { width: trimmed.width, height: trimmed.height, blob: await toBlob(trimmed, "image/png") };
  } finally { releaseCanvas(trimmed); }
}

function signOnFiles(files) {
  const file = files[0];
  if (signUI.file === file) return;
  signUI.file = file;
  signUI.pages = 0;
  signUI.page.value = "1";
  signUI.page.removeAttribute("max");
  signUI.preview.show(null);
  signUI.pageInfo.textContent = file ? "Reading pages…" : "";
  signUI.pending = file && loadPdf(file, { updateMetadata: false }).then(doc => {
    if (signUI.file !== file) return;
    signUI.pages = doc.getPageCount();
    signUI.page.max = signUI.pages;
    signUI.pageInfo.textContent = signUI.pages === 1 ? "This PDF has one page." : "Choose from " + signUI.pages + " pages.";
    refreshSignPage();
  }).catch(err => {
    if (signUI.file === file) signUI.pageInfo.textContent = err.message;
  });
}

function refreshSignPage() {
  const n = signUI.page.valueAsNumber;
  const valid = signUI.file && Number.isInteger(n) && n >= 1 && n <= signUI.pages;
  signUI.preview.show(valid ? signUI.file : null, n, 0, updateSignatureMarker);
}

function signatureSettings() {
  const fields = [signUI.x, signUI.y, signUI.size];
  if (fields.some(field => !field.validity.valid || !Number.isFinite(field.valueAsNumber))) return null;
  return fields.map(field => field.valueAsNumber / 100);
}

function signatureBox(width, height, ink, settings) {
  const [x, y, size] = settings;
  const ratio = ink.width / ink.height;
  const w = Math.min(width * size, height * ratio);
  const h = w / ratio;
  return [clamp(width * x - w / 2, 0, width - w), clamp(height * y - h / 2, 0, height - h), w, h];
}

function updateSignatureMarker() {
  const { canvas, surface } = signUI.preview;
  const settings = signatureSettings();
  signUI.overlay.hidden = !signUI.ink || surface.hidden || !settings;
  if (signUI.overlay.hidden) return;
  positionPdfOverlay(signUI.overlay, canvas, signatureBox(canvas.width, canvas.height, signUI.ink, settings));
}

async function signPdf(files, progress) {
  await signUI.pending;
  await signUI.inkTask;
  if (!signUI.ink) throw new Error("Draw or upload a signature first");
  const settings = signatureSettings();
  if (!settings) throw new Error("Enter valid signature position and size values");
  const file = files[0], doc = await loadPdf(file, { updateMetadata: false });
  const number = signUI.page.valueAsNumber;
  if (!Number.isInteger(number) || number < 1 || number > doc.getPageCount()) throw new Error("Choose a valid page number");
  const page = doc.getPage(number - 1), crop = page.getCropBox();
  const angle = ((page.getRotation().angle % 360) + 360) % 360;
  const sideways = angle === 90 || angle === 270;
  const width = sideways ? crop.height : crop.width, height = sideways ? crop.width : crop.height;
  const [x, top, w, ht] = signatureBox(width, height, signUI.ink, settings);
  const y = height - top - ht;
  const corners = { 0: [x, y], 90: [crop.width - y, x], 180: [crop.width - x, crop.height - y], 270: [y, crop.height - x] };
  const [px, py] = corners[angle] || corners[0];
  const image = await doc.embedPng(await signUI.ink.blob.arrayBuffer());
  page.drawImage(image, { x: crop.x + px, y: crop.y + py, width: w, height: ht, rotate: PDFLib.degrees(angle) });
  progress(75);
  const blob = pdfBlob(await doc.save({ updateFieldAppearances: false }));
  progress(100);
  return { blob, filename: baseName(file) + "-signed.pdf", summary: "Signature placed on page " + number };
}

/* --- Copy text from images and PDFs --- */
const TESS_BASE = assetUrl("ocr/", "https://cdn.jsdelivr.net/npm/tesseract.js@6.0.1/dist/");
const TESS_CORE = assetUrl("ocr/", "https://cdn.jsdelivr.net/npm/tesseract.js-core@6.0.0");
const ocrUI = {};
function ocrOptions() {
  ocrUI.mode = h("select", { class: "field", "aria-label": "PDF text extraction mode" },
    opt("auto", "Use selectable text when available"), opt("scan", "Run OCR on every page"));
  ocrUI.language = h("select", { class: "field", "aria-label": "OCR language" },
    opt("eng", "English"), opt("spa", "Spanish"), opt("fra", "French"), opt("deu", "German"), opt("por", "Portuguese"));
  return h("div", { class: "opt-stack" },
    h("label", {}, "PDF mode ", ocrUI.mode), h("label", {}, "OCR language ", ocrUI.language),
    h("span", { class: "fine" }, "Photos and scanned pages need a one-time OCR download for the selected language. Your files stay on your device."));
}

async function createOcrWorker(language) {
  if (!window.Tesseract && !await loadVerifiedScript(TESS_BASE + "tesseract.min.js", "sha384-r1ru3tcf6FhnCFR4B7pIFG+BhFF9LlFtz/P1y4pblWn3AGs9y3lBx5SKLNf4+rED", "Tesseract", 15000)) {
    throw new Error("Could not load OCR. Check your internet connection and try again");
  }
  const response = await fetch(TESS_BASE + "worker.min.js", {
    credentials: "omit", integrity: "sha384-Xz8ctHtZgH/eWwOqd6igOU/kepnilz4dowW84REE2KL9DtDbxEnd/xxYhzBhNCzd", signal: AbortSignal.timeout(20000)
  }).catch(() => null);
  if (!response?.ok) throw new Error("Could not download the OCR worker. Check your connection and try again");
  const url = URL.createObjectURL(await response.blob());
  let timedOut = false, timer, rejectInit;
  const failure = new Promise((_, reject) => { rejectInit = reject; });
  timer = setTimeout(() => {
    timedOut = true;
    rejectInit(new Error("OCR setup timed out. Check your internet connection and try again"));
  }, 60000);
  const pending = Tesseract.createWorker(language, 1, {
    workerPath: url, workerBlobURL: false, corePath: TESS_CORE,
    langPath: assetUrl("ocr", "https://tessdata.projectnaptha.com/4.0.0"),
    errorHandler: () => rejectInit(new Error("Could not initialize OCR. Check your connection and try again"))
  }).then(async worker => {
    if (timedOut) {
      await worker.terminate();
      throw new Error("OCR setup timed out");
    }
    return worker;
  });
  try {
    return await Promise.race([pending, failure]);
  } catch (err) {
    throw new Error(err.message || "Could not initialize OCR. Check your connection and try again");
  } finally {
    clearTimeout(timer);
    URL.revokeObjectURL(url);
  }
}

function joinPdfText(items) {
  let result = "", previousY;
  for (const item of items) {
    if (typeof item.str !== "string") continue;
    const y = item.transform?.[5];
    if (result && !result.endsWith("\n")) {
      if (previousY != null && y != null && Math.abs(y - previousY) > Math.max(3, (item.height || 0) * 0.6)) result += "\n";
      else if (item.str && !/\s$/.test(result) && !/^\s/.test(item.str)) result += " ";
    }
    result += item.str;
    if (item.hasEOL && !result.endsWith("\n")) result += "\n";
    previousY = item.hasEOL ? undefined : y;
  }
  return result.trim();
}

async function extractText(files, progress) {
  const file = files[0], language = ocrUI.language.value, forceScan = ocrUI.mode.value === "scan";
  let worker;
  async function recognize(canvas) {
    worker ||= await createOcrWorker(language);
    try {
      const { data } = await worker.recognize(canvas);
      return data.text.trim();
    } catch {
      throw new Error("Could not read text from this image or page");
    }
  }
  let text;
  try {
    progress(1);
    if (isPdfFile(file)) {
      text = await withPdfSource(file, async source => {
        const sections = [];
        for (let n = 1; n <= source.numPages; n++) {
          const page = await source.getPage(n), canvas = document.createElement("canvas");
          try {
            let value = forceScan ? "" : joinPdfText((await page.getTextContent()).items);
            if (!value) {
              await renderPdfCanvas(page, canvas, 2.5, 2600, page.rotate);
              value = await recognize(canvas);
            }
            sections.push(value);
          } finally {
            releaseCanvas(canvas);
            page.cleanup();
          }
          progress(Math.round(n / source.numPages * 95));
        }
        if (!sections.some(Boolean)) return "";
        return sections.length === 1 ? sections[0] :
          sections.map((value, index) => "Page " + (index + 1) + "\n" + (value || "[No readable text]")).join("\n\n");
      });
    } else {
      const canvas = document.createElement("canvas"), bitmap = await loadImage(file);
      try {
        const scale = Math.min(1, 2800 / Math.max(bitmap.width, bitmap.height));
        drawToCanvas(canvas, bitmap, Math.max(1, Math.round(bitmap.width * scale)),
          Math.max(1, Math.round(bitmap.height * scale)), "image/jpeg", "#ffffff", false);
        text = await recognize(canvas);
      } finally {
        bitmap.close();
        releaseCanvas(canvas);
      }
    }
  } finally {
    if (worker) await worker.terminate();
  }
  if (!text) throw new Error("No readable text was found. Try a sharper image or a different OCR language");
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  progress(100);
  return { text, blob, filename: stem(file) + "-text.txt", dlLabel: "Download text", summary: text.trim().split(/\s+/).length + " words" };
}


const TOOLS = [
  { id: "merge-pdf", title: "PDF Combiner", group: "pdf", size: "w4",
    blurb: "Combine several PDFs into one file, in the order you choose.",
    accept: ".pdf,application/pdf", multiple: true, action: "Merge files",
    reorder: true, options: "Use Up, Down, and Remove to arrange the files. They are merged from top to bottom.", process: mergePdfs },

  { id: "split-pdf", title: "Split PDF", group: "pdf",
    blurb: "Pull out pages or split a document into parts.",
    accept: ".pdf,application/pdf", multiple: false, action: "Split file",
    options: splitOptions, onFiles: splitOnFiles, process: splitPdf },

  { id: "compress-pdf", title: "PDF Compressor", group: "pdf",
    blurb: "Repack a PDF without losing text, or rasterize pages to reduce image-heavy PDFs.",
    accept: ".pdf,application/pdf", multiple: false, action: "Compress file",
    options: compressOptions, process: compressPdf },

  { id: "compress-image", title: "Image Compressor", group: "img", size: "w4",
    blurb: "Reduce image file size or fit a limit such as 100 KB.",
    accept: IMG_ACCEPT, multiple: true, action: "Compress images",
    options: imgCompressOptions, onFiles: imgCompressOnFiles, beforeRun: stopPreview, process: compressImages },

  { id: "resize-image", title: "Image Resizer", group: "img", size: "w3",
    blurb: "Change width and height, or use a preset for forms and photos.",
    accept: IMG_ACCEPT, multiple: true, action: "Resize images",
    options: resizeOptions, onFiles: resizeOnFiles, process: resizeImages },

  { id: "convert-image", title: "Image Format Converter", group: "img", size: "w3",
    blurb: "Switch between JPG, PNG, and WebP.",
    accept: IMG_ACCEPT, multiple: true, action: "Convert images",
    options: convertOptions, process: convertImages },

  { id: "pdf-to-jpg", title: "PDF to JPG", group: "pdf",
    blurb: "Export every PDF page as a JPG at your chosen resolution.",
    accept: PDF_ACCEPT, multiple: false, action: "Convert PDF to JPG",
    options: pdfJpgOptions, process: pdfToJpg },

  { id: "watermark", title: "Watermark", group: "pdf", groups: ["pdf", "img"], size: "w4",
    blurb: "Add a custom text watermark to PDFs or images.",
    accept: PDF_ACCEPT + "," + IMG_ACCEPT, multiple: true, action: "Apply watermark",
    options: watermarkOptions, onFiles: watermarkOnFiles, process: addWatermarks },

  { id: "background-remover", title: "Background Remover", group: "img",
    blurb: "Isolate a subject and save it on a transparent background.",
    accept: IMG_ACCEPT, multiple: true, action: "Remove background",
    options: backgroundOptions,
    process: removeBackgrounds },

  { id: "jpg-to-pdf", title: "JPG to PDF", group: "pdf", groups: ["pdf", "img"], size: "w4",
    blurb: "Combine JPG, PNG, or WebP images into one ordered PDF.",
    accept: IMG_ACCEPT, multiple: true, reorder: true, action: "Create PDF",
    options: imagePdfOptions, process: imagesToPdf },

  { id: "organize-pdf", title: "Organize PDF", group: "pdf", size: "w3",
    blurb: "Preview, reorder, rotate, or delete pages and save a new PDF.",
    accept: PDF_ACCEPT, multiple: false, action: "Save organized PDF",
    options: organizeOptions, onFiles: organizeOnFiles, process: organizePdf },

  { id: "crop-image", title: "Crop Image", group: "img", size: "w3",
    blurb: "Crop freely, enter exact dimensions, or choose an aspect ratio.",
    accept: IMG_ACCEPT, multiple: false, action: "Crop image",
    options: cropOptions, onFiles: cropOnFiles, process: cropImage },

  { id: "extract-text", title: "OCR / Extract Text", group: "pdf", groups: ["pdf", "img"], size: "w3",
    blurb: "Copy text from photos, documents, and scanned PDF pages.",
    accept: PDF_ACCEPT + "," + IMG_ACCEPT, multiple: false, action: "Extract text",
    options: ocrOptions, process: extractText },

  { id: "sign-pdf", title: "Sign PDF", group: "pdf", size: "w3",
    blurb: "Draw or upload a signature and place it on a PDF page.",
    accept: PDF_ACCEPT, multiple: false, action: "Save signed PDF",
    options: signOptions, onFiles: signOnFiles, process: signPdf }
];

/* =====================================================================
   4. VIEWS (home + one panel per tool). Built lazily, then cached so that
   switching tabs is instant and keeps each tool's state.
   ===================================================================== */
function buildHome() {
  const searchTerms = {
    "merge-pdf": "combine join",
    "split-pdf": "extract separate pages",
    "compress-pdf": "reduce shrink smaller",
    "compress-image": "photo picture jpg png webp reduce shrink smaller",
    "resize-image": "photo picture pixels dimensions crop",
    "convert-image": "photo picture jpeg jpg png webp change format",
    "pdf-to-jpg": "pdf jpeg image picture export convert pages",
    "watermark": "stamp label text overlay pdf image photo",
    "background-remover": "cutout cut out isolate subject erase transparent background photo",
    "jpg-to-pdf": "convert jpg jpeg png webp photos scan document combine images pdf pages",
    "organize-pdf": "arrange order move remove delete rotate preview pdf pages",
    "crop-image": "trim cut photo picture pixels aspect ratio square portrait",
    "extract-text": "ocr copy text scan scanned photos recognize recognition pdf image",
    "sign-pdf": "signature autograph draw upload place electronic sign pdf"
  };
  const cards = TOOLS.map(tool => {
    const category = tool.groups ? "PDF & Image" : tool.group === "pdf" ? "PDF" : "Image";
    const link = h("a", { class: "card " + tool.group + (tool.size ? " " + tool.size : ""), href: routeUrl(tool.id), "data-route": tool.id },
      h("div", { class: "card-top" }, iconEl(tool.id)),
      h("h3", {}, tool.title),
      h("p", {}, tool.blurb),
      h("span", { class: "kind" }, h("span", {}, category), h("span", { class: "card-arrow", "aria-hidden": "true" }, "→")));
    return { tool, link, keywords: (tool.title + " " + tool.blurb + " " + searchTerms[tool.id]).toLowerCase() };
  });
  const grid = h("div", { class: "bento" }, cards.map(card => card.link));
  const search = h("input", { type: "search", placeholder: "Try “merge PDF” or “resize”", "aria-label": "Search PDF and image tools", "aria-controls": "tool-directory" });
  const status = h("p", { class: "match-count", role: "status" }, TOOLS.length + " tools");
  const empty = h("div", { class: "empty-search", hidden: "" },
    h("p", {}, "No tools match your search."),
    h("button", { type: "button", onclick: () => {
      search.value = "";
      group = "all";
      refresh();
      search.focus();
    } }, "Reset search and filters"));
  let group = "all", matches = cards;
  const categories = [["all", "All tools"], ["pdf", "PDF"], ["img", "Image"]];
  const filters = categories.map(([id, label]) => {
    return h("button", { type: "button", "aria-pressed": String(id === group), onclick: () => {
      group = id;
      refresh();
    } }, label);
  });

  function refresh() {
    const terms = search.value.toLowerCase().match(/[a-z0-9]+/g) || [];
    matches = cards.filter(({ tool, keywords }) =>
      (group === "all" || (tool.groups || [tool.group]).includes(group)) && terms.every(term => keywords.includes(term)));
    for (const card of cards) card.link.hidden = !matches.includes(card);
    filters.forEach((filter, index) => filter.setAttribute("aria-pressed", String(group === categories[index][0])));
    grid.classList.toggle("is-filtered", group !== "all" || terms.length > 0);
    grid.dataset.count = matches.length;
    empty.hidden = matches.length !== 0;
    status.textContent = matches.length === 1 ? "1 tool found" : matches.length + " tools found";
  }

  search.addEventListener("input", refresh);
  const form = h("form", { class: "tool-search", role: "search", onsubmit: event => {
    event.preventDefault();
    refresh();
    if (matches.length === 1) matches[0].link.click();
    else if (matches.length) matches[0].link.focus();
  } }, h("span", { class: "tool-search-icon", "aria-hidden": "true" }), search, h("button", { type: "submit" }, "Search"));
  const shortcuts = h("nav", { class: "hero-shortcuts", "aria-label": "Quick access tools" },
    [["merge-pdf", "Merge PDF"], ["compress-image", "Compress image"], ["sign-pdf", "Sign PDF"], ["background-remover", "Remove background"]]
      .map(([id, label]) => h("a", { href: routeUrl(id), "data-route": id }, label)));

  return h("div", {},
    h("section", { class: "hero" },
      h("h1", {}, "Free ", h("span", {}, "PDF & Image Tools")),
      h("p", {}, "Merge, split, compress, resize, or convert files right in your browser. No uploads required."),
      form, shortcuts),
    h("section", { class: "directory", id: "tool-directory", "aria-labelledby": "directory-title" },
      h("div", { class: "directory-head" }, h("h2", { id: "directory-title" }, "Browse tools"),
        h("div", { class: "tool-filters", role: "group", "aria-label": "Filter tools by file type" }, filters)),
      status, empty, grid));
}

function buildTool(t) {
  const panel = h("section", { class: "tool-panel " + t.group + "-tool" },
    h("a", { class: "tool-back", href: routeUrl("home"), "data-route": "home" }, "← All tools"),
    h("div", { class: "tool-head" },
      h("div", { class: "tool-top" }, h("div", { class: "tool-title" }, iconEl(t.id), h("h1", {}, t.title)), shareBtn(t.id)),
      h("p", {}, t.blurb)),
    createUploader(t));
  return panel;
}

/* =====================================================================
   5. ROUTER + TABS
   ===================================================================== */
/* =====================================================================
   SEO: per-route title, description, how-to text, FAQ and FAQ structured data
   ===================================================================== */
const SEO = {
 "organize-pdf": {
  title: "Organize PDF – Reorder, Rotate or Delete Pages | Fileroom",
  desc: "Preview, reorder, rotate and delete PDF pages in your browser. Download the organized PDF.",
  heading: "How to organize PDF pages",
  steps: ["Add a PDF.", "Select pages to preview, reorder, rotate or delete.", "Save a new copy."],
  faq: [["Does organizing change the text?", "Fileroom rearranges the existing pages, so their selectable text remains."]]
 },
 "crop-image": {
  title: "Free Image Cropper – Crop to a Size or Ratio | Fileroom",
  desc: "Crop a JPG, PNG or WebP to exact pixels or choose a square, portrait or widescreen preset. No uploads.",
  heading: "How to crop an image",
  steps: ["Add an image.", "Drag a crop area, choose an aspect ratio, or enter pixel bounds.", "Crop and download."],
  faq: [["Can I crop to exact pixels?", "Yes. Enter the left, top, width and height of the crop area."]]
 },
 "extract-text": {
  title: "OCR and Extract Text from Images and PDF | Fileroom",
  desc: "Extract text from photos and PDFs with on-device OCR. Copy results or download plain text.",
  heading: "How to extract text",
  steps: ["Add a photo or PDF.", "Choose a language for recognition.", "Extract, then copy the text or download a TXT file."],
  faq: [["Does OCR need internet access?", "Scans and photos need an initial language and runtime download. Selectable PDF text can be extracted offline."]]
 },
 "sign-pdf": {
  title: "Sign PDF – Draw or Upload a Signature | Fileroom",
  desc: "Draw or upload a visible signature, position it on a PDF page, and save a signed copy directly in your browser.",
  heading: "How to place a signature on a PDF",
  steps: ["Add a PDF.", "Draw or upload your signature.", "Choose a page, click to place it, and save a signed copy."],
  faq: [["What kind of signature does this add?", "This tool places a visible signature image on the selected PDF page."]]
 },
 "jpg-to-pdf": {
  title: "Free JPG to PDF Converter | Fileroom",
  desc: "Combine JPG, PNG and WebP images into an A4 or US Letter PDF right in your browser. Reorder images before downloading.",
  heading: "How to combine images into a PDF",
  steps: ["Add your images.", "Reorder them and choose a page size and orientation.", "Create and download your PDF."],
  faq: [["Can I use PNGs or WebP images too?", "Yes. You can mix JPG, PNG and WebP images in a single PDF."]]
 },
 "pdf-to-jpg": {
  title: "Free PDF to JPG Converter | Fileroom",
  desc: "Turn every PDF page into a JPG directly in your browser. Pick a resolution and download one JPG or a ZIP.",
  heading: "How to convert PDF pages to JPG",
  steps: ["Add a PDF.", "Choose a JPG resolution.", "Convert and download the JPG or ZIP."],
  faq: [["Do I get one image per page?", "Yes. PDFs with multiple pages are packaged as a ZIP."]]
 },
 "watermark": {
  title: "Add a Text Watermark to PDFs and Images | Fileroom",
  desc: "Add a text watermark to PDFs or images with adjustable placement, color, size and opacity, directly in your browser.",
  heading: "How to add a text watermark",
  steps: ["Add one or more PDFs or images.", "Enter your text and choose its position, color, size and opacity.", "Apply the watermark and download your files."],
  faq: [["Does watermarking make PDF text unselectable?", "Existing PDF text remains selectable. The watermark is added as text."]]
 },
 "background-remover": {
  title: "Free Image Background Remover | Fileroom",
  desc: "Remove image backgrounds with on-device AI and download transparent PNGs. Your photos stay in your browser.",
  heading: "How to remove an image background",
  steps: ["Add a JPG, PNG or WebP with a clear subject.", "Run the background remover. Your browser loads the model and runtime if needed.", "Download your transparent PNG or a ZIP for multiple images."],
  faq: [["Are my images sent to the model provider?", "No. Only the public model and runtime are downloaded. The model processes images in your browser."]]
 },

 "home": {
  "title": "Free PDF & Image Tools | Fileroom",
  "desc": "Merge, split and compress PDFs, and compress, resize or convert images online for free. Everything runs in your browser, so your files stay private.",
  "heading": "How Fileroom works",
  "steps": [
   "Pick a tool from the grid or the Tools menu.",
   "Drop in your files. They are processed on your device.",
   "Download the result, or a ZIP if you processed several images."
  ],
  "faq": [
   [
    "Are my files uploaded anywhere?",
    "No. Every tool runs inside your browser, so your PDFs and images never leave your device."
   ],
   [
    "Is Fileroom free to use?",
    "Yes. There is no sign-up. Fileroom adds a watermark only when you use the Watermark tool."
   ],
   [
    "Which tools are included?",
    "PDF Combiner, Split PDF, PDF Compressor, Image Compressor, Image Resizer, Image Format Converter, PDF to JPG, JPG to PDF, Watermark, Background Remover, Organize PDF, Crop Image, OCR / Extract Text and Sign PDF."
   ]
  ]
 },
 "merge-pdf": {
  "title": "PDF Combiner – Merge PDF Files Online Free | Fileroom",
  "desc": "Combine multiple PDF files into one. Reorder, remove and merge PDFs privately in your browser, with no upload and no sign-up.",
  "heading": "How to merge PDF files online",
  "steps": [
   "Add two or more PDF files.",
   "Use Up, Down and Remove to set the order.",
   "Press Merge files and download merged.pdf."
  ],
  "faq": [
   [
    "How do I merge PDF files for free?",
    "Add your PDFs, arrange them with the Up and Down buttons, then press Merge files. The combined file downloads as merged.pdf."
   ],
   [
    "Is it safe to merge confidential PDFs?",
    "Yes. Merging happens locally in your browser, so contracts, ID scans and invoices are never sent to a server."
   ],
   [
    "Can I change the order before merging?",
    "Yes. Files are merged from top to bottom, so move them first. To pick specific pages, use the Split PDF tool."
   ]
  ]
 },
 "split-pdf": {
  "title": "Split PDF – Extract Pages Online Free | Fileroom",
  "desc": "Extract specific pages or split every page of a PDF into separate files. Free, private and processed in your browser.",
  "heading": "How to split a PDF or extract pages",
  "steps": [
   "Add a PDF and check its page count.",
   "Type pages such as 1-3, 5, or choose to split every page.",
   "Download the new PDF, or a ZIP with one file per page."
  ],
  "faq": [
   [
    "How do I extract pages from a PDF?",
    "Enter a range such as 1-3, 5 and press Split file. Those pages are saved into one new PDF."
   ],
   [
    "Can I split every page into its own file?",
    "Yes. Choose the split every page option and you get a ZIP with one PDF per page."
   ],
   [
    "Is my PDF uploaded?",
    "No. The file is split on your device and never sent to a server."
   ]
  ]
 },
 "compress-pdf": {
  "title": "PDF Compressor – Reduce PDF File Size Online | Fileroom",
  "desc": "Try structural PDF optimization to keep selectable text, or convert pages to JPEG for image-based compression. Results vary by file.",
  "heading": "How to reduce the size of a PDF",
  "steps": [
   "Add your PDF.",
   "Choose Low (keeps text), Medium or High (pages become images).",
   "Compare the before and after size, then download."
  ],
  "faq": [
   [
    "How do I reduce the size of a scanned PDF?",
    "Choose Medium or High. They turn each page into a compressed image, which can cut the file size a lot."
   ],
   [
    "What does Low compression do?",
    "It keeps text selectable and only cleans up the file structure, so the savings are small."
   ],
   [
    "Will text stay selectable after compressing?",
    "Only on Low. Medium and High convert pages to images, so text can no longer be selected."
   ],
   [
    "Is it private?",
    "Yes. Compression runs in your browser and your PDF is never uploaded."
   ]
  ]
 },
 "compress-image": {
  "title": "Image Compressor – Reduce Image Size in KB | Fileroom",
  "desc": "Compress JPG, PNG and WebP images to fit a size limit such as 50 KB or 100 KB for online forms. Live preview, batch ZIP download, no upload.",
  "heading": "How to compress an image to a target size",
  "steps": [
   "Add one or many JPG, PNG or WebP images.",
   "Move the quality slider, or type a target size such as 100 KB.",
   "Check the preview and estimated size, then download (a ZIP for several images)."
  ],
  "faq": [
   [
    "How do I compress an image to 100 KB?",
    "Type 100 in the target size box. Fileroom lowers the quality, and shrinks the image if needed, until it fits."
   ],
   [
    "How can I reduce a photo to 50 KB for an online form?",
    "Enter 50 as the target size and choose JPG or WebP. Check the preview, then download."
   ],
   [
    "Can I compress many images at once?",
    "Yes. Add several images and download them together as one ZIP."
   ],
   [
    "Are my photos uploaded?",
    "No. Compression happens in your browser, so your photos stay on your device."
   ]
  ]
 },
 "resize-image": {
  "title": "Image Resizer – Resize Images Online Free | Fileroom",
  "desc": "Resize JPG, PNG and WebP images by pixels or percentage. Lock aspect ratio, use presets like 1080p or Instagram Square, all in your browser.",
  "heading": "How to resize an image online",
  "steps": [
   "Add your images and check their original size.",
   "Enter a width and height, or tap a preset such as 50% or 1080p.",
   "Download the resized image, or a ZIP for several."
  ],
  "faq": [
   [
    "How do I resize an image without stretching it?",
    "Keep Lock aspect ratio on. Typing a width fills in the matching height."
   ],
   [
    "What size is an Instagram square post?",
    "1080 × 1080 pixels. The Instagram Square preset crops from the center to fill it."
   ],
   [
    "Can I resize by percentage?",
    "Yes. The 50% and 75% presets scale every image to that share of its original size."
   ]
  ]
 },
 "convert-image": {
  "title": "Image Converter – Convert PNG, JPG & WebP | Fileroom",
  "desc": "Convert PNG to JPG, JPG to WebP and more without uploading. Pick a background color for transparent PNGs. Free, private and batch-friendly.",
  "heading": "How to convert images between PNG, JPG and WebP",
  "steps": [
   "Add one or many images.",
   "Choose the target format and, for JPG, a background color.",
   "Download the converted image, or a ZIP for several."
  ],
  "faq": [
   [
    "How do I convert PNG to JPG without uploading?",
    "Add your PNG, choose JPG as the target format and download. The conversion runs in your browser."
   ],
   [
    "What happens to transparent areas when converting PNG to JPG?",
    "JPG cannot be transparent, so those areas are filled with the background color you pick, white by default."
   ],
   [
    "Which image formats are supported?",
    "JPG, PNG and WebP."
   ]
  ]
 }
};
Object.assign(SEO, {"about": {"label": "About", "title": "About Fileroom | Private PDF & Image Tools", "desc": "Learn how Fileroom’s free browser tools work for PDFs, images, and text extraction.", "sections": [["", "Fileroom is a collection of free PDF and image tools. You can combine or organize PDFs, resize or crop images, and extract text from scans in your browser."], ["How it works", "Choose a tool, add a file, and download the result. There is no account to create. Your browser processes your files on your device."]]}, "privacy": {"label": "Privacy Policy", "title": "Privacy Policy | Fileroom", "desc": "Learn what Fileroom processes on your device and what your browser downloads or stores.", "sections": [["Files and results", "Fileroom processes your PDFs, images, signatures, and extracted text on your device. The app does not upload them to a server. Browser-generated downloads are saved by your browser."], ["App downloads and storage", "The hosted site uses a service worker and Cache Storage to save public app files for offline use. The OCR engine can also save downloaded recognition language data in IndexedDB. Your theme preference is stored locally. These stores do not contain your documents, signatures, or extracted text."], ["Clearing browser storage", "Use your browser’s site settings to clear Fileroom’s site data. This removes cached app and OCR data and resets your theme preference. Files already saved to your Downloads folder are managed separately."], ["Analytics and advertising", "Fileroom does not include analytics, ad scripts, or account registration. If you access the website, the hosting provider receives standard connection information such as your IP address."]]}, "contact": {"label": "Contact", "title": "Contact Fileroom", "desc": "Find out about contacting Fileroom for tool feedback, support, or privacy questions.", "sections": [["", "A public support address has not been published yet. Please keep personal PDFs and images private when preparing a bug report. A description of the steps and a sample file without personal data can help reproduce the issue."]]}});
for (const [id, entry] of Object.entries({"organize-pdf": ["Can I review the page order before saving?", "Yes. Use the thumbnails to check your new order, then save an organized copy. Individual PDFs can be up to 50 MB."], "crop-image": ["Can I enter exact crop dimensions?", "Yes. Use the crop width and height controls to set the region in pixels. Images can be up to 25 MB each."], "extract-text": ["What kinds of PDFs can I extract text from?", "Fileroom reads selectable text directly. When a page has no selectable text, it can run OCR on the page image. Check the result before using it."], "sign-pdf": ["Is this a certificate-based digital signature?", "The tool places a visible signature image on the page. It does not add a digital certificate or verify the signer’s identity."], "jpg-to-pdf": ["Can I arrange photos before converting them?", "Yes. Reorder your images before creating the PDF. Each image becomes a separate page."], "pdf-to-jpg": ["How do I download multiple pages?", "When you export multiple pages, Fileroom bundles the rendered JPGs into one ZIP. The PDF can be up to 50 MB."], "watermark": ["Can I watermark a batch of files?", "Yes. Add the files, choose your watermark settings, and download the processed files together as a ZIP."], "background-remover": ["Which images work best?", "Choose an image with a clearly separated foreground. Fine edges such as hair or transparent objects may need extra cleanup. The result is a transparent PNG."]})) SEO[id].faq.push(entry);

// Older tool names and shared hash links still resolve.
const ALIAS = { "image-compressor": "compress-image", "image-resizer": "resize-image", "image-converter": "convert-image" };
const metaDesc = document.getElementById("metaDesc"), ldFaq = document.getElementById("ldFaq"), infoEl = document.getElementById("info");

const appSchema = JSON.parse(document.getElementById("ldApp").textContent);
const faqLd = faq => ({ "@context": "https://schema.org", "@type": "FAQPage",
  mainEntity: faq.map(([q, a]) => ({ "@type": "Question", name: q, acceptedAnswer: { "@type": "Answer", text: a } })) });

// Update title, meta description, FAQ structured data, and the visible "How It Works & FAQ" box.
function setSeo(id) {
  const d = SEO[id];
  document.title = d.title;
  metaDesc.setAttribute("content", d.desc);
  document.querySelector('meta[property="og:title"]').content = d.title;
  document.querySelector('meta[property="og:description"]').content = d.desc;
  let ogUrl = document.querySelector('meta[property="og:url"]');
  if (location.protocol !== "file:") {
    const published = document.querySelector('meta[name="fileroom-canonical-base"]');
    const canonical = published ? new URL(id === "home" ? "./" : id + "/", published.content) : new URL(routeUrl(id));
    if (!ogUrl) {
      ogUrl = h("meta", { property: "og:url" });
      document.head.append(ogUrl);
    }
    canonical.search = "";
    ogUrl.content = canonical.href;
    const link = document.querySelector('link[rel="canonical"]');
    if (link) link.href = canonical.href;
  }
  document.querySelector('meta[name="twitter:title"]').content = d.title;
  document.querySelector('meta[name="twitter:description"]').content = d.desc;
  document.getElementById("ldApp").textContent = JSON.stringify({
    ...appSchema, description: d.desc, ...(location.protocol !== "file:" && { url: ogUrl.content })
  });
  const ldApp = document.getElementById("ldApp");
  const robots = document.querySelector('meta[name="robots"]');
  if (id === "contact") {
    if (!robots) document.head.append(h("meta", { name: "robots", content: "noindex" }));
  } else if (robots?.content === "noindex") {
    robots.remove();
  }
  ldApp.type = d.sections ? "application/json" : "application/ld+json";
  ldFaq.type = ldApp.type;
  if (d.sections) {
    infoEl.replaceChildren();
    return;
  }
  ldFaq.textContent = JSON.stringify(faqLd(d.faq));
  infoEl.replaceChildren(h("details", { class: "faq-box" },
    h("summary", {}, "How It Works & FAQ"),
    h("h2", {}, d.heading),
    h("ol", {}, d.steps.map(t => h("li", {}, t))),
    h("h3", {}, "Frequently asked questions"),
    d.faq.map(([q, a]) => h("details", { class: "q" }, h("summary", {}, q), h("p", {}, a)))));
}

/* =====================================================================
   POLISH: icons, badges, toasts, copy-link
   ===================================================================== */
const ICONS = {
  "organize-pdf": '<rect x="3" y="4" width="7" height="16" rx="1"/><rect x="14" y="4" width="7" height="7" rx="1"/><rect x="14" y="15" width="7" height="5" rx="1"/>',
  "crop-image": '<path d="M6 3v14a1 1 0 0 0 1 1h14M3 6h14a1 1 0 0 1 1 1v14"/>',
  "extract-text": '<path d="M4 8V4h4m8 0h4v4m0 8v4h-4m-8 0H4v-4M8 9h8m-8 3h8m-8 3h5"/>',
  "sign-pdf": '<path d="M4 20h16M5 16l2-5L16 2l5 5-9 9-5 2zm8-11 5 5"/>',
  "jpg-to-pdf": '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5"/><path d="M8 17l3-4 2 2 2-2 2 4z"/>',
  "pdf-to-jpg": '<path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M13 2v7h7M7 17l3-3 3 3 2-2 2 2"/>',
  "watermark": '<path d="M4 20h16M7 5h10M12 5v12M9 17h6"/>',
  "background-remover": '<rect x="3" y="3" width="18" height="18" rx="3" stroke-dasharray="3 3"/><circle cx="12" cy="9" r="2"/><path d="M8 17a4 4 0 0 1 8 0"/>',

  "merge-pdf": '<path d="M5 4v4c0 3 2 4 4 5l3 1"/><path d="M19 4v4c0 3-2 4-4 5l-3 1"/><path d="M12 14v7"/><path d="m9 18 3 3 3-3"/>',
  "split-pdf": '<path d="M12 3v6"/><path d="M12 9c0 3-5 3-5 7v5"/><path d="M12 9c0 3 5 3 5 7v5"/><path d="m4 18 3 3 3-3"/><path d="m14 18 3 3 3-3"/>',
  "compress-pdf": '<path d="M4 14h6v6"/><path d="M20 10h-6V4"/><path d="m14 10 7-7"/><path d="m3 21 7-7"/>',
  "compress-image": '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="9" cy="9" r="1.5"/><path d="m21 15-4.5-4.5L6 21"/>',
  "resize-image": '<path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/>',
  "convert-image": '<path d="m17 3 4 4-4 4"/><path d="M3 7h18"/><path d="m7 21-4-4 4-4"/><path d="M21 17H3"/>'
};
const LINK_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/></svg>';
const TOAST = {
  "merge-pdf": "Files merged successfully!", "split-pdf": "PDF split successfully!", "compress-pdf": "PDF compressed!",
  "compress-image": "Images compressed!", "resize-image": "Images resized!", "convert-image": "Images converted!"
};

// Icons are fixed strings from this file (never user input), so innerHTML is safe here.
const iconEl = id => { const e = h("span", { class: "ico", "aria-hidden": "true" }); e.innerHTML = '<svg viewBox="0 0 24 24">' + ICONS[id] + "</svg>"; return e; };

const toastBox = document.getElementById("toasts");
function toast(msg, kind) {
  const t = h("div", { class: "toast" + (kind === "error" ? " err" : "") }, h("i", { class: "tdot" }), h("span", {}, msg));
  toastBox.append(t);
  while (toastBox.children.length > 3) toastBox.firstChild.remove();
  setTimeout(() => { t.classList.add("out"); setTimeout(() => t.remove(), 250); }, kind === "error" ? 5000 : 3000);
}

// Clipboard API first, then the older copy command (some embedded pages block the first).
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch (e) {}
  try {
    const ta = h("textarea", { readonly: "", class: "clipboard-fallback" });
    ta.value = text; document.body.append(ta); ta.select();
    const ok = document.execCommand("copy"); ta.remove(); return ok;
  } catch (e) { return false; }
}

const shareBtn = id => {
  const b = h("button", { class: "share", type: "button", onclick: async () => {
    const url = routeUrl(id);
    if (await copyText(url)) toast("Copied link to clipboard!"); else toast("Could not copy automatically. Link: " + url, "error");
  } });
  b.innerHTML = LINK_ICON + " Share tool link";
  return b;
};

const viewEl = document.getElementById("view");
viewEl.replaceChildren();
const views = new Map();

const isRoute = id => Object.hasOwn(SEO, id) && id !== "home";
const pathParts = location.pathname.split("/").filter(Boolean);
if (/\.html?$/i.test(pathParts.at(-1) || "")) pathParts.pop();
const lastPathPart = pathParts.at(-1);
const localFile = location.protocol === "file:";
const baseUrl = new URL(location.href);
baseUrl.hash = "";
baseUrl.searchParams.delete("tool");
// HTTP deployments serve this file at the base and at the tool paths via a static rewrite.
if (!localFile) {
  if (isRoute(lastPathPart) || /\.html?$/i.test(lastPathPart || "")) pathParts.pop();
  baseUrl.pathname = "/" + (pathParts.length ? pathParts.join("/") + "/" : "");
}

function routeUrl(id) {
  const url = new URL(baseUrl);
  if (id !== "home") {
    if (localFile) url.searchParams.set("tool", id);
    else url.pathname += id + "/";
  }
  return url.href;
}

document.querySelector(".brand").href = routeUrl("home");
const toolsMenu = document.querySelector(".tools-menu");
const toolsSummary = toolsMenu.querySelector("summary");
const mobileMenu = document.getElementById("mobile-menu");
const menuToggle = document.querySelector(".menu-toggle");
const mobileLayout = matchMedia("(max-width:720px)");

document.querySelectorAll(".link-group a[data-route]").forEach(link => {
  link.href = routeUrl(link.dataset.route);
});

menuToggle.addEventListener("click", () => {
  menuToggle.focus({ preventScroll: true });
  mobileMenu.showModal();
  menuToggle.setAttribute("aria-expanded", "true");
});
mobileMenu.querySelector(".menu-close").addEventListener("click", () => mobileMenu.close());
mobileMenu.addEventListener("close", () => menuToggle.setAttribute("aria-expanded", "false"));
mobileLayout.addEventListener("change", () => {
  toolsMenu.open = false;
  if (mobileMenu.open) mobileMenu.close();
});
document.addEventListener("click", event => {
  if (!toolsMenu.contains(event.target)) toolsMenu.open = false;
});
toolsMenu.addEventListener("focusout", event => {
  if (event.relatedTarget && !toolsMenu.contains(event.relatedTarget)) toolsMenu.open = false;
});
document.querySelector(".skip-link").addEventListener("click", event => {
  event.preventDefault();
  viewEl.focus();
  viewEl.scrollIntoView();
});
document.addEventListener("keydown", event => {
  if (event.key === "Escape" && toolsMenu.open) {
    const focusWasInside = toolsMenu.contains(document.activeElement);
    toolsMenu.open = false;
    if (focusWasInside) toolsSummary.focus();
  }
});

function closeRouteMenu(link) {
  if (toolsMenu.contains(link)) toolsMenu.open = false;
  if (mobileMenu.contains(link)) mobileMenu.close();
}

function focusRouteHeading() {
  const heading = viewEl.querySelector(":scope > :not([hidden]) h1");
  if (heading) {
    heading.tabIndex = -1;
    heading.focus({ preventScroll: true });
  }
  window.scrollTo({ top: 0, left: 0, behavior: "instant" });
}

function buildInformationPage(id) {
  const page = SEO[id];
  const sections = [...page.sections];
  if (id === "privacy" && !hostedAssets) sections.push(["Portable HTML downloads",
    "OCR and background removal may download public runtime files from jsDelivr. OCR may also download recognition language data from Project Naptha."]);
  return h("article", { class: "info-page" }, h("h1", {}, page.label),
    sections.map(([heading, content]) => h("section", {},
      heading ? [h("h2", {}, heading), h("p", {}, content)] : h("p", {}, content))));
}


function ensureView(id) {
  if (!views.has(id)) {
    const view = id === "home" ? buildHome() : SEO[id].sections ? buildInformationPage(id) : buildTool(TOOLS.find(tool => tool.id === id));
    view.hidden = true;
    views.set(id, view);
    viewEl.append(view);
  }
  return views.get(id);
}

let activeRoute;
function show() {
  const legacy = location.hash.slice(1);
  const raw = legacy || (localFile
    ? new URL(location.href).searchParams.get("tool")
    : location.pathname.split("/").filter(part => part && !/\.html?$/i.test(part)).at(-1));
  const want = Object.hasOwn(ALIAS, raw) ? ALIAS[raw] : raw;
  const id = isRoute(want) ? want : "home";
  if (legacy && (legacy === "home" || isRoute(want))) writeRoute("replaceState", id);
  ensureView(id);
  views.forEach((el, key) => { el.hidden = key !== id; });
  const cur = views.get(id);
  cur.classList.add("view-in");
  if (activeRoute && activeRoute !== id) {
    cur.classList.remove("navigate-in");
    void cur.offsetWidth;
    cur.classList.add("navigate-in");
  }
  activeRoute = id;
  document.querySelectorAll(".link-group a[data-route]").forEach(a => {
    if (a.dataset.route === id) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
  });
  setSeo(id);
}
function writeRoute(method, id) {
  const url = routeUrl(id);
  if (location.href === url) return;
  try {
    history[method](null, "", url);
  } catch (err) {
    // Some browsers restrict file URL history changes to the fragment.
    if (!localFile || err.name !== "SecurityError") throw err;
    const fallback = new URL(location.href);
    fallback.hash = id;
    if (location.href !== fallback.href) history[method](null, "", fallback.href);
  }
}

document.addEventListener("click", event => {
  const link = event.target.closest("a[data-route]");
  if (!link || event.defaultPrevented || event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  closeRouteMenu(link);
  writeRoute("pushState", link.dataset.route);
  show();
  focusRouteHeading();
});
window.addEventListener("popstate", show);
window.addEventListener("hashchange", show);
show();

/* =====================================================================
   6. THEME TOGGLE (follows the OS until the user picks one)
   ===================================================================== */
const themeBtn = document.getElementById("themeBtn");
const root = document.documentElement;
const preferredTheme = matchMedia("(prefers-color-scheme: dark)");
let themeOverride = null;

function applyTheme(mode) {
  root.dataset.theme = mode;
  themeBtn.textContent = mode === "dark" ? "Light mode" : "Dark mode";
}
try { themeOverride = localStorage.getItem("fileroom-theme"); } catch {}
applyTheme(themeOverride || (preferredTheme.matches ? "dark" : "light"));
preferredTheme.addEventListener("change", event => {
  if (!themeOverride) applyTheme(event.matches ? "dark" : "light");
});
themeBtn.addEventListener("click", () => {
  themeOverride = root.dataset.theme === "dark" ? "light" : "dark";
  applyTheme(themeOverride);
  try { localStorage.setItem("fileroom-theme", themeOverride); } catch {}
});

if (hostedAssets && "serviceWorker" in navigator && window.isSecureContext) {
  navigator.serviceWorker.register(new URL("../sw.js", hostedAssets)).catch(err => {
    console.warn("Offline installation is unavailable.", err);
  });
}
