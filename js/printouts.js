// printouts.js
// Marketing > Print Outs > Flip Cards: upload a Canva flier, keep it at full
// size (8.5x11) or turn it sideways and split it into two half-sheet flip
// pages (5.5x8.5), then print one or many from the Saved Fliers list.
// Images are stored in the public 'assets' bucket under flip/<id>/ and listed
// in the flip_designs table (migration_053).
// Depends on: window.supabase, toast(), escHtml(), openHtml(), flipStatus(),
// HALF_BASE_CSS, FLIP_BEER_CSS (js/menu.js)

let flierImg = null, flierFile = null, flierPages = [], flierSaving = false;
let flierList = [], flierSelected = {};

function openFlierUpload() {
  flierImg = null; flierFile = null; flierPages = [];
  document.getElementById('flier-name').value = '';
  document.getElementById('flier-file').value = '';
  document.getElementById('flier-mode-wrap').style.display = 'none';
  document.getElementById('flier-preview').innerHTML = '';
  document.getElementById('flier-save').disabled = true;
  document.getElementById('flier-modal').style.display = 'flex';
}
function closeFlierUpload() { document.getElementById('flier-modal').style.display = 'none'; }

function flierMode() { return document.querySelector('input[name="flier-mode"]:checked').value; }

function onFlierFile(input) {
  const file = input.files && input.files[0];
  if (!file) return;
  const img = new Image();
  img.onload = () => {
    flierImg = img; flierFile = file;
    const nameEl = document.getElementById('flier-name');
    if (!nameEl.value.trim()) nameEl.value = file.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ');
    const portrait = img.naturalHeight >= img.naturalWidth;
    // A landscape upload is already sideways: it can only be split left/right.
    const keepRadio = document.querySelector('input[name="flier-mode"][value="keep"]');
    const splitRadio = document.querySelector('input[name="flier-mode"][value="split"]');
    keepRadio.disabled = !portrait;
    (portrait ? keepRadio : splitRadio).checked = true;
    document.getElementById('flier-dir-wrap').style.display = portrait ? 'block' : 'none';
    document.getElementById('flier-mode-wrap').style.display = 'block';
    renderFlierPreview();
  };
  img.onerror = () => toast('Could not read that image.', true);
  img.src = URL.createObjectURL(file);
}

// Turn a portrait flier sideways, then cut the landscape sheet into left and right halves.
function splitFlierCanvases(img, dir) {
  const W = img.naturalWidth, H = img.naturalHeight;
  const portrait = H >= W;
  const lw = portrait ? H : W, lh = portrait ? W : H;
  const land = document.createElement('canvas');
  land.width = lw; land.height = lh;
  const ctx = land.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, lw, lh);
  if (portrait) {
    if (dir === 'ccw') { ctx.translate(0, lh); ctx.rotate(-Math.PI / 2); } else { ctx.translate(lw, 0); ctx.rotate(Math.PI / 2); }
  }
  ctx.drawImage(img, 0, 0);
  const half = Math.floor(lw / 2);
  return [0, 1].map((i) => {
    const c = document.createElement('canvas');
    c.width = half; c.height = lh;
    c.getContext('2d').drawImage(land, i * half, 0, half, lh, 0, 0, half, lh);
    return c;
  });
}

function renderFlierPreview() {
  if (!flierImg) return;
  const mode = flierMode();
  const W = flierImg.naturalWidth, H = flierImg.naturalHeight;
  const portrait = H >= W;
  const prev = document.getElementById('flier-preview');
  prev.innerHTML = '';
  flierPages = [];
  let dpi;
  if (mode === 'keep') {
    dpi = Math.min(W / 8.5, H / 11);
    const im = document.createElement('img');
    im.src = flierImg.src;
    im.style.cssText = 'height:240px;border:1px solid var(--border);';
    prev.appendChild(im);
  } else {
    const [a, b] = splitFlierCanvases(flierImg, document.getElementById('flier-dir').value);
    flierPages = [a, b];
    dpi = Math.min(a.width / 5.5, a.height / 8.5);
    [a, b].forEach((c) => {
      const im = document.createElement('img');
      im.src = c.toDataURL('image/jpeg', 0.6);
      im.style.cssText = 'height:240px;border:1px solid var(--border);';
      prev.appendChild(im);
    });
  }
  const res = document.getElementById('flier-res');
  const ok = dpi >= 150;
  res.style.color = ok ? 'var(--teal)' : '#e5484d';
  res.textContent = Math.round(dpi) + ' DPI at print size' + (ok ? '' : ' — low; export a larger PNG or use a Canva size multiplier');
  if (!portrait && mode === 'split') res.textContent += ' · landscape upload split left/right';
  document.getElementById('flier-save').disabled = false;
}

