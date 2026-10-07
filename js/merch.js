// merch.js
// Inventory > Merchandise sub-tab. Merch is counted in actual units,
// not the rough percent the other inventory categories use, and is
// shaped product > style > variant (migration_034 + 036):
//
//   product   the thing you'd reorder ("Bronco Blonde T-Shirt")
//   style     one color + design of it ("Blue / No Front Pocket") —
//             the unit that carries a photo and gets retired
//   variant   one size of a style
//
//   Stock   one card per product: a row per style per location it is
//           kept in, a column per size, unit counts you type into.
//   Trends  levels over time from the count log, plus estimated units
//           sold / restocked per product.
//
// Merch lives in more than one place (sold from the Taproom, backstock
// in the Break room), so a count is always for a variant AT a location
// and a variant's total is the sum across locations. Stock imported
// from the old spreadsheet has no location yet ("Not split by
// location"); the first count of a size at a real location replaces
// that size's unsplit number rather than adding to it.
//
// inventory_merch_counts is the source of truth. Nothing here writes a
// variant's or a location's number directly — it calls
// record_merch_count() and the database triggers carry the count onto
// the stock row and the variant, so "on hand" can't drift from history.
//
// "Sold" and "restocked" are estimates read off the counts: any drop
// between two counts is treated as sold, any rise as restocked. A
// miscount therefore inflates both.
// Depends on: window.supabase, window.currentStaff, toast(),
// escHtml() (menu.js), toDateStr() (schedule.js),
// invLoadLocations/invLocationPath/invLocationsFlat/invPhotoThumbHtml/
// invPickPhoto/invUploadPhoto (locations.js)

const MERCH_TYPE_LABELS = { shirt: 'Shirts', tank: 'Tanks', long_sleeve: 'Long Sleeves', sweatshirt: 'Sweatshirts', outerwear: 'Outerwear', hat: 'Hats', visor: 'Visors', drinkware: 'Drinkware', accessory: 'Accessories', other: 'Other' };
const MERCH_APPAREL_SIZES = ['X-Small', 'Small', 'Medium', 'Large', 'X-Large', 'XX-Large', '3X-Large'];
// Chart series colors, assigned in this fixed order. Kept apart from
// the app's teal/amber/red, which mean OK / low / critical elsewhere.
const MERCH_SERIES_COLORS = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#9085e9'];
const MERCH_OTHER_COLOR = '#8E92B0';
const MERCH_UNSPLIT = ''; // location key for stock not yet split by location

let merchProducts = [];
let merchStyles = [];
let merchVariants = [];
let merchStock = [];
let merchCounts = null;      // loaded on first visit to Trends
let merchPendingLocs = {};   // styleId -> [locationId] rows added but not counted yet
let merchView = 'stock';
let merchStatusFilter = 'active';
let merchTypeFilter = '';
let merchSearch = '';
let merchProductEditId = null;
let merchStyleForm = null;   // { productId, styleId } while a color/design form is open
let merchTrendScope = 'all';
let merchTrendMonths = 12;
let merchChart = null;

async function merchFetchAll(table, columns, orderBy) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await window.supabase.from(table).select(columns).order(orderBy).order('id').range(from, from + 999);
    if (error) throw error;
    rows.push(...data);
    if (data.length < 1000) return rows;
  }
}

async function loadMerch() {
  const el = document.getElementById('inventorytab-merchandise');
  if (!el.dataset.built) { el.innerHTML = merchSkeletonHtml(); el.dataset.built = '1'; }
  try {
    [merchProducts, merchStyles, merchVariants, merchStock] = await Promise.all([
      merchFetchAll('inventory_merch_products', '*', 'name'),
      merchFetchAll('inventory_merch_styles', '*', 'created_at'),
      merchFetchAll('inventory_merch_variants', '*', 'size_sort'),
      merchFetchAll('inventory_merch_stock', '*', 'variant_id'),
      invLoadLocations(),
    ]);
  } catch (e) {
    document.getElementById('merch-list').innerHTML = '<div class="loading">Could not load merchandise: ' + escHtml(e.message) + '</div>';
    return;
  }
  merchCounts = null;
  setMerchView(merchView);
}

