// merch.js
// Inventory > Merchandise sub-tab. Merch is counted in actual units per
// colour / design / size variant (migration_034), not the rough percent
// the other inventory categories use, so it has its own screen:
//
//   Stock   one card per product, a colour/design × size grid of unit
//           counts you can type straight into.
//   Trends  levels over time from the count log, plus estimated units
//           sold / restocked per product.
//
// inventory_merch_counts is the source of truth. Typing a number here
// never updates a variant directly — it upserts today's count row and
// the database trigger carries it onto the variant, so the "on hand"
// number can't drift from the history.
//
// "Sold" and "restocked" are estimates read off the counts: any drop
// between two counts is treated as sold, any rise as restocked. A
// miscount therefore inflates both.
// Depends on: window.supabase, window.currentStaff, toast(),
// escHtml() (menu.js), toDateStr() (schedule.js)

const MERCH_TYPE_LABELS = { shirt: 'Shirts', tank: 'Tanks', long_sleeve: 'Long Sleeves', sweatshirt: 'Sweatshirts', outerwear: 'Outerwear', hat: 'Hats', visor: 'Visors', drinkware: 'Drinkware', accessory: 'Accessories', other: 'Other' };
const MERCH_APPAREL_SIZES = ['X-Small', 'Small', 'Medium', 'Large', 'X-Large', 'XX-Large', '3X-Large'];
// Chart series colours, assigned in this fixed order. Kept apart from
// the app's teal/amber/red, which mean OK / low / critical elsewhere.
const MERCH_SERIES_COLORS = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#9085e9'];
const MERCH_OTHER_COLOR = '#8E92B0';