function flierBlob(canvas) {
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92));
}

async function saveFlier() {
  if (flierSaving || !flierImg) return;
  const name = document.getElementById('flier-name').value.trim();
  if (!name) { toast('Give the flier a name.', true); return; }
  flierSaving = true;
  const btn = document.getElementById('flier-save');
  btn.disabled = true; btn.textContent = 'Saving...';
  const id = crypto.randomUUID();
  const mode = flierMode();
  const bucket = window.supabase.storage.from('assets');
  const uploaded = [];
  try {
    const ext = flierFile.type === 'image/png' ? 'png' : 'jpg';
    const srcPath = 'flip/' + id + '/original.' + ext;
    let r = await bucket.upload(srcPath, flierFile, { contentType: flierFile.type });
    if (r.error) throw r.error;
    uploaded.push(srcPath);
    const source_url = bucket.getPublicUrl(srcPath).data.publicUrl;
    let pages;
    if (mode === 'keep') {
      pages = [source_url];
    } else {
      pages = [];
      for (let i = 0; i < flierPages.length; i++) {
        const path = 'flip/' + id + '/page-' + (i + 1) + '.jpg';
        r = await bucket.upload(path, await flierBlob(flierPages[i]), { contentType: 'image/jpeg' });
        if (r.error) throw r.error;
        uploaded.push(path);
        pages.push(bucket.getPublicUrl(path).data.publicUrl);
      }
    }
    const { error } = await window.supabase.from('flip_designs').insert({ id, name, size: mode === 'keep' ? 'full' : 'half', pages, source_url });
    if (error) throw error;
    closeFlierUpload();
    toast('Flier saved.');
    loadFlipDesigns();
  } catch (e) {
    if (uploaded.length) await bucket.remove(uploaded); // best effort; nothing references these yet
    toast('Save failed: ' + (e.message || e), true);
  } finally {
    flierSaving = false;
    btn.disabled = false; btn.textContent = 'Save';
  }
}

async function loadFlipDesigns() {
  const grid = document.getElementById('flier-grid');
  if (!grid) return;
  let q = window.supabase.from('flip_designs').select('*').order('created_at', { ascending: false });
  if (!document.getElementById('flier-show-archived').checked) q = q.eq('archived', false);
  const { data, error } = await q;
  if (error) { grid.innerHTML = '<div class="loading">Could not load fliers: ' + escHtml(error.message) + '</div>'; return; }
  flierList = data || [];
  Object.keys(flierSelected).forEach((id) => { if (!flierList.some((d) => d.id === id)) delete flierSelected[id]; });
  if (!flierList.length) { grid.innerHTML = '<div class="loading">No saved fliers yet — upload one above.</div>'; updateFlierBatchBtn(); return; }
  grid.innerHTML = flierList.map((d) => {
    const label = d.size === 'full' ? '8.5×11 · 1 page' : '5.5×8.5 · ' + d.pages.length + ' page' + (d.pages.length !== 1 ? 's' : '');
    return '<div class="gen-card" style="position:relative;' + (d.archived ? 'opacity:0.55;' : '') + '">'
      + '<label style="position:absolute;top:12px;right:12px;"><input type="checkbox" ' + (flierSelected[d.id] ? 'checked ' : '') + 'onchange="toggleFlierSelect(\'' + d.id + '\', this.checked)"></label>'
      + '<img src="' + escHtml(d.pages[0] || '') + '" style="height:120px;max-width:100%;object-fit:contain;align-self:flex-start;border:1px solid var(--border);margin-bottom:8px;">'
      + '<div class="gen-card-title">' + escHtml(d.name) + '</div>'
      + '<div class="gen-card-desc">' + label + (d.archived ? ' · archived' : '') + '</div>'
      + '<div style="display:flex;gap:6px;flex-wrap:wrap;">'
      + '<button class="btn btn-primary btn-sm" onclick="printFlierById(\'' + d.id + '\')">Print</button>'
      + '<button class="btn btn-secondary btn-sm" onclick="renameFlier(\'' + d.id + '\')">Rename</button>'
      + '<button class="btn btn-secondary btn-sm" onclick="archiveFlier(\'' + d.id + '\', ' + !d.archived + ')">' + (d.archived ? 'Restore' : 'Archive') + '</button>'
      + '</div></div>';
  }).join('');
  updateFlierBatchBtn();
}