function merchSkeletonHtml() {
  const typeOptions = Object.keys(MERCH_TYPE_LABELS).map((t) => '<option value="' + t + '">' + MERCH_TYPE_LABELS[t] + '</option>').join('');
  const pill = (group, value, label, active) => '<div class="badge-pill' + (active ? ' selected' : '') + '" id="merch-' + group + '-' + value + '" onclick="setMerch' + group + '(\'' + value + '\')">' + label + '</div>';
  return '<div class="menu-col-header">'
    + '<div class="badge-picker">' + pill('View', 'stock', 'Stock', true) + pill('View', 'trends', 'Trends', false) + '</div>'
    + '<button class="btn btn-sm btn-primary" id="merch-add-product-btn" onclick="openMerchProductForm(null)">+ Add Product</button>'
    + '</div>'

    + '<div id="merch-stock">'
    + '<div class="lookup-toolbar" style="flex-wrap:wrap;">'
    + '<input class="search-bar" style="min-width:200px;" type="search" placeholder="Search product, color or design" oninput="setMerchSearch(this.value)">'
    + '<select class="form-select" onchange="setMerchTypeFilter(this.value)"><option value="">All types</option>' + typeOptions + '</select>'
    + '<div class="badge-picker">' + pill('Status', 'active', 'Active', true) + pill('Status', 'retired', 'Retired', false) + pill('Status', 'verify', 'Needs Verification', false) + pill('Status', 'all', 'All', false) + '</div>'
    + '</div>'
    + '<div class="card" id="merch-product-form" style="display:none;margin-bottom:16px;">'
    + '<div class="menu-col-header"><div class="section-label" style="margin:0;" id="merch-p-form-label">Add Product</div></div>'
    + '<div class="form-row">'
    + '<div class="form-group"><label class="form-label">Name</label><input class="form-input" type="text" id="merch-p-name"></div>'
    + '<div class="form-group"><label class="form-label">Type</label><select class="form-select" id="merch-p-type">' + typeOptions + '</select></div>'
    + '</div><div class="form-row">'
    + '<div class="form-group"><label class="form-label">Vendor Style #</label><input class="form-input" type="text" id="merch-p-style" placeholder="optional"></div>'
    + '<div class="form-group"><label class="form-label">Notes</label><input class="form-input" type="text" id="merch-p-notes" placeholder="optional"></div>'
    + '</div>'
    + '<div style="display:flex;gap:8px;flex-wrap:wrap;">'
    + '<button class="btn btn-primary" id="merch-p-save-btn" onclick="saveMerchProduct()">Add Product</button>'
    + '<button class="btn btn-secondary" onclick="closeMerchProductForm()">Cancel</button>'
    + '<button class="btn btn-danger" id="merch-p-delete-btn" style="display:none;margin-left:auto;" onclick="deleteMerchProduct()">Delete Product</button>'
    + '</div></div>'
    + '<div id="merch-list"><div class="loading">Loading...</div></div>'
    + '</div>'

    + '<div id="merch-trends" style="display:none;"></div>';
}

function setMerchView(view) {
  merchView = view;
  ['stock', 'trends'].forEach((v) => document.getElementById('merch-View-' + v).classList.toggle('selected', v === view));
  document.getElementById('merch-stock').style.display = view === 'stock' ? '' : 'none';
  document.getElementById('merch-trends').style.display = view === 'trends' ? '' : 'none';
  document.getElementById('merch-add-product-btn').style.display = view === 'stock' ? '' : 'none';
  if (view === 'stock') renderMerchList(); else loadMerchTrends();
}
function setMerchStatus(status) {
  merchStatusFilter = status;
  ['active', 'retired', 'verify', 'all'].forEach((s) => document.getElementById('merch-Status-' + s).classList.toggle('selected', s === status));
  renderMerchList();
}
function setMerchTypeFilter(type) { merchTypeFilter = type; renderMerchList(); }
function setMerchSearch(text) { merchSearch = text.trim().toLowerCase(); renderMerchList(); }

// ── LOOKUPS ──────────────────────────────────────
function merchStyleLabel(s) { return [s.color, s.design].filter(Boolean).join(' · ') || 'One version'; }
function merchStylesFor(productId) { return merchStyles.filter((s) => s.product_id === productId); }
function merchVariantsFor(styleId) { return merchVariants.filter((v) => v.style_id === styleId).sort((a, b) => a.size_sort - b.size_sort); }
function merchStockAt(variantId, locKey) { return merchStock.find((r) => r.variant_id === variantId && (r.location_id || MERCH_UNSPLIT) === locKey); }
function merchProductTotal(productId) {
  const styleIds = merchStylesFor(productId).map((s) => s.id);
  return merchVariants.filter((v) => styleIds.includes(v.style_id)).reduce((a, v) => a + v.unit_count, 0);
}
function merchLocLabel(locKey) { return locKey === MERCH_UNSPLIT ? 'Not split by location' : invLocationPath(locKey); }

// The location rows a style shows: everywhere it has stock, plus any
// row added with "Count at..." that hasn't been counted yet. Unsplit
// stock first, then locations in tree order.
function merchStyleLocKeys(style) {
  const variantIds = merchVariantsFor(style.id).map((v) => v.id);
  const keys = new Set(merchStock.filter((r) => variantIds.includes(r.variant_id)).map((r) => r.location_id || MERCH_UNSPLIT));
  (merchPendingLocs[style.id] || []).forEach((k) => keys.add(k));
  if (!keys.size) keys.add(MERCH_UNSPLIT);
  const order = [MERCH_UNSPLIT].concat(invLocationsFlat().map((l) => l.id));
  return order.filter((k) => keys.has(k));
}

function merchStyleMatches(s) {
  if (merchStatusFilter === 'active' && s.status !== 'active') return false;
  if (merchStatusFilter === 'retired' && s.status !== 'retired') return false;
  if (merchStatusFilter === 'verify' && !merchVariantsFor(s.id).some((v) => v.needs_verification)) return false;
  return true;
}

// ── STOCK ────────────────────────────────────────
function renderMerchList() {
  const el = document.getElementById('merch-list');
  const cards = [];
  merchProducts.forEach((p) => {
    if (merchTypeFilter && p.product_type !== merchTypeFilter) return;
    const all = merchStylesFor(p.id);
    const nameHit = !merchSearch || (p.name + ' ' + (p.style_number || '')).toLowerCase().includes(merchSearch);
    const styles = all.filter(merchStyleMatches).filter((s) => nameHit || merchStyleLabel(s).toLowerCase().includes(merchSearch));
    // A product with no styles yet has nothing to filter on — show it wherever a new product would belong.
    const emptyNew = !all.length && nameHit && (merchStatusFilter === 'all' || merchStatusFilter === p.status);
    if (!styles.length && !emptyNew) return;
    cards.push(merchProductCardHtml(p, styles));
  });
  el.innerHTML = cards.length ? cards.join('') : '<div class="loading">Nothing matches these filters.</div>';
}

