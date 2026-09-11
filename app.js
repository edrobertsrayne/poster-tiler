// Poster Tiler v1: native/unstretched fit only, 72 dpi fixed, sRGB-out. Mirror is an optional horizontal flip at compose time.
'use strict';

// Geometry constants: mm x 72 / 25.4 rounded. At 72 dpi 1 px = 1 pt,
// so these are both tile pixels and PDF page points.
const SHEET_PX = {
  A4: { portrait: [595, 842] },
  A3: { portrait: [842, 1191] },
};
const BG = '#ffffff';
const UNSUPPORTED_RE = /\.(tif|tiff|psd|psb|xcf)$/i;

function tileSize(paper, orient) {
  const [w, h] = SHEET_PX[paper].portrait;
  return orient === 'landscape' ? [h, w] : [w, h];
}

function gridFor(imgW, imgH, tw, th) {
  const cols = Math.ceil(imgW / tw);
  const rows = Math.ceil(imgH / th);
  return { cols, rows, sheets: cols * rows };
}

function fmtGrid(g) {
  return `${g.cols}\u00D7${g.rows} = ${g.sheets} sheet${g.sheets === 1 ? '' : 's'}`;
}

// Auto-orientation = fewest sheets; tie-break by source aspect:
// landscape if imgW >= imgH else portrait.
function pickAuto(paper, imgW, imgH) {
  const [ptw, pth] = tileSize(paper, 'portrait');
  const [ltw, lth] = tileSize(paper, 'landscape');
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

// ---- browser wiring (skipped under node/bun test harness) ----
if (typeof document !== 'undefined') {
  const fileInput = document.getElementById('file');
  const preview = document.getElementById('preview');
  const sheetInfo = document.getElementById('sheetInfo');
  const downloadBtn = document.getElementById('download');

  let bitmap = null; // decoded source image
  let composed = null; // { canvas, cols, rows, tw, th, orient, paper }

  function selectedPaper() {
    const el = document.querySelector('input[name="paper"]:checked');
    return el ? el.value : 'A4';
  }

  function selectedOrientMode() {
    const el = document.querySelector('input[name="orient"]:checked');
    return el ? el.value : 'auto';
  }

  function selectedMirror() {
    const el = document.getElementById('mirror');
    return !!(el && el.checked);
  }

  function setError(msg) {
    sheetInfo.innerHTML = '';
    const span = document.createElement('span');
    span.className = 'error';
    span.textContent = msg;
    sheetInfo.appendChild(span);
  }

  function isUnsupported(file) {
    if (/^image\/(tiff|vnd\.adobe\.photoshop|x-xcf)$/i.test(file.type)) return true;
    return UNSUPPORTED_RE.test(file.name || '');
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

  function recompute() {
    if (!bitmap) {
      downloadBtn.disabled = true;
      return;
    }
    const imgW = bitmap.width;
    const imgH = bitmap.height;
    const paper = selectedPaper();
    const mode = selectedOrientMode();
    const { winner, portrait, landscape } = pickAuto(paper, imgW, imgH);
    const orient = mode === 'auto' ? winner : mode;
    const [tw, th] = tileSize(paper, orient);
    const g = orient === 'portrait' ? portrait : landscape;
    const other = orient === 'portrait' ? landscape : portrait;
    const otherOrient = orient === 'portrait' ? 'landscape' : 'portrait';

    const canvasW = g.cols * tw;
    const canvasH = g.rows * th;
    // Clean composed canvas (white + centred source, no overlay): the slice source.
    const clean = document.createElement('canvas');
    clean.width = canvasW;
    clean.height = canvasH;
    const cleanCtx = clean.getContext('2d');
    cleanCtx.fillStyle = BG;
    cleanCtx.fillRect(0, 0, canvasW, canvasH);
    const { dx, dy } = composeOffsets(canvasW, canvasH, imgW, imgH);
    if (selectedMirror()) {
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

    composed = { canvas: clean, cols: g.cols, rows: g.rows, tw, th, orient, paper, mirror: selectedMirror() };

    // Readout.
    sheetInfo.innerHTML = '';
    const autoLine = mode === 'auto'
      ? `Auto: ${orient} ${fmtGrid(g)}`
      : `${orient} ${fmtGrid(g)} (auto would be ${winner})`;
    const otherLine = `${otherOrient} would be ${fmtGrid(other)}`;
    const p1 = document.createElement('div');
    p1.textContent = autoLine;
    const p2 = document.createElement('div');
    p2.textContent = `(${otherLine})`;
    sheetInfo.appendChild(p1);
    sheetInfo.appendChild(p2);

    // Blank-tile warning (never silently blank): sample each tile of the clean
    // compose and flag one that is entirely padding.
    const blankest = blankestTile(cleanCtx, canvasW, canvasH, tw, th, g.cols, g.rows);
    if (blankest.entirelyBlank) {
      const warn = document.createElement('div');
      warn.className = 'warning';
      warn.textContent = `This fit leaves tile r${blankest.row}c${blankest.col} entirely blank — consider the other orientation`;
      sheetInfo.appendChild(warn);
    }

    downloadBtn.disabled = typeof PDFLib === 'undefined';
    if (typeof PDFLib === 'undefined') {
      const err = document.createElement('div');
      err.className = 'error';
      err.textContent = 'PDF library failed to load — check network and reload';
      sheetInfo.appendChild(err);
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
    const { canvas, cols, rows, tw, th, orient, paper } = composed;
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
        const page = pdfDoc.addPage([tw, th]);
        page.drawImage(img, { x: 0, y: 0, width: tw, height: th });
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

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files && fileInput.files[0];
    composed = null;
    downloadBtn.disabled = true;
    if (!file) return;
    if (isUnsupported(file)) {
      bitmap = null;
      setError('Export a flattened PNG/JPEG/WebP first — this format is not supported in-browser');
      return;
    }
    try {
      bitmap = await decodeFile(file);
    } catch (_) {
      bitmap = null;
      setError('Could not decode that image — try a flattened PNG/JPEG/WebP');
      return;
    }
    recompute();
  });

  document.querySelectorAll('input[name="paper"], input[name="orient"], #mirror').forEach((el) => {
    el.addEventListener('change', recompute);
  });
  downloadBtn.addEventListener('click', downloadPdf);

  if (typeof PDFLib === 'undefined') {
    window.addEventListener('load', () => {
      if (typeof PDFLib === 'undefined' && bitmap) recompute();
    });
  }
}

// Export pure functions for headless verification (node/bun).
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { SHEET_PX, tileSize, gridFor, pickAuto, composeOffsets, BG };
}