function toggleFlierSelect(id, on) {
  if (on) flierSelected[id] = true; else delete flierSelected[id];
  updateFlierBatchBtn();
}
function updateFlierBatchBtn() {
  const n = Object.keys(flierSelected).length;
  const btn = document.getElementById('flier-batch-btn');
  btn.disabled = !n;
  btn.textContent = n ? 'Print Selected (' + n + ')' : 'Print Selected';
}

async function renameFlier(id) {
  const d = flierList.find((x) => x.id === id);
  const name = d && prompt('Rename flier:', d.name);
  if (!name || !name.trim() || name.trim() === d.name) return;
  const { error } = await window.supabase.from('flip_designs').update({ name: name.trim() }).eq('id', id);
  if (error) { toast('Rename failed: ' + error.message, true); return; }
  loadFlipDesigns();
}
async function archiveFlier(id, archived) {
  const { error } = await window.supabase.from('flip_designs').update({ archived }).eq('id', id);
  if (error) { toast('Update failed: ' + error.message, true); return; }
  toast(archived ? 'Flier archived.' : 'Flier restored.');
  loadFlipDesigns();
}

function printFlierById(id) { printFliers(flierList.filter((d) => d.id === id)); }
function printSelectedFliers() { printFliers(flierList.filter((d) => flierSelected[d.id])); }

// Print window: half-size fliers share a sheet (a one-page flier prints twice,
// a split flier prints both halves); 8.5x11 fliers get a sheet each. The
// toolbar is screen-only and toggles the print helpers.
function buildFlierHtml(designs) {
  const img = (u) => '<div class="fl-wrap"><img class="fl-img" src="' + escHtml(u) + '"></div>';
  const slot = (u) => '<div class="half-slot"><div class="half-card">' + img(u) + '</div></div>';
  let pages = '';
  designs.forEach((d) => {
    if (d.size === 'full') {
      d.pages.forEach((u) => { pages += '<div class="page">' + img(u) + '</div>'; });
    } else {
      const p = d.pages.length === 1 ? [d.pages[0], d.pages[0]] : d.pages;
      for (let i = 0; i < p.length; i += 2) {
        pages += '<div class="page">' + slot(p[i]) + '<div class="cut-line"></div><div class="crop crop-l"></div><div class="crop crop-r"></div>' + (p[i + 1] ? slot(p[i + 1]) : '<div class="half-slot"></div>') + '</div>';
      }
    }
  });
  const css = '.fl-wrap{width:100%;height:100%;}.fl-img{width:100%;height:100%;object-fit:cover;display:block;}.half-card{padding:0!important;}'
    + 'body.fit .fl-wrap{padding:0.25in;}body.fit .fl-img{object-fit:contain;}'
    + '.crop{display:none;position:absolute;top:5.5in;width:0.2in;border-top:1px solid #000;box-shadow:0 0 0 0.5px #fff;z-index:11;}.crop-l{left:0;}.crop-r{right:0;}body.marks .crop{display:block;}body.marks .cut-line{display:none;}'
    + '.bar{position:fixed;top:0;left:0;right:0;background:#222;color:#eee;font:13px sans-serif;padding:8px 14px;display:flex;gap:18px;align-items:center;z-index:50;}.bar button{padding:5px 12px;cursor:pointer;}body{padding-top:44px;}'
    + '@media print{.bar{display:none;}body{padding-top:0;}}';
  const bar = '<div class="bar"><b>Print helpers</b>'
    + '<label><input type="checkbox" onchange="document.body.classList.toggle(\'marks\',this.checked)"> Cut marks (half sheets)</label>'
    + '<label><input type="checkbox" onchange="document.body.classList.toggle(\'fit\',this.checked)"> Fit inside printer margins</label>'
    + '<span style="opacity:0.7">Print at 100% scale, no margins.</span><button onclick="window.print()">Print</button></div>';
  return '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Fliers — Lago Vista Brewing</title><style>' + HALF_BASE_CSS + FLIP_BEER_CSS + css + '</style></head><body>' + bar + pages + '</body></html>';
}

function printFliers(designs) {
  if (!designs.length) return;
  openHtml(buildFlierHtml(designs));
  flipStatus(designs.length + ' flier' + (designs.length !== 1 ? 's' : '') + ' opened for printing.');
}