function merchProductCardHtml(p, styles) {
  const sizes = [];
  styles.forEach((s) => merchVariantsFor(s.id).forEach((v) => { if (!sizes.some((x) => x.size === v.size)) sizes.push({ size: v.size, sort: v.size_sort }); }));
  sizes.sort((a, b) => a.sort - b.sort || String(a.size).localeCompare(String(b.size)));

  let html = '<div class="card merch-card"><div class="merch-card-head"><div>'
    + '<div class="merch-name">' + escHtml(p.name) + (p.status === 'retired' ? ' <span class="badge badge-muted">Retired</span>' : '') + '</div>'
    + '<div class="merch-sub">' + escHtml(MERCH_TYPE_LABELS[p.product_type] || p.product_type) + (p.style_number ? ' · Style ' + escHtml(p.style_number) : '') + (p.notes ? ' · ' + escHtml(p.notes) : '') + '</div>'
    + '</div><div class="merch-card-actions">'
    + '<div class="merch-total"><span id="merch-ptotal-' + p.id + '">' + merchProductTotal(p.id) + '</span><small>on hand</small></div>'
    + '<button class="btn btn-sm btn-secondary" onclick="openMerchStyleForm(\'' + p.id + '\',null)">+ Color / Design</button>'
    + '<button class="btn btn-sm btn-secondary" onclick="openMerchProductForm(\'' + p.id + '\')">Edit</button>'
    + '<button class="btn btn-sm btn-secondary" onclick="showMerchTrendFor(\'' + p.id + '\')">Trend</button>'
    + '</div></div>';

  if (merchStyleForm && merchStyleForm.productId === p.id) html += merchStyleFormHtml();
  if (!styles.length) return html + '<div class="loading">No colors or sizes yet — add one above.</div></div>';

  html += '<div class="table-wrap merch-matrix"><table><thead><tr><th></th><th>Color / Design</th><th>Location</th>'
    + sizes.map((s) => '<th class="merch-num">' + escHtml(s.size || 'Qty') + '</th>').join('') + '<th class="merch-num">Total</th><th></th></tr></thead><tbody>';
  styles.forEach((s) => { html += merchStyleRowsHtml(p, s, sizes); });
  return html + '</tbody></table></div></div>';
}

function merchStyleRowsHtml(p, s, sizes) {
  const variants = merchVariantsFor(s.id);
  const locKeys = merchStyleLocKeys(s);
  const located = locKeys.some((k) => k !== MERCH_UNSPLIT);
  const retired = s.status === 'retired';
  const flagged = variants.filter((v) => v.needs_verification);
  const rowClass = retired ? 'merch-retired' : '';
  const unusedLocs = invLocationsFlat().filter((l) => !locKeys.includes(l.id));
  let html = '';

  locKeys.forEach((locKey, i) => {
    // Once a style is counted by location, what's left unsplit is only the sizes nobody has counted there yet — read-only.
    const readOnly = locKey === MERCH_UNSPLIT && located;
    html += '<tr class="' + rowClass + (i ? ' merch-loc-row' : ' merch-style-first') + '">';
    if (i === 0) {
      html += '<td rowspan="' + (locKeys.length + (locKeys.length > 1 ? 1 : 0)) + '" class="merch-photo-cell">'
        + '<button class="merch-photo-btn" title="' + (s.photo_url ? 'Replace photo' : 'Add photo') + '" onclick="pickMerchStylePhoto(\'' + s.id + '\')">' + invPhotoThumbHtml(s.photo_url, p.name + ' ' + merchStyleLabel(s)) + '</button></td>'
        + '<td rowspan="' + (locKeys.length + (locKeys.length > 1 ? 1 : 0)) + '">' + escHtml(merchStyleLabel(s)) + (retired ? ' <span class="badge badge-muted">Retired</span>' : '')
        + flagged.map((v) => '<div class="merch-verify">&#9888; Needs verification' + (v.size ? ' (' + escHtml(v.size) + ')' : '') + (v.verification_note ? ': ' + escHtml(v.verification_note) : '') + '</div>').join('') + '</td>';
    }
    html += '<td class="merch-loc">' + escHtml(merchLocLabel(locKey))
      + (locKey !== MERCH_UNSPLIT ? ' <button class="merch-link" onclick="removeMerchStyleLocation(\'' + s.id + '\',\'' + locKey + '\')">remove</button>' : '') + '</td>';
    let rowTotal = 0;
    sizes.forEach((sz) => {
      const v = variants.find((x) => x.size === sz.size);
      if (!v) { html += '<td class="merch-num"><span style="color:var(--muted);">—</span></td>'; return; }
      const row = merchStockAt(v.id, locKey);
      const n = row ? row.unit_count : 0;
      rowTotal += n;
      html += '<td class="merch-num"><input class="merch-cell' + (v.needs_verification ? ' flagged' : '') + '" type="number" min="0" step="1" value="' + n + '"' + (readOnly ? ' disabled' : '')
        + ' id="merch-in-' + v.id + '-' + locKey + '" aria-label="' + escHtml(merchStyleLabel(s) + ' ' + (sz.size || '') + ' at ' + merchLocLabel(locKey)) + '"'
        + ' onchange="saveMerchCount(\'' + v.id + '\',\'' + locKey + '\',this)"></td>';
    });
    html += '<td class="merch-num" id="merch-rt-' + s.id + '-' + locKey + '">' + rowTotal + '</td>';
    if (i === 0) {
      html += '<td rowspan="' + (locKeys.length + (locKeys.length > 1 ? 1 : 0)) + '" class="merch-row-actions">'
        + (unusedLocs.length ? '<select class="form-select merch-count-at" aria-label="Count at another location" onchange="addMerchStyleLocation(\'' + s.id + '\',this.value)"><option value="">Count at…</option>'
          + unusedLocs.map((l) => '<option value="' + l.id + '">' + escHtml(l.path) + '</option>').join('') + '</select>' : '')
        + (flagged.length ? '<button class="btn btn-sm btn-success" onclick="verifyMerchStyle(\'' + s.id + '\')">Mark Verified</button>' : '')
        + '<button class="btn btn-sm btn-secondary" onclick="openMerchStyleForm(\'' + p.id + '\',\'' + s.id + '\')">Edit</button>'
        + '<button class="btn btn-sm btn-secondary" onclick="setMerchStyleStatus(\'' + s.id + '\',\'' + (retired ? 'active' : 'retired') + '\')">' + (retired ? 'Reactivate' : 'Retire') + '</button>'
        + '<button class="btn btn-sm btn-danger" onclick="deleteMerchStyle(\'' + s.id + '\')">Delete</button></td>';
    }
    html += '</tr>';
  });
  if (locKeys.length > 1) {
    html += '<tr class="merch-total-row ' + rowClass + '"><td class="merch-loc">All locations</td>'
      + sizes.map((sz) => { const v = variants.find((x) => x.size === sz.size); return '<td class="merch-num"' + (v ? ' id="merch-vt-' + v.id + '"' : '') + '>' + (v ? v.unit_count : '') + '</td>'; }).join('')
      + '<td class="merch-num" id="merch-st-' + s.id + '">' + variants.reduce((a, v) => a + v.unit_count, 0) + '</td></tr>';
  }
  return html;
}

