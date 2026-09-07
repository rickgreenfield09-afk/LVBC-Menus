// menu.js
// Screen: #screen-menu (sub-tabs: Tap List, Wine & N/A, Menu Generator)
// Ported from the standalone "LVBC — Beers & Menus" MVP onto the staff
// panel's Supabase client + auth. Browsing is available to any signed-in
// staff; add/edit/retire/upload controls only render for
// window.currentStaff.role === 'admin' (also enforced by RLS on beers
// and wine_menu — see supabase/schema.sql).
// Depends on: window.supabase, toast()

function isMenuAdmin() {
  return !!(window.currentStaff && window.currentStaff.role === 'admin');
}

function escHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function parseCurrency(id) {
  const v = document.getElementById(id).value.replace(/[^0-9.]/g, '');
  return v ? parseFloat(v) : null;
}

let beers = [], selBeer = null, beerEditMode = false, beerFilter = 'active';
let wines = [], selWine = null, wineEditMode = false, wineFilter = 'active';
let beerImgFile = null, beerImgUrl = null;
let labelBeerList = [], labelSelected = {};

// ── ENTRY / TABS ───────────────────────────────────────────
function loadMenu() {
  const admin = isMenuAdmin();
  document.getElementById('beer-form-col').style.display = admin ? '' : 'none';
  document.getElementById('wine-form-col').style.display = admin ? '' : 'none';
  loadBeers();
}

