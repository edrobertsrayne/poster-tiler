// Poster Tiler v1: native/unstretched fit only, selectable DPI, sRGB-out. Mirror is an optional horizontal flip at compose time.
'use strict';

// Geometry constants: mm x 72 / 25.4 rounded. At 72 dpi 1 px = 1 pt,
// so these are both tile pixels and PDF page points.
const SHEET_PX = {
  A4: { portrait: [595, 842] },
  A3: { portrait: [842, 1191] },
};
const BG = '#ffffff';
const SUPPORTED_MIMES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp', 'image/avif'];
const SUPPORTED_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|avif)$/i;

function isSupportedFile(file) {
  const t = (file.type || '').toLowerCase();
  if (SUPPORTED_MIMES.includes(t)) return true;
  return SUPPORTED_EXT_RE.test(file.name || '');
}

function tileSize(paper, orient) {
  const [w, h] = SHEET_PX[paper].portrait;
  return orient === 'landscape' ? [h, w] : [w, h];
}

function tilePxForDpi(pt, dpi) { return Math.max(1, Math.round(pt * dpi / 72)); }

function tilePixels(paper, orient, dpi) { const [w, h] = tileSize(paper, orient); return [tilePxForDpi(w, dpi), tilePxForDpi(h, dpi)]; }

function printSizeIn(imgW, imgH, dpi) { return [imgW / dpi, imgH / dpi]; }

function customDpiForWidth(imgW, widthIn) { return imgW / widthIn; }

function gridFor(imgW, imgH, tw, th) {
  const cols = Math.ceil(imgW / tw);
  const rows = Math.ceil(imgH / th);
  return { cols, rows, sheets: cols * rows };
}

function fmtGrid(g) {
  return `${g.cols}×${g.rows} = ${g.sheets} sheet${g.sheets === 1 ? '' : 's'}`;
}

// Auto-orientation = fewest sheets; tie-break by source aspect:
// landscape if imgW >= imgH else portrait.
function pickAuto(paper, imgW, imgH, dpi = 72) {
  const [ptw, pth] = tilePixels(paper, 'portrait', dpi);
  const [ltw, lth] = tilePixels(paper, 'landscape', dpi);
  const p = gridFor(imgW, imgH, ptw, pth);
  const l = gridFor(imgW, imgH, ltw, lth);
  let winner;
  if (p.sheets < l.sheets) winner = 'portrait';
  else if (l.sheets < p.sheets) winner = 'landscape';
  else winner = imgW >= imgH ? 'landscape' : 'portrait';
  return { winner, portrait: p, landscape: l };
}

function composeOffsets(canvasW, canvasH, imgW, imgH) {
  return {
    dx: Math.floor((canvasW - imgW) / 2),
    dy: Math.floor((canvasH - imgH) / 2),
  };
}

function toInches(v, unit) { return unit === 'cm' ? v / 2.54 : v; }