// One count per variant per location per day — typing a second number
// the same day replaces the first rather than adding a history row.
async function saveMerchCount(variantId, locKey, input) {
  const v = merchVariants.find((x) => x.id === variantId);
  const row = merchStockAt(variantId, locKey);
  const before = row ? row.unit_count : 0;
  const n = parseInt(input.value, 10);
  if (!v || isNaN(n) || n < 0) { input.value = before; toast('Enter a whole number, 0 or more', true); return; }
  const { error } = await window.supabase.rpc('record_merch_count', {
    p_variant_id: variantId, p_location_id: locKey || null, p_unit_count: n, p_counted_on: toDateStr(new Date()), p_counted_at: new Date().toISOString() });
  if (error) { input.value = before; toast(error.message, true); return; }
  input.value = n;
  merchCounts = null;

  // Mirror what the database triggers just did, so the totals update without a reload (and without losing focus mid-row).
  if (row) row.unit_count = n; else merchStock.push({ variant_id: variantId, location_id: locKey || null, unit_count: n });
  if (locKey !== MERCH_UNSPLIT) {
    merchStock = merchStock.filter((r) => !(r.variant_id === variantId && !r.location_id));
    const stale = document.getElementById('merch-in-' + variantId + '-' + MERCH_UNSPLIT);
    if (stale) stale.value = 0;
  }
  v.unit_count = merchStock.filter((r) => r.variant_id === variantId).reduce((a, r) => a + r.unit_count, 0);
  const style = merchStyles.find((s) => s.id === v.style_id);
  const variants = merchVariantsFor(style.id);
  const setText = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };
  merchStyleLocKeys(style).forEach((k) => setText('merch-rt-' + style.id + '-' + k, variants.reduce((a, x) => a + ((merchStockAt(x.id, k) || {}).unit_count || 0), 0)));
  setText('merch-vt-' + variantId, v.unit_count);
  setText('merch-st-' + style.id, variants.reduce((a, x) => a + x.unit_count, 0));
  setText('merch-ptotal-' + style.product_id, merchProductTotal(style.product_id));
  toast('Count saved');
}

function addMerchStyleLocation(styleId, locationId) {
  if (!locationId) return;
  (merchPendingLocs[styleId] = merchPendingLocs[styleId] || []).push(locationId);
  renderMerchList();
}

// Taking a style out of a location is itself a count (zero), so the
// history shows the stock leaving rather than just vanishing.
async function removeMerchStyleLocation(styleId, locationId) {
  const variantIds = merchVariantsFor(styleId).map((v) => v.id);
  const rows = merchStock.filter((r) => variantIds.includes(r.variant_id) && r.location_id === locationId);
  const units = rows.reduce((a, r) => a + r.unit_count, 0);
  if (units && !confirm('Remove ' + invLocationPath(locationId) + ' from this style? Its ' + units + ' unit' + (units === 1 ? '' : 's') + ' there will be counted as 0.')) return;
  for (const r of rows.filter((x) => x.unit_count > 0)) {
    const { error } = await window.supabase.rpc('record_merch_count', {
      p_variant_id: r.variant_id, p_location_id: locationId, p_unit_count: 0, p_counted_on: toDateStr(new Date()), p_counted_at: new Date().toISOString() });
    if (error) { toast(error.message, true); return; }
  }
  if (rows.length) {
    const { error } = await window.supabase.from('inventory_merch_stock').delete().in('variant_id', variantIds).eq('location_id', locationId);
    if (error) { toast(error.message, true); return; }
  }
  merchPendingLocs[styleId] = (merchPendingLocs[styleId] || []).filter((k) => k !== locationId);
  await loadMerch();
}

function pickMerchStylePhoto(styleId) {
  invPickPhoto(async (file) => {
    try {
      const photo_url = await invUploadPhoto('merch/' + styleId, file);
      const { error } = await window.supabase.from('inventory_merch_styles').update({ photo_url }).eq('id', styleId);
      if (error) throw error;
      merchStyles.find((s) => s.id === styleId).photo_url = photo_url;
      toast('Photo saved');
      renderMerchList();
    } catch (e) { toast('Photo did not upload: ' + e.message, true); }
  });
}