function setMenuTab(tab, btn) {
  document.querySelectorAll('#screen-menu .sub-tab').forEach((b) => b.classList.remove('active'));
  document.querySelectorAll('#screen-menu .sub-sec').forEach((s) => s.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById('menutab-' + tab).classList.add('active');
  if (tab === 'taplist') { cancelWineEdit(); loadBeers(); }
  if (tab === 'wine') { cancelBeerEdit(); loadWines(); }
  if (tab === 'gen') { cancelBeerEdit(); cancelWineEdit(); }
}

// ── BEERS: TAP LIST ────────────────────────────────────────
async function loadBeers() {
  const el = document.getElementById('beer-list');
  el.innerHTML = '<div class="loading">Loading...</div>';
  const { data, error } = await window.supabase.from('beers').select('*').order('category', { ascending: true }).order('name', { ascending: true });
  if (error) { el.innerHTML = '<div class="loading">Error: ' + escHtml(error.message) + '</div>'; return; }
  beers = data || [];
  renderBeers();
}

function setBeerFilter(status) {
  beerFilter = status;
  document.getElementById('bf-current').classList.toggle('active', status === 'active');
  document.getElementById('bf-retired').classList.toggle('active', status === 'archived');
  selBeer = null;
  renderBeers();
}

function makeBeerStatusBadge(b) {
  if (b.status === 'archived') return '<span class="badge badge-red">Retired</span>';
  return '<span style="font-size:11px;color:var(--muted)">Active</span>';
}

function renderBeers() {
  const el = document.getElementById('beer-list');
  const admin = isMenuAdmin();
  const list = beers.filter((b) => (beerFilter === 'archived' ? b.status === 'archived' : b.status === 'active'));
  if (!list.length) {
    el.innerHTML = '<div class="loading">' + (beerFilter === 'archived' ? 'No archived beers' : 'No active beers') + '</div>';
    return;
  }
  const order = ['Light & Lager', 'Ales & IPAs', 'Strong & Specialty', 'Dark', 'Guest Tap', 'Non-Alcoholic', 'Uncategorized'];
  const cats = {};
  list.forEach((b) => {
    const c = b.category || 'Uncategorized';
    (cats[c] = cats[c] || []).push(b);
  });
  let rows = '';
  order.forEach((cat) => {
    if (!cats[cat]) return;
    rows += '<tr><td colspan="5" style="background:var(--raised);font-size:10px;font-family:\'DM Mono\',monospace;color:var(--muted);letter-spacing:2px;text-transform:uppercase;padding:6px 16px">' + escHtml(cat) + '</td></tr>';
    cats[cat].forEach((b) => {
      const sel = b.id === selBeer;
      rows += '<tr style="cursor:' + (admin ? 'pointer' : 'default') + (sel ? ';background:rgba(42,184,166,0.06)' : '') + '"' + (admin ? ' onclick="pickBeer(\'' + b.id + '\')"' : '') + '>'
        + '<td style="font-family:\'DM Mono\',monospace;font-size:11px;color:var(--muted)">' + escHtml(b.ref_id || '') + '</td>'
        + '<td style="font-weight:500' + (sel ? ';color:var(--teal)' : '') + '">' + escHtml(b.name) + '</td>'
        + '<td style="font-size:12px;color:var(--sub)">' + escHtml(b.style || '') + '</td>'
        + '<td style="font-family:\'DM Mono\',monospace;font-size:12px">' + (b.abv ? b.abv + '%' : '') + '</td>'
        + '<td>' + makeBeerStatusBadge(b) + '</td></tr>';
    });
  });
  el.innerHTML = '<div class="table-wrap"><table><thead><tr><th>#</th><th>Name</th><th>Style</th><th>ABV</th><th>Status</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
}

function pickBeer(id) {
  if (!isMenuAdmin()) return;
  selBeer = id;
  renderBeers();
  const b = beers.find((x) => x.id === id);
  if (b) loadBeerIntoForm(b);
}

function loadBeerIntoForm(b) {
  beerEditMode = true;
  selBeer = b.id;
  document.getElementById('bn-form-label').textContent = 'Edit Beer';
  document.getElementById('btn-save-beer').textContent = 'Save Changes';
  document.getElementById('bn-cancel-edit').style.visibility = 'visible';
  document.getElementById('bn-name').value = b.name || '';
  document.getElementById('bn-style').value = b.style || '';
  document.getElementById('bn-abv').value = b.abv != null ? b.abv : '';
  document.getElementById('bn-price').value = b.price != null ? Number(b.price).toFixed(2) : '';
  const catSel = document.getElementById('bn-cat');
  catSel.value = b.category || '';
  document.getElementById('bn-desc').value = b.description || '';
  document.getElementById('bn-longdesc').value = b.long_description || '';
  setBeerImagePreview(b.image_url || null);

  const old = document.getElementById('bn-archive-btn');
  if (old) old.remove();
  const abtn = document.createElement('button');
  abtn.id = 'bn-archive-btn';
  if (b.status !== 'archived') {
    abtn.className = 'btn btn-sm btn-danger';
    abtn.textContent = 'Retire Beer';
    abtn.addEventListener('click', () => retireBeer(b.id, b.name));
  } else {
    abtn.className = 'btn btn-sm btn-success';
    abtn.textContent = 'Restore to Tap';
    abtn.addEventListener('click', () => restoreBeer(b.id, b.name));
  }
  document.getElementById('btn-save-beer').parentNode.insertBefore(abtn, document.getElementById('btn-save-beer'));
  document.getElementById('bn-name').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function cancelBeerEdit() {
  beerEditMode = false;
  selBeer = null;
  const label = document.getElementById('bn-form-label');
  if (!label) return;
  label.textContent = 'Add New Beer';
  document.getElementById('btn-save-beer').textContent = 'Add Beer to Tap List';
  document.getElementById('bn-cancel-edit').style.visibility = 'hidden';
  ['bn-name', 'bn-style', 'bn-abv', 'bn-price'].forEach((id) => { document.getElementById(id).value = ''; });
  document.getElementById('bn-desc').value = '';
  document.getElementById('bn-longdesc').value = '';
  document.getElementById('bn-cat').value = '';
  clearBeerImage();
  const old = document.getElementById('bn-archive-btn');
  if (old) old.remove();
  if (beers.length) renderBeers();
}

async function saveBeer() {
  const name = document.getElementById('bn-name').value.trim();
  if (!name) { beerAlert('Name required', true); return; }
  const cat = document.getElementById('bn-cat').value;
  if (!cat) { beerAlert('Category required', true); return; }

  const payload = {
    name,
    style: document.getElementById('bn-style').value.trim() || null,
    abv: parseFloat(document.getElementById('bn-abv').value) || null,
    price: parseCurrency('bn-price'),
    description: document.getElementById('bn-desc').value.trim() || null,
    long_description: document.getElementById('bn-longdesc').value.trim() || null,
    category: cat,
  };

  try {
    let savedId = selBeer;
    if (beerEditMode && selBeer) {
      const { error } = await window.supabase.from('beers').update(payload).eq('id', selBeer);
      if (error) throw error;
    } else {
      payload.status = 'active';
      const { data, error } = await window.supabase.from('beers').insert(payload).select().single();
      if (error) throw error;
      savedId = data.id;
    }
    if (beerImgFile && savedId) {
      const imgUrl = await uploadBeerImage(savedId);
      await window.supabase.from('beers').update({ image_url: imgUrl }).eq('id', savedId);
    } else if (beerImgUrl === null && beerEditMode && selBeer) {
      await window.supabase.from('beers').update({ image_url: null }).eq('id', selBeer);
    }
    toast(name + (beerEditMode ? ' updated' : ' added'));
    cancelBeerEdit();
    await loadBeers();
  } catch (e) {
    beerAlert('Error: ' + e.message, true);
  }
}

async function retireBeer(id, name) {
  if (!confirm('Retire ' + name + '? Can be restored later.')) return;
  const { error } = await window.supabase.from('beers').update({ status: 'archived' }).eq('id', id);
  if (error) { toast('Error retiring beer', true); return; }
  toast(name + ' retired');
  cancelBeerEdit();
  setBeerFilter('active');
  await loadBeers();
}

async function restoreBeer(id, name) {
  if (!confirm('Restore ' + name + ' to tap list?')) return;
  const { error } = await window.supabase.from('beers').update({ status: 'active' }).eq('id', id);
  if (error) { toast('Error restoring beer', true); return; }
  toast(name + ' restored');
  cancelBeerEdit();
  setBeerFilter('active');
  await loadBeers();
}

function beerAlert(msg, isError) {
  const el = document.getElementById('beer-alert');
  el.textContent = msg;
  el.style.display = 'block';
  el.style.background = isError ? 'rgba(224,82,82,0.15)' : 'rgba(42,184,166,0.15)';
  el.style.border = '1px solid ' + (isError ? 'var(--red)' : 'var(--teal)');
  el.style.color = isError ? 'var(--red)' : 'var(--teal)';
  setTimeout(() => { el.style.display = 'none'; }, 4000);
}

// ── BEER PHOTO (Supabase Storage, bucket "assets") ──────────
function setBeerImagePreview(url) {
  beerImgUrl = url;
  beerImgFile = null;
  const prev = document.getElementById('bn-img-preview');
  const clr = document.getElementById('bn-img-clear');
  const nm = document.getElementById('bn-img-name');
  if (url) {
    prev.innerHTML = '<img src="' + escHtml(url) + '" style="width:100%;height:100%;object-fit:cover;">';
    clr.style.display = '';
    nm.textContent = 'Current image';
  } else {
    prev.innerHTML = '<span style="font-size:10px;color:var(--muted);font-family:\'DM Mono\',monospace;">NO IMG</span>';
    clr.style.display = 'none';
    nm.textContent = '';
  }
}
function clearBeerImage() {
  beerImgFile = null;
  beerImgUrl = null;
  document.getElementById('bn-img-preview').innerHTML = '<span style="font-size:10px;color:var(--muted);font-family:\'DM Mono\',monospace;">NO IMG</span>';
  document.getElementById('bn-img-clear').style.display = 'none';
  document.getElementById('bn-img-name').textContent = '';
  document.getElementById('bn-img-file').value = '';
}
document.getElementById('bn-img-file').addEventListener('change', function () {
  const f = this.files[0];
  if (!f) return;
  beerImgFile = f;
  const r = new FileReader();
  r.onload = (e) => {
    beerImgUrl = e.target.result;
    document.getElementById('bn-img-preview').innerHTML = '<img src="' + e.target.result + '" style="width:100%;height:100%;object-fit:cover;">';
    document.getElementById('bn-img-clear').style.display = '';
    document.getElementById('bn-img-name').textContent = f.name;
  };
  r.readAsDataURL(f);
});
async function uploadBeerImage(beerId) {
  if (!beerImgFile) return beerImgUrl;
  const ext = beerImgFile.name.split('.').pop();
  const path = 'beers/' + beerId + '.' + ext;
  const { error } = await window.supabase.storage.from('assets').upload(path, beerImgFile, { upsert: true });
  if (error) throw new Error('Image upload failed: ' + error.message);
  return window.supabase.storage.from('assets').getPublicUrl(path).data.publicUrl;
}

// ── WINE & N/A ───────────────────────────────────────────────
async function loadWines() {
  const el = document.getElementById('wine-list');
  el.innerHTML = '<div class="loading">Loading...</div>';
  const { data, error } = await window.supabase.from('wine_menu').select('*');
  if (error) { el.innerHTML = '<div class="loading">Error: ' + escHtml(error.message) + '</div>'; return; }
  const groupOrder = { 'Wine by the Bottle': 0, 'Wine by the Glass': 1, 'N/A Beer': 2, 'N/A Options': 3 };
  wines = (data || []).sort((a, b) => {
    const ga = groupOrder[a.display_group] != null ? groupOrder[a.display_group] : 99;
    const gb = groupOrder[b.display_group] != null ? groupOrder[b.display_group] : 99;
    if (ga !== gb) return ga - gb;
    return (a.sort_order || 99) - (b.sort_order || 99);
  });
  renderWines();
}

function setWineFilterBtn(status) {
  wineFilter = status;
  document.getElementById('wf-active').classList.toggle('active', status === 'active');
  document.getElementById('wf-archived').classList.toggle('active', status === 'archived');
  selWine = null;
  renderWines();
}

function renderWines() {
  const el = document.getElementById('wine-list');
  const admin = isMenuAdmin();
  const list = wines.filter((w) => (wineFilter === 'archived' ? w.status === 'archived' : w.status === 'active'));
  if (!list.length) {
    el.innerHTML = '<div class="loading">' + (wineFilter === 'archived' ? 'No archived items' : 'No active items') + '</div>';
    return;
  }
  const groupOrder = ['Wine by the Bottle', 'Wine by the Glass', 'N/A Beer', 'N/A Options'];
  const groups = {};
  list.forEach((w) => { const g = w.display_group || 'Other'; (groups[g] = groups[g] || []).push(w); });
  let rows = '';
  groupOrder.forEach((grp) => {
    if (!groups[grp]) return;
    rows += '<tr><td colspan="5" style="background:var(--raised);font-size:10px;font-family:\'DM Mono\',monospace;color:var(--muted);letter-spacing:2px;text-transform:uppercase;padding:6px 16px">' + escHtml(grp) + '</td></tr>';
    groups[grp].forEach((w) => {
      const sel = w.id === selWine;
      rows += '<tr style="cursor:' + (admin ? 'pointer' : 'default') + (sel ? ';background:rgba(42,184,166,0.06)' : '') + '"' + (admin ? ' onclick="pickWine(\'' + w.id + '\')"' : '') + '>'
        + '<td style="font-weight:500' + (sel ? ';color:var(--teal)' : '') + '">' + escHtml(w.name) + '</td>'
        + '<td style="font-size:12px;color:var(--sub)">' + escHtml(w.winery || '') + '</td>'
        + '<td style="font-size:12px;color:var(--sub)">' + escHtml(w.type || '') + '</td>'
        + '<td style="font-family:\'DM Mono\',monospace;font-size:12px">' + (w.price_glass ? '$' + Number(w.price_glass).toFixed(2) : '') + '</td>'
        + '<td style="font-family:\'DM Mono\',monospace;font-size:12px">' + (w.price_bottle ? '$' + Number(w.price_bottle).toFixed(2) : '') + '</td></tr>';
    });
  });
  el.innerHTML = '<div class="table-wrap"><table><thead><tr><th>Name</th><th>Winery</th><th>Type</th><th>Glass/Unit</th><th>Bottle</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
}

function getWineTypeValue() {
  const sel = document.getElementById('wn-type-sel');
  if (sel.value === '__other__') return document.getElementById('wn-type-other').value.trim();
  return sel.value || '';
}
function setWineTypeValue(val) {
  const sel = document.getElementById('wn-type-sel');
  const other = document.getElementById('wn-type-other');
  let found = false;
  for (let i = 0; i < sel.options.length; i++) {
    if (sel.options[i].text === val || sel.options[i].value === val) { found = true; sel.value = sel.options[i].value; break; }
  }
  if (found && sel.value !== '__other__') {
    other.style.display = 'none';
  } else if (val) {
    sel.value = '__other__';
    other.style.display = 'block';
    other.value = val;
  } else {
    sel.value = '';
    other.style.display = 'none';
  }
}
document.getElementById('wn-type-sel').addEventListener('change', function () {
  document.getElementById('wn-type-other').style.display = this.value === '__other__' ? 'block' : 'none';
  if (this.value !== '__other__') document.getElementById('wn-type-other').value = '';
});

function pickWine(id) {
  if (!isMenuAdmin()) return;
  selWine = id;
  renderWines();
  const w = wines.find((x) => x.id === id);
  if (w) loadWineIntoForm(w);
}

function loadWineIntoForm(w) {
  wineEditMode = true;
  selWine = w.id;
  document.getElementById('wn-form-label').textContent = 'Edit Item';
  document.getElementById('btn-save-wine').textContent = 'Save Changes';
  document.getElementById('wn-cancel-edit').style.visibility = 'visible';
  document.getElementById('wn-name').value = w.name || '';
  document.getElementById('wn-winery').value = w.winery || '';
  document.getElementById('wn-region').value = w.region || '';
  setWineTypeValue(w.type || '');
  document.getElementById('wn-cat').value = w.category || '';
  document.getElementById('wn-group').value = w.display_group || '';
  document.getElementById('wn-desc').value = w.description || '';
  document.getElementById('wn-pglass').value = w.price_glass != null ? Number(w.price_glass).toFixed(2) : '';
  document.getElementById('wn-pbottle').value = w.price_bottle != null ? Number(w.price_bottle).toFixed(2) : '';

  const old = document.getElementById('wn-archive-btn');
  if (old) old.remove();
  const abtn = document.createElement('button');
  abtn.id = 'wn-archive-btn';
  if (w.status !== 'archived') {
    abtn.className = 'btn btn-sm btn-danger';
    abtn.textContent = 'Archive Item';
    abtn.addEventListener('click', () => archiveWine(w.id, w.name));
  } else {
    abtn.className = 'btn btn-sm btn-success';
    abtn.textContent = 'Restore Item';
    abtn.addEventListener('click', () => restoreWine(w.id, w.name));
  }
  document.getElementById('btn-save-wine').parentNode.insertBefore(abtn, document.getElementById('btn-save-wine'));
  document.getElementById('wn-name').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function cancelWineEdit() {
  wineEditMode = false;
  selWine = null;
  const label = document.getElementById('wn-form-label');
  if (!label) return;
  label.textContent = 'Add Item';
  document.getElementById('btn-save-wine').textContent = 'Add to Menu';
  document.getElementById('wn-cancel-edit').style.visibility = 'hidden';
  ['wn-name', 'wn-winery', 'wn-region', 'wn-desc', 'wn-pglass', 'wn-pbottle'].forEach((id) => { document.getElementById(id).value = ''; });
  document.getElementById('wn-type-sel').value = '';
  document.getElementById('wn-type-other').style.display = 'none';
  document.getElementById('wn-type-other').value = '';
  document.getElementById('wn-cat').value = '';
  document.getElementById('wn-group').value = '';
  const old = document.getElementById('wn-archive-btn');
  if (old) old.remove();
  if (wines.length) renderWines();
}

async function saveWine() {
  const name = document.getElementById('wn-name').value.trim();
  if (!name) { wineAlert('Name required', true); return; }
  const payload = {
    name,
    winery: document.getElementById('wn-winery').value.trim() || null,
    region: document.getElementById('wn-region').value.trim() || null,
    type: getWineTypeValue() || null,
    category: document.getElementById('wn-cat').value || null,
    display_group: document.getElementById('wn-group').value || null,
    description: document.getElementById('wn-desc').value.trim() || null,
    price_glass: parseCurrency('wn-pglass'),
    price_bottle: parseCurrency('wn-pbottle'),
  };
  try {
    if (wineEditMode && selWine) {
      const { error } = await window.supabase.from('wine_menu').update(payload).eq('id', selWine);
      if (error) throw error;
      toast(name + ' updated');
    } else {
      payload.status = 'active';
      const { error } = await window.supabase.from('wine_menu').insert(payload);
      if (error) throw error;
      toast(name + ' added');
    }
    cancelWineEdit();
    await loadWines();
  } catch (e) {
    wineAlert('Error: ' + e.message, true);
  }
}

function wineAlert(msg, isError) {
  const el = document.getElementById('wine-alert');
  el.textContent = msg;
  el.style.display = 'block';
  el.style.background = isError ? 'rgba(224,82,82,0.15)' : 'rgba(42,184,166,0.15)';
  el.style.border = '1px solid ' + (isError ? 'var(--red)' : 'var(--teal)');
  el.style.color = isError ? 'var(--red)' : 'var(--teal)';
  setTimeout(() => { el.style.display = 'none'; }, 4000);
}

async function archiveWine(id, name) {
  if (!confirm('Archive ' + name + '?')) return;
  const { error } = await window.supabase.from('wine_menu').update({ status: 'archived' }).eq('id', id);
  if (error) { toast('Error', true); return; }
  toast(name + ' archived');
  cancelWineEdit();
  await loadWines();
}
async function restoreWine(id, name) {
  if (!confirm('Restore ' + name + ' to active?')) return;
  const { error } = await window.supabase.from('wine_menu').update({ status: 'active' }).eq('id', id);
  if (error) { toast('Error', true); return; }
  toast(name + ' restored');
  setWineFilterBtn('active');
  cancelWineEdit();
  await loadWines();
}

// ── MENU GENERATOR (print-ready HTML, opened in a new tab) ──
function fmtP(n) { return n ? '$' + Number(n).toFixed(2).replace(/\.00$/, '') : ''; }
function genStatus(msg) { const el = document.getElementById('gen-status'); if (el) el.textContent = msg; }
function openHtml(html) {
  const blob = new Blob([html], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  window.open(url, '_blank');
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
const FONT_LINK = '<link href="https://fonts.googleapis.com/css2?family=Oswald:wght@500;600;700&family=Inter:ital,wght@0,300;0,400;0,600;0,700;1,300;1,400&display=swap" rel="stylesheet">';
const PRINT_RESET = '@media print{*{-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important;}@page{size:8.5in 11in;margin:0;}body{margin:0;}}';
const LOGO_URL = (window.LVBC_CONFIG.SUPABASE_URL || '') + '/storage/v1/object/public/assets/lvbc-logo.png';

async function fetchBeersForMenu() {
  const { data } = await window.supabase.from('beers').select('*').eq('status', 'active').order('name', { ascending: true });
  const rows = data || [];
  const CAT_ORDER = ['Light & Lager', 'Ales & IPAs', 'Strong & Specialty', 'Dark', 'Guest Tap', 'Non-Alcoholic'];
  rows.sort((a, b) => {
    let ai = CAT_ORDER.indexOf(a.category || ''); if (ai === -1) ai = 99;
    let bi = CAT_ORDER.indexOf(b.category || ''); if (bi === -1) bi = 99;
    if (ai !== bi) return ai - bi;
    return (a.name || '').localeCompare(b.name || '');
  });
  return rows;
}
async function fetchWinesForMenu() {
  const { data } = await window.supabase.from('wine_menu').select('*').eq('status', 'active').order('sort_order', { ascending: true });
  return data || [];
}

const BEER_BADGE_MAP = { new_release: { cls: 'badge-new', label: 'New!!' }, back_again: { cls: 'badge-back', label: 'Back Again' }, seasonal: { cls: 'badge-seasonal', label: 'Seasonal' }, limited: { cls: 'badge-limited', label: 'Limited Time' }, collab: { cls: 'badge-collab', label: 'Collab' }, lactose: { cls: 'badge-lactose', label: 'Includes Lactose' }, wheat: { cls: 'badge-wheat', label: 'Contains Wheat' } };

const TAP_CSS = PRINT_RESET + '*{box-sizing:border-box;margin:0;padding:0;}body{background:#ccc;font-family:\'Inter\',sans-serif;}.page{width:8.5in;height:11in;margin:0 auto;background:#f4efe6;padding:0.35in 0.35in 0.3in 0.35in;display:flex;flex-direction:column;overflow:hidden;}.header{display:flex;align-items:center;border-bottom:2.5px solid #1a1410;padding-bottom:10px;margin-bottom:10px;flex-shrink:0;}.header-logo{width:58px;height:58px;object-fit:contain;flex-shrink:0;}.header-title{flex:1;font-family:\'Oswald\',sans-serif;font-size:38px;font-weight:700;letter-spacing:0.12em;color:#1a1410;text-align:center;line-height:1;text-transform:uppercase;}.menu-body{flex:1;display:flex;flex-direction:column;}.category-label{font-family:\'Oswald\',sans-serif;font-size:11px;font-weight:600;letter-spacing:0.15em;color:#8b3a1a;text-transform:uppercase;border-bottom:1.5px solid rgba(139,58,26,0.5);padding:3px 0;margin:9px 0 3px 0;flex-shrink:0;}.beer{display:grid;grid-template-columns:1fr 60px;align-items:center;gap:0 6px;padding:4px 0 3px 0;flex-shrink:0;}.beer+.beer{border-top:1px solid rgba(26,20,16,0.1);}.beer-text{display:flex;flex-direction:column;gap:2px;}.beer-line1{display:flex;align-items:center;flex-wrap:wrap;line-height:1;gap:4px;}.beer-name{font-family:\'Oswald\',sans-serif;font-size:16px;font-weight:700;letter-spacing:0.03em;color:#1a1410;text-transform:uppercase;line-height:1;flex-shrink:0;}.sep{font-size:13px;font-weight:700;color:#1a1410;margin:0 3px;flex-shrink:0;}.beer-style{font-family:\'Inter\',sans-serif;font-size:13px;font-style:italic;color:#3a3530;flex-shrink:0;}.beer-abv{font-family:\'Inter\',sans-serif;font-size:13px;font-weight:700;color:#1a1410;flex-shrink:0;}.badge{font-family:\'Inter\',sans-serif;font-size:7.5px;font-weight:800;letter-spacing:0.06em;text-transform:uppercase;border-radius:2px;white-space:nowrap;flex-shrink:0;display:inline-flex;align-items:center;justify-content:center;height:16px;padding:0 6px;}.badge-new{background:#E8724A;color:#fff;}.badge-back{background:#4A8C52;color:#fff;}.badge-seasonal{background:#94bde9;color:#1a3a5c;}.badge-limited{background:#94bde9;color:#1a3a5c;}.badge-collab{background:#4A2C6E;color:#fff;}.badge-lactose{background:#c0392b;color:#fff;}.badge-wheat{background:#c0392b;color:#fff;}.beer-line2{font-family:\'Inter\',sans-serif;font-size:12px;font-weight:300;font-style:italic;color:#5a544e;line-height:1.3;}.beer-price{font-family:\'Oswald\',sans-serif;font-size:16px;font-weight:700;color:#1a1410;text-align:right;}.footer-cta{margin-top:auto;padding-top:10px;border-top:1px solid rgba(26,20,16,0.15);text-align:center;flex-shrink:0;font-family:\'Inter\',sans-serif;font-size:16px;font-weight:400;font-style:italic;color:#3a3530;}';
function tapBadgesHtml(badges, collabPartner) {
  return (badges || []).map((b) => {
    const m = BEER_BADGE_MAP[b];
    if (!m) return '';
    let label = m.label;
    if (b === 'collab' && collabPartner) label = 'Collab · ' + escHtml(collabPartner);
    return '<span class="badge ' + m.cls + '">' + label + '</span>';
  }).join('');
}
function tapFullRow(b) {
  return '<div class="beer"><div class="beer-text"><div class="beer-line1">'
    + '<span class="beer-name">' + escHtml(b.name) + '</span>'
    + (b.style ? '<span class="sep">·</span><span class="beer-style">' + escHtml(b.style) + '</span>' : '')
    + (b.abv ? '<span class="beer-abv">· ' + b.abv + '% ABV</span>' : '')
    + tapBadgesHtml(b.badges, b.collab_partner) + '</div>'
    + (b.description ? '<div class="beer-line2">' + escHtml(b.description) + '</div>' : '') + '</div><div class="beer-price">' + fmtP(b.price) + '</div></div>';
}
function tapFullPage(body) {
  return '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">' + FONT_LINK + '<style>' + TAP_CSS + '</style></head><body>'
    + '<div class="page"><div class="header">' + '<img class="header-logo" src="' + LOGO_URL + '">' + '<div class="header-title">What\'s On Tap</div>' + '<img class="header-logo" src="' + LOGO_URL + '">' + '</div><div class="menu-body">' + body + '<div class="footer-cta">Follow us on Facebook and Instagram for upcoming events and beer releases!</div>' + '</div></div></body></html>';
}
async function genTapList() {
  genStatus('Fetching tap list...');
  try {
    const rows = await fetchBeersForMenu();
    const cats = {}, catOrder = [];
    rows.forEach((b) => { const c = b.category || 'Other'; if (!cats[c]) { cats[c] = []; catOrder.push(c); } cats[c].push(b); });
    let body = '';
    catOrder.forEach((cat) => { body += '<div class="category-label">' + escHtml(cat) + '</div>'; cats[cat].forEach((b) => { body += tapFullRow(b); }); });
    openHtml(tapFullPage(body));
    genStatus('Tap list generated — use Ctrl+P / Cmd+P to print.');
  } catch (e) { genStatus('Error: ' + e.message); }
}

const HALF_BASE_CSS = PRINT_RESET + '*{box-sizing:border-box;margin:0;padding:0;}body{background:#777;display:flex;justify-content:center;font-family:\'Inter\',sans-serif;}.page{width:8.5in;height:11in;background:white;display:flex;flex-direction:column;overflow:hidden;position:relative;}.half-slot{width:8.5in;height:5.5in;overflow:hidden;display:flex;align-items:center;justify-content:center;flex-shrink:0;}.cut-line{position:absolute;top:5.5in;left:0;width:100%;border-top:1px dashed #aaa;z-index:10;}@media print{.cut-line{display:none;}}.half-card{width:5.5in;height:8.5in;transform:rotate(-90deg);transform-origin:center center;background:#f4efe6;padding:0.18in 0.15in 0.15in 0.15in;display:flex;flex-direction:column;overflow:hidden;flex-shrink:0;}.card-header{display:flex;align-items:baseline;gap:10px;border-bottom:2px solid #1a1410;padding-bottom:4px;margin-bottom:5px;flex-shrink:0;}.card-title{font-family:\'Oswald\',sans-serif;font-size:22px;font-weight:700;letter-spacing:0.12em;color:#1a1410;text-transform:uppercase;line-height:1;}.card-sub{font-family:\'Oswald\',sans-serif;font-size:11px;font-weight:500;letter-spacing:0.15em;color:#8b3a1a;text-transform:uppercase;}.card-body{flex:1;display:flex;flex-direction:column;overflow:hidden;}.section-label{font-family:\'Oswald\',sans-serif;font-size:9.5px;font-weight:600;letter-spacing:0.2em;color:#8b3a1a;text-transform:uppercase;border-bottom:1.5px solid rgba(139,58,26,0.4);padding-bottom:1px;margin-top:5px;margin-bottom:2px;flex-shrink:0;}.section-label:first-child{margin-top:0;}.beer-row{display:flex;justify-content:space-between;align-items:baseline;padding:1px 0 0 0;gap:8px;flex-shrink:0;}.beer-left{display:flex;align-items:baseline;gap:4px;flex:1;flex-wrap:wrap;}.beer-name{font-family:\'Oswald\',sans-serif;font-size:12.5px;font-weight:700;color:#1a1410;text-transform:uppercase;letter-spacing:0.03em;white-space:nowrap;line-height:1.2;}.beer-sep{color:#c8a882;font-size:11px;flex-shrink:0;}.beer-style{font-family:\'Inter\',sans-serif;font-size:10.5px;font-weight:300;font-style:italic;color:#5a544e;white-space:nowrap;}.beer-right{display:flex;align-items:baseline;gap:5px;white-space:nowrap;flex-shrink:0;}.beer-abv{font-family:\'Inter\',sans-serif;font-size:10.5px;color:#7a6e66;}.beer-price{font-family:\'Oswald\',sans-serif;font-size:12.5px;font-weight:700;color:#1a1410;min-width:28px;text-align:right;}.beer-desc{font-family:\'Inter\',sans-serif;font-size:9.5px;font-style:italic;color:#7a6e66;line-height:1.3;padding-bottom:2px;border-bottom:1px dotted rgba(26,20,16,0.12);flex-shrink:0;}.badge{font-family:\'Oswald\',sans-serif;font-size:8px;font-weight:600;letter-spacing:0.08em;padding:1px 4px;border-radius:2px;text-transform:uppercase;vertical-align:middle;margin-left:3px;flex-shrink:0;line-height:1.4;}.badge-new{background:#8b3a1a;color:#f4efe6;}.badge-back{background:#4a7c2f;color:#f4efe6;}.badge-seasonal{background:#94bde9;color:#1a3a5c;}.badge-limited{background:#94bde9;color:#1a3a5c;}.badge-collab{background:#4A2C6E;color:#f4efe6;}.badge-lactose{background:#c0392b;color:#f4efe6;}.badge-wheat{background:#c0392b;color:#f4efe6;}';
function halfPage(title, inner, extraCss) {
  return '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">' + FONT_LINK + '<style>' + HALF_BASE_CSS + (extraCss || '') + '</style></head><body>'
    + '<div class="page">' + '<div class="half-slot"><div class="half-card">' + '<div class="card-header"><span class="card-title">' + title + '</span><span class="card-sub">Lago Vista Brewing Company</span></div>' + '<div class="card-body">' + inner + '</div></div></div>'
    + '<div class="cut-line"></div>' + '<div class="half-slot"><div class="half-card">' + '<div class="card-header"><span class="card-title">' + title + '</span><span class="card-sub">Lago Vista Brewing Company</span></div>' + '<div class="card-body">' + inner + '</div></div></div>' + '</div></body></html>';
}
function halfTapRow(b) {
  const badges = (b.badges || []).map((bk) => { const m = BEER_BADGE_MAP[bk]; return m ? '<span class="badge ' + m.cls + '">' + m.label + '</span>' : ''; }).join('');
  return '<div class="beer-row"><div class="beer-left">' + '<span class="beer-name">' + escHtml(b.name) + '</span>' + (b.style ? '<span class="beer-sep">·</span><span class="beer-style">' + escHtml(b.style) + '</span>' : '') + badges + '</div><div class="beer-right">' + (b.abv ? '<span class="beer-abv">' + b.abv + '% ABV</span>' : '') + (b.price ? '<span class="beer-price">' + fmtP(b.price) + '</span>' : '') + '</div></div>'
    + (b.description ? '<div class="beer-desc">' + escHtml(b.description) + '</div>' : '');
}
async function genTapHalf() {
  genStatus('Fetching tap list...');
  try {
    const rows = await fetchBeersForMenu();
    const cats = {}, catOrder = [];
    rows.forEach((b) => { const c = b.category || 'Other'; if (!cats[c]) { cats[c] = []; catOrder.push(c); } cats[c].push(b); });
    let inner = '';
    catOrder.forEach((cat) => { inner += '<div class="section-label">' + escHtml(cat) + '</div>'; cats[cat].forEach((b) => { inner += halfTapRow(b); }); });
    openHtml(halfPage('What’s on Tap', inner, ''));
    genStatus('Tap half-sheet generated.');
  } catch (e) { genStatus('Error: ' + e.message); }
}

const WINE_FULL_CSS = PRINT_RESET + '*{box-sizing:border-box;margin:0;padding:0;}body{background:#ccc;font-family:\'Inter\',sans-serif;}.page{width:8.5in;height:11in;margin:0 auto;background:#f4efe6;padding:0.35in 0.35in 0.3in 0.35in;display:flex;flex-direction:column;overflow:hidden;}.header{display:flex;align-items:center;border-bottom:2.5px solid #1a1410;padding-bottom:10px;margin-bottom:10px;flex-shrink:0;}.header-logo{width:58px;height:58px;object-fit:contain;flex-shrink:0;}.header-title{flex:1;font-family:\'Oswald\',sans-serif;font-size:38px;font-weight:700;letter-spacing:0.12em;color:#1a1410;text-align:center;line-height:1;text-transform:uppercase;}.sec-rule{border:none;border-top:1.5px solid rgba(139,58,26,0.5);margin-bottom:0;}.sec-title{font-family:\'Oswald\',sans-serif;font-size:11px;font-weight:600;letter-spacing:0.15em;color:#8b3a1a;text-transform:uppercase;padding:3px 0;margin-bottom:3px;}.badge{min-width:46px;text-align:center;font-family:\'Inter\',sans-serif;font-size:7.5px;font-weight:800;letter-spacing:0.06em;color:white;padding:0 6px;border-radius:2px;white-space:nowrap;line-height:1;display:inline-flex;align-items:center;justify-content:center;height:16px;}.badge-bottle{background:#3eb17a;}.badge-glass{background:#ef915e;}.badge-can{background:#94bde9;color:#1a3a5c;}.inline-name{font-family:\'Oswald\',sans-serif;font-size:16px;font-weight:700;letter-spacing:0.03em;color:#1a1410;text-transform:uppercase;line-height:1;}.inline-type{font-family:\'Inter\',sans-serif;font-size:13px;font-style:italic;color:#3a3530;font-weight:400;}.inline-sep{color:#3a3530;font-size:13px;font-style:italic;}.inline-note{font-family:\'Inter\',sans-serif;font-style:italic;color:#5a544e;font-size:12px;font-weight:300;}.name-wrap{min-width:0;}.row-bottle{display:grid;grid-template-columns:1fr auto auto;align-items:center;gap:0 10px;padding:4px 0 3px 0;}.row-bottle+.row-bottle{border-top:1px solid rgba(26,20,16,0.1);}.bottle-price{font-family:\'Oswald\',sans-serif;font-size:16px;font-weight:700;white-space:nowrap;min-width:36px;text-align:right;color:#1a1410;}.row-glass{display:grid;grid-template-columns:1fr auto auto;align-items:start;gap:0 8px;padding:4px 0 3px 0;}.row-glass+.row-glass{border-top:1px solid rgba(26,20,16,0.1);}.glass-badges{display:flex;flex-direction:column;gap:2px;align-items:center;}.glass-prices{display:flex;flex-direction:column;gap:2px;align-items:flex-end;font-family:\'Oswald\',sans-serif;font-weight:700;white-space:nowrap;min-width:36px;color:#1a1410;}.gp-line{font-size:15px;line-height:1.3;}.row-can{display:grid;grid-template-columns:1fr auto auto;align-items:center;gap:0 10px;padding:4px 0 3px 0;}.row-can+.row-can{border-top:1px solid rgba(26,20,16,0.1);}.na-beer-block{padding-bottom:4px;}.na-beer-block+.na-beer-block{border-top:1px solid rgba(26,20,16,0.1);}.row-na-beer{display:grid;grid-template-columns:1fr auto auto;align-items:center;gap:0 8px;padding:4px 0 0 0;}.na-beer-desc{font-family:\'Inter\',sans-serif;font-size:12px;font-weight:300;font-style:italic;color:#5a544e;line-height:1.3;padding-bottom:2px;}.row-na{display:grid;grid-template-columns:1fr auto;align-items:center;gap:0 10px;padding:4px 0 3px 0;}.row-na+.row-na{border-top:1px solid rgba(26,20,16,0.1);}.na-price{font-family:\'Oswald\',sans-serif;font-size:16px;font-weight:700;white-space:nowrap;color:#1a1410;}.two-col{display:grid;grid-template-columns:1fr 1fr;gap:0 24px;}.opt-row{display:grid;grid-template-columns:1fr auto;align-items:center;gap:0 8px;padding:6px 0;}.opt-col>.opt-row+.opt-row{border-top:1px solid rgba(26,20,16,0.1);}.opt-name{font-family:\'Oswald\',sans-serif;font-size:15px;font-weight:700;letter-spacing:0.03em;color:#1a1410;text-transform:uppercase;line-height:1.1;}.opt-sub{font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#5a544e;}.opt-price{font-family:\'Oswald\',sans-serif;font-size:15px;font-weight:700;white-space:nowrap;color:#1a1410;}';
function wineNameBlock(w) {
  let html = '<div class="name-wrap"><span class="inline-name">' + escHtml(w.name) + '</span>';
  if (w.type) html += '&nbsp;&nbsp;<span class="inline-type">' + escHtml(w.type) + '</span>';
  if (w.winery && w.region) html += '<span class="inline-sep"> &mdash; </span><span class="inline-note">' + escHtml(w.winery) + ', ' + escHtml(w.region) + '</span>';
  else if (w.winery) html += '<span class="inline-sep"> &mdash; </span><span class="inline-note">' + escHtml(w.winery) + '</span>';
  if (w.description) html += '<span class="inline-sep"> &mdash; </span><span class="inline-note">' + escHtml(w.description) + '</span>';
  html += '</div>';
  return html;
}
function wineFullRow(w) {
  const nb = wineNameBlock(w);
  const badges = w.badge || [];
  const gp = fmtP(w.price_glass), bp = fmtP(w.price_bottle);
  const isGlassBottle = badges.some((b) => b.toLowerCase() === 'glass+bottle');
  if (w.display_group === 'Wine by the Bottle') return '<div class="row-bottle">' + nb + '<span class="badge badge-bottle">BOTTLE</span><div class="bottle-price">' + bp + '</div></div>';
  if (w.display_group === 'Wine by the Glass') {
    if (isGlassBottle) return '<div class="row-glass">' + nb + '<div class="glass-badges"><span class="badge badge-glass">GLASS</span><span class="badge badge-bottle">BOTTLE</span></div>' + '<div class="glass-prices"><div class="gp-line">' + gp + '</div><div class="gp-line">' + bp + '</div></div></div>';
    return '<div class="row-can">' + nb + '<span class="badge badge-can">CAN</span><div class="bottle-price">' + bp + '</div></div>';
  }
  if (w.display_group === 'N/A Beer') return '<div class="na-beer-block"><div class="row-na-beer">' + '<div class="name-wrap"><span class="inline-name">' + escHtml(w.name) + '</span>' + (w.type ? '&nbsp;&nbsp;<span class="inline-type">' + escHtml(w.type) + '</span>' : '') + '</div><span class="badge badge-can">CAN</span>' + '<div class="na-price">' + bp + '</div></div>' + (w.description ? '<div class="na-beer-desc">' + escHtml(w.description) + '</div>' : '') + '</div>';
  return null;
}
function wineOptRow(w) {
  const price = fmtP(w.price_glass || w.price_bottle);
  const sub = w.type || (w.winery ? w.winery + (w.region ? ', ' + w.region : '') : '');
  return '<div class="opt-row"><div><div class="opt-name">' + escHtml(w.name) + '</div>' + (sub ? '<div class="opt-sub">' + escHtml(sub) + '</div>' : '') + '</div><div class="opt-price">' + escHtml(price) + '</div></div>';
}
function wineFullBody(rows) {
  const groupOrder = ['Wine by the Bottle', 'Wine by the Glass', 'N/A Beer', 'N/A Options'];
  const groups = {};
  rows.forEach((w) => { const g = w.display_group || 'N/A Options'; (groups[g] = groups[g] || []).push(w); });
  let html = '';
  groupOrder.forEach((grp) => {
    if (!groups[grp]) return;
    html += '<hr class="sec-rule"><div class="sec-title">' + escHtml(grp) + '</div>';
    if (grp === 'N/A Options') {
      const mid = Math.ceil(groups[grp].length / 2);
      html += '<div class="two-col"><div class="opt-col">' + groups[grp].slice(0, mid).map(wineOptRow).join('') + '</div>' + '<div class="opt-col">' + groups[grp].slice(mid).map(wineOptRow).join('') + '</div></div>';
    } else {
      groups[grp].forEach((w) => { const r = wineFullRow(w); if (r) html += r; });
    }
  });
  return html;
}
async function genWineMenu() {
  genStatus('Fetching wine menu...');
  try {
    const rows = await fetchWinesForMenu();
    const body = wineFullBody(rows);
    const html = '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">' + FONT_LINK + '<style>' + WINE_FULL_CSS + '</style></head><body>' + '<div class="page"><div class="header">' + '<img class="header-logo" src="' + LOGO_URL + '">' + '<div class="header-title">Wine &amp; N/A Drinks</div>' + '<img class="header-logo" src="' + LOGO_URL + '">' + '</div>' + body + '</div></body></html>';
    openHtml(html);
    genStatus('Wine menu generated.');
  } catch (e) { genStatus('Error: ' + e.message); }
}

const WINE_HALF_EXTRA = '.wine-entry{display:flex;flex-direction:column;flex-shrink:0;border-bottom:1px solid rgba(160,130,90,0.25);}.wine-row{display:flex;justify-content:space-between;align-items:flex-start;padding:1px 0 0 0;gap:6px;flex-shrink:0;}.wine-desc{font-family:\'Inter\',sans-serif;font-size:9px;font-style:italic;color:#7a6e66;line-height:1.2;padding:0 0 2px 0;flex-shrink:0;}.wine-left{display:flex;align-items:baseline;gap:4px;flex:1;min-width:0;flex-wrap:wrap;}.wine-name{font-family:\'Oswald\',sans-serif;font-size:12.5px;font-weight:700;color:#1a1410;text-transform:uppercase;letter-spacing:0.03em;white-space:nowrap;line-height:1.2;}.wine-type{font-family:\'Inter\',sans-serif;font-size:10px;font-weight:300;font-style:italic;color:#5a544e;white-space:nowrap;}.wine-sep{color:#c8a882;font-size:10px;flex-shrink:0;}.wine-right{display:flex;flex-direction:column;align-items:flex-end;gap:0;flex-shrink:0;min-width:60px;}.wine-right-line{display:flex;align-items:center;justify-content:space-between;width:100%;gap:4px;line-height:1.2;}.wine-badge-text{font-family:\'Oswald\',sans-serif;font-size:9px;font-weight:600;color:#6b5840;text-transform:uppercase;letter-spacing:0.05em;width:36px;text-align:left;display:inline-block;flex-shrink:0;}.wine-price{font-family:\'Oswald\',sans-serif;font-size:10px;font-weight:700;color:#1a1410;white-space:nowrap;line-height:1.2;}.na-beer-entry{display:flex;flex-direction:column;flex-shrink:0;border-bottom:1px solid rgba(160,130,90,0.25);}.na-beer-row{display:flex;justify-content:space-between;align-items:flex-start;padding:1px 0 0 0;gap:6px;flex-shrink:0;}.na-beer-desc{font-family:\'Inter\',sans-serif;font-size:9px;font-style:italic;color:#7a6e66;line-height:1.3;padding-bottom:3px;flex-shrink:0;}.na-item{display:flex;justify-content:space-between;align-items:center;padding:2px 0 3px 0;border-bottom:1px solid rgba(160,130,90,0.25);gap:5px;flex-shrink:0;}.na-left{display:flex;flex-direction:column;flex:1;}.na-name{font-family:\'Oswald\',sans-serif;font-size:11px;font-weight:700;color:#1a1410;text-transform:uppercase;letter-spacing:0.03em;}.na-sub{font-family:\'Inter\',sans-serif;font-size:9px;font-weight:300;font-style:italic;color:#5a544e;}';
function wineHalfInner(rows) {
  const groupOrder = ['Wine by the Bottle', 'Wine by the Glass', 'N/A Beer', 'N/A Options'];
  const groups = {};
  rows.forEach((w) => { const g = w.display_group || 'N/A Options'; (groups[g] = groups[g] || []).push(w); });
  let html = '';
  groupOrder.forEach((grp) => {
    if (!groups[grp]) return;
    html += '<div class="section-label">' + escHtml(grp) + '</div>';
    groups[grp].forEach((w) => {
      const badges = w.badge || [];
      const isGB = badges.some((b) => b.toLowerCase() === 'glass+bottle');
      const isCan = badges.some((b) => b.toLowerCase() === 'can');
      const gp = fmtP(w.price_glass), bp = fmtP(w.price_bottle);
      if (grp === 'Wine by the Bottle') {
        html += '<div class="wine-entry"><div class="wine-row">' + '<div class="wine-left"><span class="wine-name">' + escHtml(w.name) + '</span>' + (w.type ? '<span class="wine-sep">·</span><span class="wine-type">' + escHtml(w.type) + '</span>' : '') + '</div><div class="wine-right"><div class="wine-right-line">' + '<span class="wine-badge-text">Bottle</span><span class="wine-price">' + bp + '</span>' + '</div></div></div>' + (w.description ? '<div class="wine-desc">' + escHtml(w.description) + '</div>' : '') + '</div>';
      } else if (grp === 'Wine by the Glass') {
        if (isGB) {
          html += '<div class="wine-entry"><div class="wine-row">' + '<div class="wine-left"><span class="wine-name">' + escHtml(w.name) + '</span>' + (w.type ? '<span class="wine-sep">·</span><span class="wine-type">' + escHtml(w.type) + '</span>' : '') + '</div><div class="wine-right">' + '<div class="wine-right-line"><span class="wine-badge-text">Glass</span><span class="wine-price">' + gp + '</span></div>' + '<div class="wine-right-line"><span class="wine-badge-text">Bottle</span><span class="wine-price">' + bp + '</span></div>' + '</div></div>' + (w.description ? '<div class="wine-desc">' + escHtml(w.description) + '</div>' : '') + '</div>';
        } else {
          html += '<div class="wine-entry"><div class="wine-row">' + '<div class="wine-left"><span class="wine-name">' + escHtml(w.name) + '</span>' + (w.type ? '<span class="wine-sep">·</span><span class="wine-type">' + escHtml(w.type) + '</span>' : '') + '</div><div class="wine-right"><div class="wine-right-line">' + '<span class="wine-badge-text">Can</span><span class="wine-price">' + bp + '</span>' + '</div></div></div>' + (w.description ? '<div class="wine-desc">' + escHtml(w.description) + '</div>' : '') + '</div>';
        }
      } else if (grp === 'N/A Beer') {
        html += '<div class="na-beer-entry"><div class="na-beer-row">' + '<div class="wine-left"><span class="wine-name">' + escHtml(w.name) + '</span>' + (w.type ? '<span class="wine-sep">·</span><span class="wine-type">' + escHtml(w.type) + '</span>' : '') + '</div><div class="wine-right"><div class="wine-right-line">' + '<span class="wine-badge-text">Can</span><span class="wine-price">' + bp + '</span>' + '</div></div></div>' + (w.description ? '<div class="na-beer-desc">' + escHtml(w.description) + '</div>' : '') + '</div>';
      } else {
        const price = gp || bp;
        const badgeText = isCan ? 'Can' : (badges.some((b) => b.toLowerCase() === 'bottle') ? 'Bottle' : '');
        html += '<div class="na-item"><div class="na-left">' + '<span class="na-name">' + escHtml(w.name) + '</span>' + (w.description ? '<span class="na-sub">' + escHtml(w.description) + '</span>' : '') + '</div><div class="wine-right"><div class="wine-right-line">' + (badgeText ? '<span class="wine-badge-text">' + badgeText + '</span>' : '<span style="width:36px;display:inline-block"></span>') + '<span class="wine-price">' + escHtml(price) + '</span>' + '</div></div></div>';
      }
    });
  });
  return html;
}
async function genWineHalf() {
  genStatus('Fetching wine menu...');
  try {
    const rows = await fetchWinesForMenu();
    openHtml(halfPage('Wine &amp; N/A Drinks', wineHalfInner(rows), WINE_HALF_EXTRA));
    genStatus('Wine half-sheet generated.');
  } catch (e) { genStatus('Error: ' + e.message); }
}

const LABEL_CSS = '@import url(\'https://fonts.googleapis.com/css2?family=Oswald:wght@500;600;700&family=Inter:ital,wght@0,300;0,400;0,700;1,300;1,400&display=swap\');@media print{*{-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important;}@page{size:8.5in 11in portrait;margin:0.25in;}body{margin:0;background:white;}}*{box-sizing:border-box;margin:0;padding:0;}body{background:#eee;font-family:\'Inter\',sans-serif;padding:0.25in;}.grid{display:flex;flex-wrap:wrap;gap:0.12in;}.card{width:3.94in;height:1.57in;background:#f4efe6;border:1px solid #c8b89a;border-radius:3px;padding:5px 8px;display:flex;flex-direction:column;justify-content:space-between;overflow:hidden;page-break-inside:avoid;}.card-top{display:flex;align-items:flex-start;justify-content:space-between;gap:4px;}.card-name{font-family:\'Oswald\',sans-serif;font-size:20px;font-weight:700;color:#1a1410;text-transform:uppercase;letter-spacing:0.04em;line-height:1.1;}.card-badge-wrap{display:flex;flex-direction:column;gap:2px;align-items:flex-end;flex-shrink:0;padding-top:2px;}.lbl-badge{font-family:\'Oswald\',sans-serif;font-size:8px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;border-radius:2px;white-space:nowrap;display:inline-flex;align-items:center;height:14px;padding:0 5px;}.badge-new{background:#E8724A;color:#fff;}.badge-back{background:#4A8C52;color:#fff;}.badge-leaving{background:#94bde9;color:#1a3a5c;}.badge-lactose{background:#c0392b;color:#fff;}.card-style{font-family:\'Inter\',sans-serif;font-size:12px;font-style:italic;color:#5a544e;font-weight:300;margin-top:1px;line-height:1.2;}.card-desc{font-family:\'Inter\',sans-serif;font-size:11px;font-style:italic;color:#4a4440;line-height:1.35;flex:1;margin-top:3px;overflow:hidden;font-weight:400;}.card-bottom{display:flex;align-items:baseline;justify-content:space-between;border-top:1.5px solid rgba(139,58,26,0.35);padding-top:4px;margin-top:3px;}.card-abv{font-size:12px;color:#7a6e66;font-weight:600;white-space:nowrap;flex-shrink:0;}.card-price-main{font-family:\'Oswald\',sans-serif;font-size:18px;font-weight:700;color:#1a1410;white-space:nowrap;}.card-price-sub{font-size:13px;color:#5a544e;white-space:nowrap;}';
const LABEL_BADGE_MAP = { new_release: { cls: 'badge-new', label: 'New!!' }, back_again: { cls: 'badge-back', label: 'Back Again' }, leaving_soon: { cls: 'badge-leaving', label: 'Leaving Soon' }, lactose: { cls: 'badge-lactose', label: 'Includes Lactose' } };
function buildLabelHtml(beerList) {
  const cards = beerList.map((b) => {
    const badges = (b.badges || []).map((bk) => { const m = LABEL_BADGE_MAP[bk]; return m ? '<span class="lbl-badge ' + m.cls + '">' + m.label + '</span>' : ''; }).join('');
    const isNA = (b.category || '').toLowerCase().indexOf('non-alc') !== -1;
    const packPrice = isNA ? '$15' : '$18';
    const canPrice = b.price ? '$' + (Number(b.price) + 1).toFixed(2).replace(/\.00$/, '') : '';
    return '<div class="card">' + '<div class="card-top"><div>' + '<div class="card-name">' + escHtml(b.name) + '</div>' + '<div class="card-style">' + escHtml(b.style || '') + '</div>' + '</div>' + (badges ? '<div class="card-badge-wrap">' + badges + '</div>' : '') + '</div>' + '<div class="card-desc">' + escHtml(b.description || '') + '</div>' + '<div class="card-bottom">' + '<span class="card-abv">' + escHtml(String(b.abv || '')) + '% ABV</span>' + '<div style="display:flex;align-items:baseline;gap:6px;">' + '<span class="card-price-sub"><em>Build a 4-pack for ' + packPrice + ' or</em></span>' + '<span class="card-price-main">' + canPrice + '/can</span>' + '</div></div></div>';
  }).join('');
  return '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Fridge Labels — Lago Vista Brewing</title><style>' + LABEL_CSS + '</style></head><body><div class="grid">' + cards + '</div></body></html>';
}
async function openLabelPicker() {
  genStatus('Loading beers...');
  try {
    labelBeerList = (await fetchBeersForMenu()).filter((b) => (b.category || '').toLowerCase().indexOf('guest') === -1);
    labelSelected = {};
    labelBeerList.forEach((b) => { labelSelected[b.id] = true; });
    renderLabelPicker();
    document.getElementById('label-modal').style.display = 'flex';
    genStatus('');
  } catch (e) { genStatus('Error: ' + e.message); }
}
function renderLabelPicker() {
  const el = document.getElementById('label-picker-list');
  if (!labelBeerList.length) { el.innerHTML = '<div style="color:var(--muted);font-size:13px;font-family:\'DM Mono\',monospace;">No active beers found.</div>'; return; }
  const cats = {}, catOrder = [];
  labelBeerList.forEach((b) => { const c = b.category || 'Other'; if (!cats[c]) { cats[c] = []; catOrder.push(c); } cats[c].push(b); });
  el.innerHTML = '';
  catOrder.forEach((cat) => {
    const hdr = document.createElement('div');
    hdr.style.cssText = 'font-size:10px;font-family:\'DM Mono\',monospace;color:var(--muted);letter-spacing:2px;text-transform:uppercase;padding:8px 0 4px 0;border-top:1px solid var(--border);margin-top:4px;';
    hdr.textContent = cat;
    el.appendChild(hdr);
    cats[cat].forEach((b) => {
      const sel = !!labelSelected[b.id];
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:12px;padding:8px 12px;border-radius:6px;cursor:pointer;border:1px solid ' + (sel ? 'var(--teal)' : 'var(--border)') + ';background:' + (sel ? 'rgba(42,184,166,0.06)' : 'var(--raised)') + ';transition:all 0.12s;';
      row.innerHTML = '<div style="width:16px;height:16px;border-radius:4px;border:2px solid ' + (sel ? 'var(--teal)' : 'var(--muted)') + ';background:' + (sel ? 'var(--teal)' : 'transparent') + ';flex-shrink:0;display:flex;align-items:center;justify-content:center;">' + (sel ? '<svg width="10" height="8" viewBox="0 0 10 8"><polyline points="1,4 4,7 9,1" fill="none" stroke="#0D1117" stroke-width="2"/></svg>' : '') + '</div>'
        + '<div style="flex:1;"><div style="font-size:13px;font-weight:500;">' + escHtml(b.name || '') + '</div>' + '<div style="font-size:11px;color:var(--sub);font-family:\'DM Mono\',monospace;">' + escHtml(b.style || '') + ' · ' + (b.abv || '') + '%</div></div>'
        + '<div style="font-size:13px;font-family:\'DM Mono\',monospace;color:var(--teal);">' + (b.price ? '$' + Number(b.price).toFixed(2) : '') + '</div>';
      row.addEventListener('click', () => { labelSelected[b.id] = !labelSelected[b.id]; renderLabelPicker(); });
      el.appendChild(row);
    });
  });
}
function labelSelectAll() { labelBeerList.forEach((b) => { labelSelected[b.id] = true; }); renderLabelPicker(); }
function labelSelectNone() { labelBeerList.forEach((b) => { labelSelected[b.id] = false; }); renderLabelPicker(); }
function closeLabelPicker() { document.getElementById('label-modal').style.display = 'none'; }
function genFridgeLabels() {
  const selected = labelBeerList.filter((b) => !!labelSelected[b.id]);
  if (!selected.length) { genStatus('No beers selected.'); return; }
  closeLabelPicker();
  openHtml(buildLabelHtml(selected));
  genStatus(selected.length + ' label' + (selected.length !== 1 ? 's' : '') + ' generated.');
}