let merchProducts = [];
let merchVariants = [];
let merchCounts = null; // loaded on first visit to Trends
let merchGroups = {};   // gid -> { productId, color, design, variants } for the rows currently drawn
let merchView = 'stock';
let merchStatusFilter = 'active';
let merchTypeFilter = '';
let merchSearch = '';
let merchProductEditId = null;
let merchVariantForm = null; // { productId, gid } while a colour/design form is open
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
    [merchProducts, merchVariants] = await Promise.all([
      merchFetchAll('inventory_merch_products', '*', 'name'),
      merchFetchAll('inventory_merch_variants', '*', 'size_sort'),
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
    + '<input class="search-bar" style="min-width:200px;" type="search" placeholder="Search product, colour or design" oninput="setMerchSearch(this.value)">'
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

// ── STOCK ────────────────────────────────────────
function merchGroupLabel(g) {
  return [g.color, g.design].filter(Boolean).join(' · ') || 'One version';
}

// A product's variants bucketed into colour/design rows, sizes in order.
function merchGroupsFor(productId) {
  const groups = [];
  merchVariants.filter((v) => v.product_id === productId).forEach((v) => {
    let g = groups.find((x) => x.color === v.color && x.design === v.design);
    if (!g) { g = { productId, color: v.color, design: v.design, variants: [] }; groups.push(g); }
    g.variants.push(v);
  });
  return groups;
}

function merchGroupMatches(g) {
  if (merchStatusFilter === 'active' && !g.variants.some((v) => v.status === 'active')) return false;
  if (merchStatusFilter === 'retired' && !g.variants.every((v) => v.status === 'retired')) return false;
  if (merchStatusFilter === 'verify' && !g.variants.some((v) => v.needs_verification)) return false;
  return true;
}

function renderMerchList() {
  const el = document.getElementById('merch-list');
  merchGroups = {};
  let gidSeq = 0;
  const cards = [];
  merchProducts.forEach((p) => {
    if (merchTypeFilter && p.product_type !== merchTypeFilter) return;
    const all = merchGroupsFor(p.id);
    const nameHit = !merchSearch || (p.name + ' ' + (p.style_number || '')).toLowerCase().includes(merchSearch);
    const groups = all.filter(merchGroupMatches).filter((g) => nameHit || merchGroupLabel(g).toLowerCase().includes(merchSearch));
    // A product with no variants yet has nothing to filter on — show it wherever a new product would belong.
    const emptyNew = !all.length && nameHit && (merchStatusFilter === 'all' || merchStatusFilter === p.status);
    if (!groups.length && !emptyNew) return;
    groups.forEach((g) => { g.gid = 'g' + (gidSeq++); merchGroups[g.gid] = g; });
    cards.push(merchProductCardHtml(p, groups, all));
  });
  el.innerHTML = cards.length ? cards.join('') : '<div class="loading">Nothing matches these filters.</div>';
}

function merchProductCardHtml(p, groups, allGroups) {
  const total = allGroups.reduce((a, g) => a + g.variants.reduce((b, v) => b + v.unit_count, 0), 0);
  const sizes = [];
  groups.forEach((g) => g.variants.forEach((v) => { if (!sizes.some((s) => s.size === v.size)) sizes.push({ size: v.size, sort: v.size_sort }); }));
  sizes.sort((a, b) => a.sort - b.sort || String(a.size).localeCompare(String(b.size)));

  let html = '<div class="card merch-card"><div class="merch-card-head"><div>'
    + '<div class="merch-name">' + escHtml(p.name) + (p.status === 'retired' ? ' <span class="badge badge-muted">Retired</span>' : '') + '</div>'
    + '<div class="merch-sub">' + escHtml(MERCH_TYPE_LABELS[p.product_type] || p.product_type) + (p.style_number ? ' · Style ' + escHtml(p.style_number) : '') + (p.notes ? ' · ' + escHtml(p.notes) : '') + '</div>'
    + '</div><div class="merch-card-actions">'
    + '<div class="merch-total"><span id="merch-ptotal-' + p.id + '">' + total + '</span><small>on hand</small></div>'
    + '<button class="btn btn-sm btn-secondary" onclick="openMerchVariantForm(\'' + p.id + '\',null)">+ Colour / Design</button>'
    + '<button class="btn btn-sm btn-secondary" onclick="openMerchProductForm(\'' + p.id + '\')">Edit</button>'
    + '<button class="btn btn-sm btn-secondary" onclick="showMerchTrendFor(\'' + p.id + '\')">Trend</button>'
    + '</div></div>';

  if (merchVariantForm && merchVariantForm.productId === p.id) html += merchVariantFormHtml();
  if (!groups.length) return html + '<div class="loading">No colours or sizes yet — add one above.</div></div>';

  html += '<div class="table-wrap merch-matrix"><table><thead><tr><th>Colour / Design</th>'
    + sizes.map((s) => '<th class="merch-num">' + escHtml(s.size || 'Qty') + '</th>').join('') + '<th class="merch-num">Total</th><th></th></tr></thead><tbody>';
  groups.forEach((g) => {
    const retired = g.variants.every((v) => v.status === 'retired');
    const flagged = g.variants.filter((v) => v.needs_verification);
    html += '<tr' + (retired ? ' class="merch-retired"' : '') + '><td>' + escHtml(merchGroupLabel(g)) + (retired ? ' <span class="badge badge-muted">Retired</span>' : '')
      + flagged.map((v) => '<div class="merch-verify">&#9888; Needs verification' + (v.size ? ' (' + escHtml(v.size) + ')' : '') + (v.verification_note ? ': ' + escHtml(v.verification_note) : '') + '</div>').join('') + '</td>';
    sizes.forEach((s) => {
      const v = g.variants.find((x) => x.size === s.size);
      html += '<td class="merch-num">' + (v
        ? '<input class="merch-cell' + (v.needs_verification ? ' flagged' : '') + '" type="number" min="0" step="1" value="' + v.unit_count + '" data-gid="' + g.gid + '" aria-label="' + escHtml(merchGroupLabel(g) + ' ' + (s.size || '')) + '" onchange="saveMerchCount(\'' + v.id + '\',this)">'
        : '<span style="color:var(--muted);">—</span>') + '</td>';
    });
    html += '<td class="merch-num" id="merch-gtotal-' + g.gid + '">' + g.variants.reduce((a, v) => a + v.unit_count, 0) + '</td>'
      + '<td style="white-space:nowrap;text-align:right;">'
      + (flagged.length ? '<button class="btn btn-sm btn-success" onclick="verifyMerchGroup(\'' + g.gid + '\')">Mark Verified</button> ' : '')
      + '<button class="btn btn-sm btn-secondary" onclick="openMerchVariantForm(\'' + p.id + '\',\'' + g.gid + '\')">Edit</button> '
      + '<button class="btn btn-sm btn-secondary" onclick="setMerchGroupStatus(\'' + g.gid + '\',\'' + (retired ? 'active' : 'retired') + '\')">' + (retired ? 'Reactivate' : 'Retire') + '</button> '
      + '<button class="btn btn-sm btn-danger" onclick="deleteMerchGroup(\'' + g.gid + '\')">Delete</button>'
      + '</td></tr>';
  });
  return html + '</tbody></table></div></div>';
}

// One count per variant per day — typing a second number the same day
// replaces the first rather than adding another history row.
async function saveMerchCount(variantId, input) {
  const v = merchVariants.find((x) => x.id === variantId);
  const n = parseInt(input.value, 10);
  if (!v || isNaN(n) || n < 0) { input.value = v ? v.unit_count : 0; toast('Enter a whole number, 0 or more', true); return; }
  const { error } = await window.supabase.from('inventory_merch_counts').upsert(
    { variant_id: variantId, counted_on: toDateStr(new Date()), counted_at: new Date().toISOString(), unit_count: n, counted_by: window.currentStaff.id, source: 'app' },
    { onConflict: 'variant_id,counted_on' });
  if (error) { input.value = v.unit_count; toast(error.message, true); return; }
  v.unit_count = n;
  input.value = n;
  merchCounts = null;
  const g = merchGroups[input.dataset.gid];
  if (g) document.getElementById('merch-gtotal-' + g.gid).textContent = g.variants.reduce((a, x) => a + x.unit_count, 0);
  document.getElementById('merch-ptotal-' + v.product_id).textContent = merchVariants.filter((x) => x.product_id === v.product_id).reduce((a, x) => a + x.unit_count, 0);
  toast('Count saved');
}

// A product is retired exactly when every one of its variants is.
async function merchSyncProductStatus(productId) {
  const vs = merchVariants.filter((v) => v.product_id === productId);
  const p = merchProducts.find((x) => x.id === productId);
  if (!p || !vs.length) return;
  const status = vs.every((v) => v.status === 'retired') ? 'retired' : 'active';
  if (status === p.status) return;
  const { error } = await window.supabase.from('inventory_merch_products').update({ status }).eq('id', productId);
  if (!error) p.status = status;
}

async function setMerchGroupStatus(gid, status) {
  const g = merchGroups[gid];
  if (!g) return;
  const { error } = await window.supabase.from('inventory_merch_variants').update({ status }).in('id', g.variants.map((v) => v.id));
  if (error) { toast(error.message, true); return; }
  g.variants.forEach((v) => { v.status = status; });
  await merchSyncProductStatus(g.productId);
  toast(status === 'retired' ? 'Retired — its history is kept' : 'Reactivated');
  renderMerchList();
}

async function verifyMerchGroup(gid) {
  const g = merchGroups[gid];
  if (!g) return;
  const flagged = g.variants.filter((v) => v.needs_verification);
  const { error } = await window.supabase.from('inventory_merch_variants').update({ needs_verification: false, verification_note: null }).in('id', flagged.map((v) => v.id));
  if (error) { toast(error.message, true); return; }
  flagged.forEach((v) => { v.needs_verification = false; v.verification_note = null; });
  toast('Marked verified');
  renderMerchList();
}

async function deleteMerchGroup(gid) {
  const g = merchGroups[gid];
  if (!g) return;
  if (!confirm('Delete "' + merchGroupLabel(g) + '" and its entire count history? This can\'t be undone — use Retire to keep the history.')) return;
  const ids = g.variants.map((v) => v.id);
  const { error } = await window.supabase.from('inventory_merch_variants').delete().in('id', ids);
  if (error) { toast(error.message, true); return; }
  merchVariants = merchVariants.filter((v) => !ids.includes(v.id));
  merchCounts = null;
  await merchSyncProductStatus(g.productId);
  toast('Deleted');
  renderMerchList();
}

// ── COLOUR / DESIGN FORM (inline in the product card) ──
function openMerchVariantForm(productId, gid) {
  const g = gid ? merchGroups[gid] : null;
  merchVariantForm = { productId, editing: g ? { ids: g.variants.map((v) => v.id), color: g.color, design: g.design } : null };
  renderMerchList();
}
function closeMerchVariantForm() { merchVariantForm = null; renderMerchList(); }

function merchVariantFormHtml() {
  const ed = merchVariantForm.editing;
  return '<div class="merch-vform"><div class="form-row" style="grid-template-columns:1fr 1fr' + (ed ? '' : ' 1fr 1fr') + ';">'
    + '<div class="form-group"><label class="form-label">Colour</label><input class="form-input" type="text" id="merch-v-color" value="' + escHtml(ed ? ed.color : '') + '" placeholder="optional"></div>'
    + '<div class="form-group"><label class="form-label">Design / Logo</label><input class="form-input" type="text" id="merch-v-design" value="' + escHtml(ed ? ed.design : '') + '" placeholder="optional"></div>'
    + (ed ? '' : '<div class="form-group"><label class="form-label">Sizes</label><select class="form-select" id="merch-v-sizes" onchange="document.getElementById(\'merch-v-custom\').disabled = this.value !== \'custom\'">'
      + '<option value="apparel">X-Small to 3X-Large</option><option value="one">One size</option><option value="custom">Custom list</option></select></div>'
      + '<div class="form-group"><label class="form-label">Custom Sizes</label><input class="form-input" type="text" id="merch-v-custom" placeholder="e.g. 0.5 Liter, 1 Liter" disabled></div>')
    + '</div><div style="display:flex;gap:8px;">'
    + '<button class="btn btn-sm btn-primary" onclick="saveMerchVariantForm()">' + (ed ? 'Save Changes' : 'Add') + '</button>'
    + '<button class="btn btn-sm btn-secondary" onclick="closeMerchVariantForm()">Cancel</button></div></div>';
}

async function saveMerchVariantForm() {
  const { productId, editing } = merchVariantForm;
  const color = document.getElementById('merch-v-color').value.trim() || null;
  const design = document.getElementById('merch-v-design').value.trim() || null;
  let error;
  if (editing) {
    ({ error } = await window.supabase.from('inventory_merch_variants').update({ color, design }).in('id', editing.ids));
  } else {
    const mode = document.getElementById('merch-v-sizes').value;
    let sizes = [null];
    if (mode === 'apparel') sizes = MERCH_APPAREL_SIZES;
    if (mode === 'custom') sizes = document.getElementById('merch-v-custom').value.split(',').map((s) => s.trim()).filter(Boolean);
    if (!sizes.length) { toast('List at least one size', true); return; }
    ({ error } = await window.supabase.from('inventory_merch_variants').insert(sizes.map((size, i) => (
      { product_id: productId, color, design, size, size_sort: size == null ? 0 : (MERCH_APPAREL_SIZES.indexOf(size) + 1 || i + 1) }))));
  }
  // 23505 = unique_violation on (product, colour, design, size)
  if (error) { toast(error.code === '23505' ? 'That colour / design already exists on this product' : error.message, true); return; }
  merchVariantForm = null;
  toast(editing ? 'Updated' : 'Added');
  await loadMerch();
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
  toast(merchProductEditId ? 'Product updated' : 'Product added — now add its colours and sizes');
  closeMerchProductForm();
  await loadMerch();
}

async function deleteMerchProduct() {
  const p = merchProducts.find((x) => x.id === merchProductEditId);
  if (!p) return;
  if (!confirm('Delete "' + p.name + '", every colour and size under it, and all of its count history? This can\'t be undone — retire its colours instead to keep the history.')) return;
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
    try { merchCounts = await merchFetchAll('inventory_merch_counts', 'variant_id,counted_on,unit_count', 'counted_on'); }
    catch (e) { el.innerHTML = '<div class="loading">Could not load count history: ' + escHtml(e.message) + '</div>'; return; }
  }
  renderMerchTrends();
}

// Month-by-month level for every variant. A month with no count
// carries the previous count forward; before a variant's first count
// it is 0. Counts are bucketed by the month of the date they were taken.
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
  const levels = {};
  merchCounts.forEach((c) => { // ascending by date, so a later count in the same month wins
    (levels[c.variant_id] = levels[c.variant_id] || new Array(months.length).fill(null))[idx[c.counted_on.slice(0, 7)]] = c.unit_count;
  });
  Object.values(levels).forEach((arr) => { let prev = 0; for (let i = 0; i < arr.length; i++) { if (arr[i] == null) arr[i] = prev; else prev = arr[i]; } });
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
  const scoped = merchVariants.filter((v) => !product || v.product_id === product.id);
  const to = months.length - 1;
  const from = merchTrendMonths ? Math.max(0, to - merchTrendMonths) : 0;

  // Lines: by product type across everything, by colour/design within one product.
  const productById = {};
  merchProducts.forEach((p) => { productById[p.id] = p; });
  const buckets = {};
  scoped.forEach((v) => {
    if (!levels[v.id]) return;
    const key = product ? merchGroupLabel(v) : (MERCH_TYPE_LABELS[productById[v.product_id].product_type] || 'Other');
    const b = buckets[key] = buckets[key] || new Array(months.length).fill(0);
    levels[v.id].forEach((n, i) => { b[i] += n; });
  });
  // Ranked by all-time peak (not the visible range) so a series keeps its colour when the range changes.
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
    + '<div class="card" style="margin-bottom:16px;"><div class="card-title">' + escHtml(product ? product.name + ' — units on hand by colour / design' : 'Units on hand by product type') + '</div>'
    + merchChartHtml(months, series, from, to) + '</div>';

  // Table view of the same period — one row per product, or per variant within a product.
  const rows = product
    ? scoped.map((v) => ({ name: [merchGroupLabel(v), v.size].filter(Boolean).join(' · '), retired: v.status === 'retired', st: merchStats([v.id], levels, from, to) }))
    : merchProducts.map((p) => ({ id: p.id, name: p.name + (p.style_number ? ' (' + p.style_number + ')' : ''), retired: p.status === 'retired', st: merchStats(merchVariants.filter((v) => v.product_id === p.id).map((v) => v.id), levels, from, to) }));
  rows.sort((a, b) => b.st.sold - a.st.sold || b.st.onHand - a.st.onHand);
  html += '<div class="section-label">' + (product ? 'By colour, design and size' : 'By product') + ' · ' + rangeLabel + '</div>'
    + '<div class="table-wrap"><table><thead><tr><th>' + (product ? 'Variant' : 'Product') + '</th><th class="merch-num">On Hand</th><th class="merch-num">Change</th><th class="merch-num">Est. Sold</th><th class="merch-num">Restocked</th><th class="merch-num">Sold / Month</th><th class="merch-num">Months of Stock Left</th></tr></thead><tbody>'
    + rows.map((r) => '<tr' + (r.id ? ' style="cursor:pointer;" onclick="setMerchTrendScope(\'' + r.id + '\')"' : '') + (r.retired ? ' class="merch-retired"' : '') + '>'
      + '<td style="font-weight:500;">' + escHtml(r.name) + (r.retired ? ' <span class="badge badge-muted">Retired</span>' : '') + '</td>'
      + '<td class="merch-num">' + r.st.onHand + '</td><td class="merch-num">' + signed(r.st.change) + '</td><td class="merch-num">' + r.st.sold + '</td><td class="merch-num">' + r.st.restocked + '</td>'
      + '<td class="merch-num">' + r.st.perMonth.toFixed(1) + '</td><td class="merch-num">' + (r.st.monthsLeft == null ? '—' : r.st.monthsLeft.toFixed(1)) + '</td></tr>').join('')
    + '</tbody></table></div>'
    + '<div class="card-sub" style="margin-top:10px;">Sold and restocked are estimates read from the counts: any drop between two counts is treated as sold, any rise as restocked, so a miscount inflates both. Months without a count carry the previous count forward.</div>';
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