// A product is retired exactly when every one of its styles is.
async function merchSyncProductStatus(productId) {
  const styles = merchStylesFor(productId);
  const p = merchProducts.find((x) => x.id === productId);
  if (!p || !styles.length) return;
  const status = styles.every((s) => s.status === 'retired') ? 'retired' : 'active';
  if (status === p.status) return;
  const { error } = await window.supabase.from('inventory_merch_products').update({ status }).eq('id', productId);
  if (!error) p.status = status;
}

async function setMerchStyleStatus(styleId, status) {
  const s = merchStyles.find((x) => x.id === styleId);
  const { error } = await window.supabase.from('inventory_merch_styles').update({ status }).eq('id', styleId);
  if (error) { toast(error.message, true); return; }
  s.status = status;
  await merchSyncProductStatus(s.product_id);
  toast(status === 'retired' ? 'Retired — its history is kept' : 'Reactivated');
  renderMerchList();
}

async function verifyMerchStyle(styleId) {
  const flagged = merchVariantsFor(styleId).filter((v) => v.needs_verification);
  const { error } = await window.supabase.from('inventory_merch_variants').update({ needs_verification: false, verification_note: null }).in('id', flagged.map((v) => v.id));
  if (error) { toast(error.message, true); return; }
  flagged.forEach((v) => { v.needs_verification = false; v.verification_note = null; });
  toast('Marked verified');
  renderMerchList();
}

async function deleteMerchStyle(styleId) {
  const s = merchStyles.find((x) => x.id === styleId);
  if (!confirm('Delete "' + merchStyleLabel(s) + '" and its entire count history? This can\'t be undone — use Retire to keep the history.')) return;
  const { error } = await window.supabase.from('inventory_merch_styles').delete().eq('id', styleId);
  if (error) { toast(error.message, true); return; }
  toast('Deleted');
  await loadMerch();
  await merchSyncProductStatus(s.product_id);
}

// ── COLOR / DESIGN FORM (inline in the product card) ──
function openMerchStyleForm(productId, styleId) { merchStyleForm = { productId, styleId }; renderMerchList(); }
function closeMerchStyleForm() { merchStyleForm = null; renderMerchList(); }

function merchStyleFormHtml() {
  const ed = merchStyleForm.styleId ? merchStyles.find((s) => s.id === merchStyleForm.styleId) : null;
  return '<div class="merch-vform"><div class="form-row" style="grid-template-columns:1fr 1fr' + (ed ? '' : ' 1fr 1fr') + ';">'
    + '<div class="form-group"><label class="form-label">Color</label><input class="form-input" type="text" id="merch-v-color" value="' + escHtml(ed ? ed.color : '') + '" placeholder="optional"></div>'
    + '<div class="form-group"><label class="form-label">Design / Logo</label><input class="form-input" type="text" id="merch-v-design" value="' + escHtml(ed ? ed.design : '') + '" placeholder="optional"></div>'
    + (ed ? '' : '<div class="form-group"><label class="form-label">Sizes</label><select class="form-select" id="merch-v-sizes" onchange="document.getElementById(\'merch-v-custom\').disabled = this.value !== \'custom\'">'
      + '<option value="apparel">X-Small to 3X-Large</option><option value="one">One size</option><option value="custom">Custom list</option></select></div>'
      + '<div class="form-group"><label class="form-label">Custom Sizes</label><input class="form-input" type="text" id="merch-v-custom" placeholder="e.g. 0.5 Liter, 1 Liter" disabled></div>')
    + '</div><div style="display:flex;gap:8px;">'
    + '<button class="btn btn-sm btn-primary" onclick="saveMerchStyleForm()">' + (ed ? 'Save Changes' : 'Add') + '</button>'
    + '<button class="btn btn-sm btn-secondary" onclick="closeMerchStyleForm()">Cancel</button></div></div>';
}

async function saveMerchStyleForm() {
  const { productId, styleId } = merchStyleForm;
  const color = document.getElementById('merch-v-color').value.trim() || null;
  const design = document.getElementById('merch-v-design').value.trim() || null;
  // 23505 = unique_violation on (product, color, design)
  const dupe = (error) => toast(error.code === '23505' ? 'That color / design already exists on this product' : error.message, true);
  if (styleId) {
    const { error } = await window.supabase.from('inventory_merch_styles').update({ color, design }).eq('id', styleId);
    if (error) { dupe(error); return; }
  } else {
    const mode = document.getElementById('merch-v-sizes').value;
    let sizes = [null];
    if (mode === 'apparel') sizes = MERCH_APPAREL_SIZES;
    if (mode === 'custom') sizes = document.getElementById('merch-v-custom').value.split(',').map((s) => s.trim()).filter(Boolean);
    if (!sizes.length) { toast('List at least one size', true); return; }
    const { data: style, error } = await window.supabase.from('inventory_merch_styles').insert({ product_id: productId, color, design }).select().single();
    if (error) { dupe(error); return; }
    const { error: vErr } = await window.supabase.from('inventory_merch_variants').insert(sizes.map((size, i) => (
      { style_id: style.id, size, size_sort: size == null ? 0 : (MERCH_APPAREL_SIZES.indexOf(size) + 1 || i + 1) })));
    if (vErr) { toast(vErr.message, true); return; }
  }
  merchStyleForm = null;
  toast(styleId ? 'Updated' : 'Added');
  await loadMerch();
  await merchSyncProductStatus(productId);
}