// ---- browser wiring (skipped under node/bun test harness) ----
if (typeof document !== 'undefined') {
  const fileInput = document.getElementById('file');
  const dropZone = document.getElementById('drop');
  const fileLabelEl = document.getElementById('fileLabel');
  const preview = document.getElementById('preview');
  const previewPlaceholder = document.getElementById('previewPlaceholder');
  const sheetLineEl = document.getElementById('sheetLine');
  const sizeLineEl = document.getElementById('sizeLine');
  const errorMsgEl = document.getElementById('errorMsg');
  const warnMsgEl = document.getElementById('warnMsg');
  const downloadBtn = document.getElementById('download');
  const paperSeg = document.getElementById('paperSeg');
  const orientSeg = document.getElementById('orientSeg');
  const sizemodeSeg = document.getElementById('sizemodeSeg');
  const dpiRow = document.getElementById('dpiRow');
  const customRow = document.getElementById('customRow');
  const dpiEl = document.getElementById('dpi');
  const dpiCustomEl = document.getElementById('dpiCustom');
  const customWEl = document.getElementById('customW');
  const customHEl = document.getElementById('customH');
  const customUnitEl = document.getElementById('customUnit');
  const mirrorEl = document.getElementById('mirror');
  fileInput.accept = SUPPORTED_MIMES.join(',');

  let bitmap = null; // decoded source image
  let composed = null; // { canvas, cols, rows, tw, th, orient, paper }

  const state = { paper: 'A4', orient: 'auto', sizemode: 'dpi', customUnit: 'cm' };

  function syncSeg(container, value) {
    container.querySelectorAll('button').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.value === value);
    });
  }

  function wireSeg(container, onPick) {
    container.querySelectorAll('button').forEach((btn) => {
      btn.addEventListener('click', () => onPick(btn.dataset.value));
    });
  }

  function dpiModeValue() {
    const sel = dpiEl.value;
    if (sel !== 'custom') {
      const dpi = parseFloat(sel);
      return isFinite(dpi) ? dpi : 72;
    }
    const raw = parseFloat(dpiCustomEl.value);
    if (!isFinite(raw)) return 72;
    return Math.min(1200, Math.max(10, raw));
  }

  function seedCustomInputs() {
    if (!bitmap) return;
    const unit = customUnitEl.value;
    const [wIn, hIn] = printSizeIn(bitmap.width, bitmap.height, dpiModeValue());
    const factor = unit === 'cm' ? 2.54 : 1;
    customWEl.value = (wIn * factor).toFixed(2);
    customHEl.value = (hIn * factor).toFixed(2);
    customWEl.disabled = false;
    customHEl.disabled = false;
  }

  function effectiveDpi() {
    if (state.sizemode === 'custom') {
      if (!bitmap) return { error: 'No image loaded' };
      const unit = customUnitEl.value;
      const w = parseFloat(customWEl.value);
      const h = parseFloat(customHEl.value);
      if (!isFinite(w) || !isFinite(h) || w <= 0 || h <= 0) {
        return { error: 'Enter a width and height greater than 0' };
      }
      const wIn = toInches(w, unit);
      if (!isFinite(wIn) || wIn <= 0) {
        return { error: 'Enter a width and height greater than 0' };
      }
      const dpi = customDpiForWidth(bitmap.width, wIn);
      if (!isFinite(dpi) || dpi < 10 || dpi > 1200) {
        return { error: 'That size needs a resolution outside 10–1200 dpi — try a different width' };
      }
      return { dpi };
    }
    const sel = dpiEl.value;
    if (sel !== 'custom') {
      const dpi = parseFloat(sel);
      if (isFinite(dpi)) return { dpi };
      return { error: 'Select a DPI' };
    }
    const raw = parseFloat(dpiCustomEl.value);
    if (!isFinite(raw) || raw === 0 || dpiCustomEl.value === '') {
      return { error: 'Enter a DPI between 10 and 1200' };
    }
    if (raw < 10 || raw > 1200) {
      return { error: 'DPI out of range (10–1200)' };
    }
    return { dpi: raw };
  }

  function showError(msg) {
    errorMsgEl.textContent = msg;
    errorMsgEl.hidden = !msg;
  }

  function showWarning(msg) {
    warnMsgEl.textContent = msg;
    warnMsgEl.hidden = !msg;
  }

  async function decodeFile(file) {
    try {
      return await createImageBitmap(file);
    } catch (_) {
      // Fall back to Image + object URL.
    }
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.decoding = 'sync';
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = reject;
        img.src = url;
      });
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      canvas.getContext('2d').drawImage(img, 0, 0);
      return await createImageBitmap(canvas);
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  // Whitest tile of the composed canvas, via sparse sampling (exact for
  // solid padding; strides keep large grids fast).
  function blankestTile(ctx, canvasW, canvasH, tw, th, cols, rows) {
    const img = ctx.getImageData(0, 0, canvasW, canvasH).data;
    let worst = { fraction: -1, entirelyBlank: false, row: 0, col: 0 };
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        let white = 0;
        let total = 0;
        for (let y = r * th; y < (r + 1) * th; y += 4) {
          for (let x = c * tw; x < (c + 1) * tw; x += 4) {
            const i = (y * canvasW + x) * 4;
            total++;
            if (img[i] === 255 && img[i + 1] === 255 && img[i + 2] === 255) white++;
          }
        }
        const fraction = total === 0 ? 0 : white / total;
        if (fraction > worst.fraction) {
          worst = { fraction, entirelyBlank: fraction === 1, row: r, col: c };
        }
      }
    }
    return worst;
  }

  function recompute() {
    if (!bitmap) {
      downloadBtn.disabled = true;
      return;
    }
    const res = effectiveDpi();
    if ('error' in res) {
      composed = null;
      downloadBtn.disabled = true;
      showError(res.error);
      showWarning('');
      return;
    }
    showError('');
    const dpi = res.dpi;
    const imgW = bitmap.width;
    const imgH = bitmap.height;
    const paper = state.paper;
    const mode = state.orient;
    const { winner, portrait, landscape } = pickAuto(paper, imgW, imgH, dpi);
    const orient = mode === 'auto' ? winner : mode;
    const [twPt, thPt] = tileSize(paper, orient);
    const [tw, th] = tilePixels(paper, orient, dpi);
    const g = orient === 'portrait' ? portrait : landscape;

    const canvasW = g.cols * tw;
    const canvasH = g.rows * th;
    // Clean composed canvas (white + centred source, no overlay): the slice source.
    const clean = document.createElement('canvas');
    clean.width = canvasW;
    clean.height = canvasH;
    const cleanCtx = clean.getContext('2d', { willReadFrequently: true });
    cleanCtx.fillStyle = BG;
    cleanCtx.fillRect(0, 0, canvasW, canvasH);
    const { dx, dy } = composeOffsets(canvasW, canvasH, imgW, imgH);
    if (mirrorEl.checked) {
      cleanCtx.save();
      cleanCtx.translate(canvasW, 0);
      cleanCtx.scale(-1, 1);
      cleanCtx.drawImage(bitmap, dx, dy);
      cleanCtx.restore();
    } else {
      cleanCtx.drawImage(bitmap, dx, dy);
    }

    // Preview = clean compose + grid overlay (overlay never enters the PDF).
    preview.width = canvasW;
    preview.height = canvasH;
    preview.style.display = 'block';
    previewPlaceholder.hidden = true;
    const ctx = preview.getContext('2d');
    ctx.drawImage(clean, 0, 0);
    const cutW = Math.max(2, Math.round(Math.min(tw, th) / 200));
    const cuts = new Path2D();
    for (let c = 1; c < g.cols; c++) {
      cuts.moveTo(c * tw, 0);
      cuts.lineTo(c * tw, canvasH);
    }
    for (let r = 1; r < g.rows; r++) {
      cuts.moveTo(0, r * th);
      cuts.lineTo(canvasW, r * th);
    }
    cuts.rect(cutW, cutW, canvasW - 2 * cutW, canvasH - 2 * cutW);
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = cutW + 2;
    ctx.stroke(cuts);
    ctx.strokeStyle = '#ff2d2d';
    ctx.lineWidth = cutW;
    ctx.stroke(cuts);
    const fs = Math.max(14, Math.round(Math.min(tw, th) / 25));
    ctx.font = `bold ${fs}px monospace`;
    for (let r = 0; r < g.rows; r++) {
      for (let c = 0; c < g.cols; c++) {
        const label = `r${r}c${c}`;
        const x = c * tw + 6;
        const y = r * th + 6 + fs;
        const w = ctx.measureText(label).width;
        ctx.fillStyle = 'rgba(255,255,255,0.92)';
        ctx.fillRect(x - 3, y - fs - 3, w + 6, fs + 6);
        ctx.fillStyle = '#000';
        ctx.fillText(label, x, y);
      }
    }

    composed = { canvas: clean, cols: g.cols, rows: g.rows, tw, th, twPt, thPt, dpi, orient, paper, mirror: mirrorEl.checked };

    // Readout.
    const [pw, ph] = printSizeIn(imgW, imgH, dpi);
    const cm = (v) => (v * 2.54).toFixed(0);
    sheetLineEl.textContent = `${fmtGrid(g)} of ${paper} ${orient}`;
    sizeLineEl.textContent = `${pw.toFixed(1)}×${ph.toFixed(1)} in · ${cm(pw)}×${cm(ph)} cm · ${Math.round(dpi)} dpi`;

    // Blank-tile warning (never silently blank): sample each tile of the clean
    // compose and flag one that is entirely padding.
    const blankest = blankestTile(cleanCtx, canvasW, canvasH, tw, th, g.cols, g.rows);
    showWarning(blankest.entirelyBlank
      ? `Sheet r${blankest.row}c${blankest.col} comes out completely blank — the other direction may suit this picture better.`
      : '');

    const noPdf = typeof PDFLib === 'undefined';
    downloadBtn.disabled = noPdf;
    if (noPdf) showError('PDF library failed to load — check network and reload');
  }

  function tileCanvasToPngBytes(tile) {
    return new Promise((resolve, reject) => {
      tile.toBlob((blob) => {
        if (!blob) {
          reject(new Error('tile encode failed'));
          return;
        }
        blob.arrayBuffer().then(
          (buf) => resolve(new Uint8Array(buf)),
          reject,
        );
      }, 'image/png');
    });
  }

  async function downloadPdf() {
    if (!composed) return;
    const { canvas, cols, rows, tw, th, twPt, thPt, orient, paper } = composed;
    const pdfDoc = await PDFLib.PDFDocument.create();
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const sx = col * tw;
        const sy = row * th;
        const tile = document.createElement('canvas');
        tile.width = tw;
        tile.height = th;
        const tctx = tile.getContext('2d');
        tctx.drawImage(canvas, sx, sy, tw, th, 0, 0, tw, th);
        const pngBytes = await tileCanvasToPngBytes(tile);
        const img = await pdfDoc.embedPng(pngBytes);
        const page = pdfDoc.addPage([twPt, thPt]);
        page.drawImage(img, { x: 0, y: 0, width: twPt, height: thPt });
      }
    }
    const bytes = await pdfDoc.save();
    const blob = new Blob([bytes], { type: 'application/pdf' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = composed.mirror ? `poster-${paper}-${orient}-${cols}x${rows}-mirrored.pdf` : `poster-${paper}-${orient}-${cols}x${rows}.pdf`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 1000);
  }

  function syncSizeRows() {
    dpiRow.hidden = state.sizemode !== 'dpi';
    customRow.hidden = state.sizemode !== 'custom';
    dpiCustomEl.hidden = dpiEl.value !== 'custom';
    if (state.sizemode === 'custom') {
      if (bitmap) seedCustomInputs();
      else { customWEl.disabled = true; customHEl.disabled = true; }
    }
  }

  async function acceptFile(file) {
    composed = null;
    downloadBtn.disabled = true;
    if (!file) return;
    if (!isSupportedFile(file)) {
      bitmap = null;
      customWEl.disabled = true;
      customHEl.disabled = true;
      showError('That file type can’t be read here — export a flat PNG or JPEG first.');
      return;
    }
    try {
      bitmap = await decodeFile(file);
    } catch (_) {
      bitmap = null;
      customWEl.disabled = true;
      customHEl.disabled = true;
      showError('That picture couldn’t be opened — try a flat PNG or JPEG.');
      return;
    }
    fileLabelEl.textContent = file.name;
    showError('');
    if (state.sizemode === 'custom') seedCustomInputs();
    else { customWEl.disabled = false; customHEl.disabled = false; }
    recompute();
  }

  wireSeg(paperSeg, (value) => { state.paper = value; syncSeg(paperSeg, value); recompute(); });
  wireSeg(orientSeg, (value) => { state.orient = value; syncSeg(orientSeg, value); recompute(); });
  wireSeg(sizemodeSeg, (value) => {
    state.sizemode = value;
    syncSeg(sizemodeSeg, value);
    syncSizeRows();
    recompute();
  });

  fileInput.addEventListener('change', () => acceptFile(fileInput.files && fileInput.files[0]));

  dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('dragging'); });
  dropZone.addEventListener('dragleave', (e) => { e.preventDefault(); dropZone.classList.remove('dragging'); });
  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragging');
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) acceptFile(f);
  });
  // Guard the page itself so a stray drop can't navigate away.
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());

  dpiEl.addEventListener('change', () => { syncSizeRows(); recompute(); });
  dpiCustomEl.addEventListener('change', recompute);
  customUnitEl.addEventListener('change', () => {
    const next = customUnitEl.value;
    const prev = state.customUnit;
    const f = (next === 'cm' && prev === 'in') ? 2.54 : (next === 'in' && prev === 'cm') ? 1 / 2.54 : 1;
    if (f !== 1) {
      const w = parseFloat(customWEl.value);
      const h = parseFloat(customHEl.value);
      if (isFinite(w)) customWEl.value = (w * f).toFixed(2);
      if (isFinite(h)) customHEl.value = (h * f).toFixed(2);
    }
    state.customUnit = next;
    recompute();
  });
  customWEl.addEventListener('input', () => {
    if (!bitmap) return;
    const w = parseFloat(customWEl.value);
    const aspect = bitmap.width / bitmap.height;
    if (isFinite(w) && w > 0) customHEl.value = (w / aspect).toFixed(2);
    recompute();
  });
  customHEl.addEventListener('input', () => {
    if (!bitmap) return;
    const h = parseFloat(customHEl.value);
    const aspect = bitmap.width / bitmap.height;
    if (isFinite(h) && h > 0) customWEl.value = (h * aspect).toFixed(2);
    recompute();
  });
  mirrorEl.addEventListener('change', recompute);
  downloadBtn.addEventListener('click', downloadPdf);

  if (typeof PDFLib === 'undefined') {
    window.addEventListener('load', () => {
      if (typeof PDFLib === 'undefined' && bitmap) recompute();
    });
  }
}

// Export pure functions for headless verification (node/bun).
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { SHEET_PX, tileSize, gridFor, pickAuto, composeOffsets, BG, isSupportedFile, tilePxForDpi, tilePixels, printSizeIn, customDpiForWidth };
}