// ── PRODUCT FORM ─────────────────────────────────
function openMerchProductForm(productId) {
  const p = productId ? merchProducts.find((x) => x.id === productId) : null;
  merchProductEditId = p ? p.id : null;
  document.getElementById('merch-p-name').value = p ? p.name : '';
  document.getElementById('merch-p-type').value = p ? p.product_type : 'shirt';
  document.getElementById('merch-p-style').value = p ? p.style_number || '' : '';
  document.getElementById('merch-p-notes').value = p ? p.notes || '' : '';
  document.getElementById('merch-p-form-label').textContent = p ? 'Edit Product' : 'Add Product';
  document.getElementById('merch-p-save-btn').textContent = p ? 'Save Changes' : 'Add Product';
  document.getElementById('merch-p-delete-btn').style.display = p ? '' : 'none';
  const card = document.getElementById('merch-product-form');
  card.style.display = '';
  card.scrollIntoView({ block: 'nearest' });
  document.getElementById('merch-p-name').focus();
}
function closeMerchProductForm() {
  merchProductEditId = null;
  document.getElementById('merch-product-form').style.display = 'none';
}

async function saveMerchProduct() {
  const name = document.getElementById('merch-p-name').value.trim();
  if (!name) { toast('Name is required', true); return; }
  const payload = {
    name,
    product_type: document.getElementById('merch-p-type').value,
    style_number: document.getElementById('merch-p-style').value.trim() || null,
    notes: document.getElementById('merch-p-notes').value.trim() || null,
  };
  const { error } = merchProductEditId
    ? await window.supabase.from('inventory_merch_products').update(payload).eq('id', merchProductEditId)
    : await window.supabase.from('inventory_merch_products').insert(payload);
  if (error) { toast(error.message, true); return; }
  toast(merchProductEditId ? 'Product updated' : 'Product added — now add its colors and sizes');
  closeMerchProductForm();
  await loadMerch();
}

async function deleteMerchProduct() {
  const p = merchProducts.find((x) => x.id === merchProductEditId);
  if (!p) return;
  if (!confirm('Delete "' + p.name + '", every color and size under it, and all of its count history? This can\'t be undone — retire its colors instead to keep the history.')) return;
  const { error } = await window.supabase.from('inventory_merch_products').delete().eq('id', p.id);
  if (error) { toast(error.message, true); return; }
  toast('Product deleted');
  closeMerchProductForm();
  await loadMerch();
}

// ── TRENDS ───────────────────────────────────────
function showMerchTrendFor(productId) { merchTrendScope = productId; setMerchView('trends'); }
function setMerchTrendScope(scope) { merchTrendScope = scope; renderMerchTrends(); }
function setMerchTrendMonths(n) { merchTrendMonths = n; renderMerchTrends(); }

async function loadMerchTrends() {
  const el = document.getElementById('merch-trends');
  if (!merchCounts) {
    el.innerHTML = '<div class="loading">Loading count history...</div>';
    try { merchCounts = await merchFetchAll('inventory_merch_counts', 'variant_id,location_id,counted_on,unit_count', 'counted_on'); }
    catch (e) { el.innerHTML = '<div class="loading">Could not load count history: ' + escHtml(e.message) + '</div>'; return; }
  }
  renderMerchTrends();
}

// Month-by-month level for every variant, summed across its locations.
// Within one location a month with no count carries the previous count
// forward. Counts with no location (the spreadsheet import) stand for
// the whole variant until its first count at a real location, then
// drop out — the same rule the stock table follows. Counts are
// bucketed by the month of the date they were taken.
function merchBuildHistory() {
  if (!merchCounts.length) return { months: [], levels: {} };
  const first = merchCounts[0].counted_on.slice(0, 7);
  const last = merchCounts[merchCounts.length - 1].counted_on.slice(0, 7);
  const months = [];
  for (let y = +first.slice(0, 4), m = +first.slice(5); ; m++) {
    if (m > 12) { m = 1; y++; }
    const key = y + '-' + String(m).padStart(2, '0');
    months.push(key);
    if (key === last) break;
  }
  const idx = {};
  months.forEach((k, i) => { idx[k] = i; });
  const perLoc = {}; // variantId -> locKey -> sparse month array
  merchCounts.forEach((c) => { // ascending by date, so a later count in the same month wins
    const byLoc = perLoc[c.variant_id] = perLoc[c.variant_id] || {};
    const locKey = c.location_id || MERCH_UNSPLIT;
    (byLoc[locKey] = byLoc[locKey] || new Array(months.length).fill(null))[idx[c.counted_on.slice(0, 7)]] = c.unit_count;
  });
  const levels = {};
  Object.keys(perLoc).forEach((variantId) => {
    const byLoc = perLoc[variantId];
    let firstLocated = months.length;
    Object.keys(byLoc).forEach((k) => { if (k !== MERCH_UNSPLIT) firstLocated = Math.min(firstLocated, byLoc[k].findIndex((n) => n != null)); });
    const total = new Array(months.length).fill(0);
    Object.keys(byLoc).forEach((k) => {
      let prev = 0;
      byLoc[k].forEach((n, i) => { if (n != null) prev = n; if (k !== MERCH_UNSPLIT || i < firstLocated) total[i] += prev; });
    });
    levels[variantId] = total;
  });
  return { months, levels };
}

function merchMonthLabel(key) {
  return new Date(+key.slice(0, 4), +key.slice(5) - 1, 1).toLocaleString('default', { month: 'short' }) + ' ’' + key.slice(2, 4);
}

// On hand / change / est. sold / restocked for a set of variants over months [from..to].
function merchStats(variantIds, levels, from, to) {
  const s = { onHand: 0, start: 0, sold: 0, restocked: 0 };
  variantIds.forEach((id) => {
    const arr = levels[id];
    if (!arr) return;
    s.onHand += arr[to];
    s.start += arr[from];
    for (let i = from + 1; i <= to; i++) { const d = arr[i] - arr[i - 1]; if (d < 0) s.sold -= d; else s.restocked += d; }
  });
  const span = Math.max(1, to - from);
  s.change = s.onHand - s.start;
  s.perMonth = s.sold / span;
  s.monthsLeft = s.perMonth > 0 ? s.onHand / s.perMonth : null;
  return s;
}

function renderMerchTrends() {
  const el = document.getElementById('merch-trends');
  const { months, levels } = merchBuildHistory();
  if (months.length < 2) { el.innerHTML = '<div class="loading">Not enough count history yet — trends appear once there are counts in two different months.</div>'; return; }

  const product = merchProducts.find((p) => p.id === merchTrendScope);
  if (!product) merchTrendScope = 'all';
  const styleById = {}, productById = {};
  merchStyles.forEach((s) => { styleById[s.id] = s; });
  merchProducts.forEach((p) => { productById[p.id] = p; });
  const scoped = merchVariants.filter((v) => !product || styleById[v.style_id].product_id === product.id);
  const to = months.length - 1;
  const from = merchTrendMonths ? Math.max(0, to - merchTrendMonths) : 0;

  // Lines: by product type across everything, by color/design within one product.
  const buckets = {};
  scoped.forEach((v) => {
    if (!levels[v.id]) return;
    const style = styleById[v.style_id];
    const key = product ? merchStyleLabel(style) : (MERCH_TYPE_LABELS[productById[style.product_id].product_type] || 'Other');
    const b = buckets[key] = buckets[key] || new Array(months.length).fill(0);
    levels[v.id].forEach((n, i) => { b[i] += n; });
  });
  // Ranked by all-time peak (not the visible range) so a series keeps its color when the range changes.
  let series = Object.keys(buckets).map((name) => ({ name, values: buckets[name], peak: Math.max(...buckets[name]) })).sort((a, b) => b.peak - a.peak || a.name.localeCompare(b.name));
  if (series.length > MERCH_SERIES_COLORS.length) {
    const rest = series.slice(MERCH_SERIES_COLORS.length - 1);
    series = series.slice(0, MERCH_SERIES_COLORS.length - 1);
    series.push({ name: 'Other (' + rest.length + ')', other: true, values: months.map((_, i) => rest.reduce((a, s) => a + s.values[i], 0)) });
  }
  series.forEach((s, i) => { s.color = s.other ? MERCH_OTHER_COLOR : MERCH_SERIES_COLORS[i]; });

  const total = merchStats(scoped.map((v) => v.id), levels, from, to);
  const rangeLabel = merchMonthLabel(months[from]) + ' – ' + merchMonthLabel(months[to]);
  const signed = (n) => (n > 0 ? '▲ ' + n : n < 0 ? '▼ ' + Math.abs(n) : '0');
  const tile = (title, value, sub) => '<div class="card"><div class="card-title">' + title + '</div><div class="card-value">' + value + '</div><div class="card-sub">' + sub + '</div></div>';

  const scopeOptions = '<option value="all">All merchandise</option>'
    + ['active', 'retired'].map((st) => '<optgroup label="' + (st === 'active' ? 'Active products' : 'Retired products') + '">'
      + merchProducts.filter((p) => p.status === st).map((p) => '<option value="' + p.id + '"' + (p.id === merchTrendScope ? ' selected' : '') + '>' + escHtml(p.name + (p.style_number ? ' (' + p.style_number + ')' : '')) + '</option>').join('') + '</optgroup>').join('');
  const rangePill = (n, label) => '<div class="badge-pill' + (merchTrendMonths === n ? ' selected' : '') + '" onclick="setMerchTrendMonths(' + n + ')">' + label + '</div>';

  let html = '<div class="lookup-toolbar" style="flex-wrap:wrap;">'
    + '<select class="form-select" aria-label="Product" onchange="setMerchTrendScope(this.value)">' + scopeOptions + '</select>'
    + '<div class="badge-picker">' + rangePill(6, '6 months') + rangePill(12, '12 months') + rangePill(24, '24 months') + rangePill(0, 'All time') + '</div>'
    + '</div>'
    + '<div class="grid-4">'
    + tile('Units On Hand', total.onHand, 'as of ' + merchMonthLabel(months[to]))
    + tile('Change', signed(total.change), 'since ' + merchMonthLabel(months[from]))
    + tile('Est. Sold', total.sold, total.perMonth.toFixed(1) + ' per month')
    + tile('Restocked', total.restocked, rangeLabel)
    + '</div>'
    + '<div class="card" style="margin-bottom:16px;"><div class="card-title">' + escHtml(product ? product.name + ' — units on hand by color / design' : 'Units on hand by product type') + '</div>'
    + merchChartHtml(months, series, from, to) + '</div>';

  // Table view of the same period — one row per product, or per variant within a product.
  const rows = product
    ? scoped.map((v) => ({ name: [merchStyleLabel(styleById[v.style_id]), v.size].filter(Boolean).join(' · '), retired: styleById[v.style_id].status === 'retired', st: merchStats([v.id], levels, from, to) }))
    : merchProducts.map((p) => ({ id: p.id, name: p.name + (p.style_number ? ' (' + p.style_number + ')' : ''), retired: p.status === 'retired',
      st: merchStats(merchVariants.filter((v) => styleById[v.style_id].product_id === p.id).map((v) => v.id), levels, from, to) }));
  rows.sort((a, b) => b.st.sold - a.st.sold || b.st.onHand - a.st.onHand);
  html += '<div class="section-label">' + (product ? 'By color, design and size' : 'By product') + ' · ' + rangeLabel + '</div>'
    + '<div class="table-wrap"><table><thead><tr><th>' + (product ? 'Variant' : 'Product') + '</th><th class="merch-num">On Hand</th><th class="merch-num">Change</th><th class="merch-num">Est. Sold</th><th class="merch-num">Restocked</th><th class="merch-num">Sold / Month</th><th class="merch-num">Months of Stock Left</th></tr></thead><tbody>'
    + rows.map((r) => '<tr' + (r.id ? ' style="cursor:pointer;" onclick="setMerchTrendScope(\'' + r.id + '\')"' : '') + (r.retired ? ' class="merch-retired"' : '') + '>'
      + '<td style="font-weight:500;">' + escHtml(r.name) + (r.retired ? ' <span class="badge badge-muted">Retired</span>' : '') + '</td>'
      + '<td class="merch-num">' + r.st.onHand + '</td><td class="merch-num">' + signed(r.st.change) + '</td><td class="merch-num">' + r.st.sold + '</td><td class="merch-num">' + r.st.restocked + '</td>'
      + '<td class="merch-num">' + r.st.perMonth.toFixed(1) + '</td><td class="merch-num">' + (r.st.monthsLeft == null ? '—' : r.st.monthsLeft.toFixed(1)) + '</td></tr>').join('')
    + '</tbody></table></div>'
    + '<div class="card-sub" style="margin-top:10px;">Sold and restocked are estimates read from the counts: any drop between two counts is treated as sold, any rise as restocked, so a miscount inflates both. Months without a count carry the previous count forward. Levels are the total across all locations.</div>';
  el.innerHTML = html;
}

// ── LINE CHART (inline SVG, no library) ──────────
function merchChartHtml(months, series, from, to) {
  const W = 860, H = 300, L = 44, R = 16, T = 12, B = 28;
  const n = to - from + 1;
  const max = Math.max(1, ...series.map((s) => Math.max(...s.values.slice(from, to + 1))));
  const step = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000].find((s) => max / s <= 5) || Math.ceil(max / 5);
  const top = Math.ceil(max / step) * step;
  const x = (i) => L + (i * (W - L - R)) / (n - 1);
  const y = (v) => T + (H - T - B) * (1 - v / top);
  merchChart = { months: months.slice(from, to + 1), series: series.map((s) => ({ name: s.name, color: s.color, values: s.values.slice(from, to + 1) })), W, x };

  let svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" class="merch-chart-svg" role="img" aria-label="Units on hand over time" onmousemove="merchChartHover(event)" onmouseleave="merchChartLeave()">';
  for (let v = 0; v <= top; v += step) {
    svg += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + y(v) + '" y2="' + y(v) + '" class="merch-grid"/>'
      + '<text x="' + (L - 8) + '" y="' + (y(v) + 4) + '" text-anchor="end" class="merch-axis">' + v + '</text>';
  }
  const every = Math.ceil(n / 8);
  for (let i = n - 1; i >= 0; i -= every) svg += '<text x="' + x(i) + '" y="' + (H - 8) + '" text-anchor="middle" class="merch-axis">' + merchMonthLabel(months[from + i]) + '</text>';
  svg += '<line id="merch-xhair" y1="' + T + '" y2="' + (H - B) + '" class="merch-xhair" style="display:none;"/>';
  merchChart.series.forEach((s) => {
    svg += '<path d="' + s.values.map((v, i) => (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(v).toFixed(1)).join(' ') + '" fill="none" stroke="' + s.color + '" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>'
      + '<circle cx="' + x(n - 1) + '" cy="' + y(s.values[n - 1]) + '" r="4" fill="' + s.color + '" class="merch-dot"/>';
  });
  svg += '</svg>';

  const legend = series.length < 2 ? '' : '<div class="merch-legend">' + series.map((s) => '<span><i style="background:' + s.color + ';"></i>' + escHtml(s.name) + '</span>').join('') + '</div>';
  return legend + '<div class="merch-chart-wrap">' + svg + '<div id="merch-tip" class="merch-tip" style="display:none;"></div></div>';
}

function merchChartHover(e) {
  if (!merchChart) return;
  const svg = e.currentTarget;
  const rect = svg.getBoundingClientRect();
  const { months, series, W, x } = merchChart;
  const vx = ((e.clientX - rect.left) / rect.width) * W;
  const i = Math.min(months.length - 1, Math.max(0, Math.round(((vx - x(0)) / (x(months.length - 1) - x(0))) * (months.length - 1))));
  const hair = document.getElementById('merch-xhair');
  hair.setAttribute('x1', x(i)); hair.setAttribute('x2', x(i)); hair.style.display = '';
  const tip = document.getElementById('merch-tip');
  tip.innerHTML = '<div class="merch-tip-title">' + merchMonthLabel(months[i]) + '</div>'
    + series.slice().sort((a, b) => b.values[i] - a.values[i]).map((s) => '<div><i style="background:' + s.color + ';"></i>' + escHtml(s.name) + '<b>' + s.values[i] + '</b></div>').join('')
    + (series.length > 1 ? '<div class="merch-tip-total">Total<b>' + series.reduce((a, s) => a + s.values[i], 0) + '</b></div>' : '');
  tip.style.display = '';
  const pct = (x(i) / W) * 100;
  tip.style.left = pct > 60 ? '' : 'calc(' + pct + '% + 12px)';
  tip.style.right = pct > 60 ? 'calc(' + (100 - pct) + '% + 12px)' : '';
}

function merchChartLeave() {
  document.getElementById('merch-xhair').style.display = 'none';
  document.getElementById('merch-tip').style.display = 'none';
}
