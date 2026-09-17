// inventory.js
// Screen: #screen-inventory — brewery inventory isn't a full retail
// count, so items carry a rough percent remaining (or, for wine, an
// actual bottle count) rather than exact quantities. Status color is
// derived from percent/count vs. each row's own low/critical
// thresholds (defaults 50%/25%, editable per row) — never stored as
// a separate field, so it can't drift out of sync with the number.
//
// "Already ordered, awaiting arrival" is likewise derived, from
// whether an open (received_at is null) row exists in
// inventory_order_log for that item — see migration_020.
//
// Vendor read is staff-wide; vendor add/edit/delete is admin-only
// (window.currentStaff.role === 'admin'), enforced again server-side
// by RLS. Item/wine counts and the order log are editable by any
// staff.
// Depends on: window.supabase, toast(), escHtml() (js/menu.js)

const INV_CATEGORY_LABELS = { consumables: 'Consumables', snacks: 'Snacks', coffee: 'Coffee', merchandise: 'Merchandise' };
const INV_ITEM_CATEGORIES = Object.keys(INV_CATEGORY_LABELS);

let invItemsCache = [];
let invWineCache = [];
let invVendorsCache = [];
let invVendorItemsCache = [];
let invOpenOrdersCache = [];
let invRefDataLoaded = false;
let invItemEditId = { consumables: null, snacks: null, coffee: null, merchandise: null };
let invWineEditId = null;
let invSelectedVendorId = null;
let invVendorItemEditId = null;

function loadInventory() {
  setInventoryTab('dashboard', document.getElementById('inventorytab-btn-dashboard'));
}

function setInventoryTab(tab, btn) {
  document.querySelectorAll('#screen-inventory > .sub-tabs .sub-tab').forEach((b) => b.classList.remove('active'));
  document.querySelectorAll('#screen-inventory > .sub-sec').forEach((s) => s.classList.remove('active'));
  if (btn) btn.classList.add('active');
  document.getElementById('inventorytab-' + tab).classList.add('active');
  if (tab === 'dashboard') loadInventoryDashboard();
  else if (INV_ITEM_CATEGORIES.includes(tab)) { ensureCategoryTemplateBuilt(tab); loadInventoryCategory(tab); }
  else if (tab === 'wine') loadInventoryWine();
  else if (tab === 'vendors') loadInventoryVendors();
}

// ── SHARED HELPERS ────────────────────────────────
function invVal(id) { return document.getElementById(id).value.trim(); }
function invSetVal(id, v) { document.getElementById(id).value = v; }
function invClampInt(raw, min, max, fallback) {
  const n = parseInt(raw, 10);
  if (isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
function invAlert(id, msg, isError) {
  const el = document.getElementById(id);
  el.style.display = 'block';
  el.style.background = isError ? 'rgba(220,53,69,0.1)' : 'rgba(42,184,166,0.1)';
  el.style.color = isError ? 'var(--red)' : 'var(--teal)';
  el.textContent = msg;
}
function invClearAlert(id) {
  const el = document.getElementById(id);
  el.style.display = 'none';
  el.textContent = '';
}

// value/low/critical follow the same "lower is worse" shape whether
// it's a percent (item) or a bottle count (wine).
function invStatusColor(value, low, critical) {
  if (value <= critical) return 'red';
  if (value <= low) return 'amber';
  return 'ok';
}
function invStatusBadge(color) {
  if (color === 'red') return '<span class="badge badge-red">Red</span>';
  if (color === 'amber') return '<span class="badge badge-amber">Yellow</span>';
  return '<span class="badge badge-teal">OK</span>';
}

async function invEnsureRefData(force) {
  if (invRefDataLoaded && !force) return;
  const [{ data: vendors }, { data: vendorItems }] = await Promise.all([
    window.supabase.from('inventory_vendors').select('*').order('name'),
    window.supabase.from('inventory_vendor_items').select('*').order('item_name'),
  ]);
  invVendorsCache = vendors || [];
  invVendorItemsCache = vendorItems || [];
  invRefDataLoaded = true;
}

async function invLoadOpenOrders() {
  const { data } = await window.supabase.from('inventory_order_log').select('*').is('received_at', null);
  invOpenOrdersCache = data || [];
}
function invOpenOrderFor(itemType, itemId) {
  return invOpenOrdersCache.find((o) => o.item_type === itemType && o.item_id === itemId);
}

function invVendorItemOptions(selectedId, filterCategory) {
  const items = filterCategory ? invVendorItemsCache.filter((vi) => !vi.category || vi.category === filterCategory) : invVendorItemsCache;
  return '<option value="">None linked</option>' + items.map((vi) => {
    const vendor = invVendorsCache.find((v) => v.id === vi.vendor_id);
    const label = (vendor ? vendor.name + ' — ' : '') + vi.item_name + (vi.sku_or_item_number ? ' (' + vi.sku_or_item_number + ')' : '');
    return '<option value="' + vi.id + '"' + (vi.id === selectedId ? ' selected' : '') + '>' + escHtml(label) + '</option>';
  }).join('');
}
function invVendorItemLabel(id) {
  const vi = invVendorItemsCache.find((v) => v.id === id);
  if (!vi) return '<span style="color:var(--muted);font-size:11px;">—</span>';
  const vendor = invVendorsCache.find((v) => v.id === vi.vendor_id);
  return '<div style="font-size:12px;">' + escHtml(vi.item_name) + '</div><div style="font-size:11px;color:var(--sub);">' + escHtml(vendor ? vendor.name : '') + (vi.sku_or_item_number ? ' &middot; #' + escHtml(vi.sku_or_item_number) : '') + '</div>';
}

async function invMarkOrdered(itemType, itemId, vendorItemId, onDone) {
  const { error } = await window.supabase.from('inventory_order_log').insert({
    item_type: itemType, item_id: itemId, vendor_item_id: vendorItemId || null, ordered_by: window.currentStaff.id,
  });
  if (error) { toast(error.message, true); return; }
  toast('Marked as ordered');
  await invLoadOpenOrders();
  onDone();
}
async function invMarkReceived(itemType, itemId, onDone) {
  const openOrder = invOpenOrderFor(itemType, itemId);
  if (!openOrder) return;
  const { error } = await window.supabase.from('inventory_order_log')
    .update({ received_at: new Date().toISOString(), received_by: window.currentStaff.id })
    .eq('id', openOrder.id);
  if (error) { toast(error.message, true); return; }
  toast('Marked received — update the count now that it’s restocked.');
  await invLoadOpenOrders();
  onDone();
}
function invOrderCellHtml(itemType, itemId, color, vendorItemId, cat) {
  const openOrder = invOpenOrderFor(itemType, itemId);
  const reloadCall = itemType === 'wine' ? 'loadInventoryWine()' : "loadInventoryCategory('" + cat + "')";
  if (openOrder) {
    return '<span class="badge badge-amber">Ordered</span> <button class="btn btn-sm btn-secondary" onclick="invMarkReceived(\'' + itemType + '\',\'' + itemId + '\',()=>' + reloadCall + ')">Mark Received</button>';
  }
  if (color !== 'ok') {
    return '<button class="btn btn-sm btn-secondary" onclick="invMarkOrdered(\'' + itemType + '\',\'' + itemId + '\',' + (vendorItemId ? "'" + vendorItemId + "'" : 'null') + ',()=>' + reloadCall + ')">Mark Ordered</button>';
  }
  return '<span style="font-size:11px;color:var(--muted);">—</span>';
}

// ── DASHBOARD ────────────────────────────────────
async function loadInventoryDashboard() {
  await invEnsureRefData();
  const [{ data: items }, { data: wine }] = await Promise.all([
    window.supabase.from('inventory_items').select('*'),
    window.supabase.from('inventory_wine').select('*'),
  ]);
  invItemsCache = items || [];
  invWineCache = wine || [];
  await invLoadOpenOrders();

  const cardsEl = document.getElementById('inv-dash-category-cards');
  const categoryCards = INV_ITEM_CATEGORIES.map((cat) => {
    const rows = invItemsCache.filter((i) => i.category === cat);
    return invDashCardHtml(INV_CATEGORY_LABELS[cat], rows.map((i) => invStatusColor(i.percent_remaining, i.low_threshold, i.critical_threshold)));
  });
  categoryCards.push(invDashCardHtml('Wine', invWineCache.map((w) => invStatusColor(w.bottle_count, w.low_count_threshold, w.critical_count_threshold))));
  cardsEl.innerHTML = categoryCards.join('');

  const needsAttention = [];
  invItemsCache.forEach((i) => {
    const color = invStatusColor(i.percent_remaining, i.low_threshold, i.critical_threshold);
    if (color !== 'ok') needsAttention.push({ itemType: 'item', id: i.id, cat: i.category, name: i.name, location: i.location, valueLabel: i.percent_remaining + '%', color, vendorItemId: i.vendor_item_id, sortValue: i.percent_remaining });
  });
  invWineCache.forEach((w) => {
    const color = invStatusColor(w.bottle_count, w.low_count_threshold, w.critical_count_threshold);
    if (color !== 'ok') needsAttention.push({ itemType: 'wine', id: w.id, cat: 'wine', name: w.label + (w.vintage ? ' (' + w.vintage + ')' : ''), location: w.location, valueLabel: w.bottle_count + ' bottles', color, vendorItemId: w.vendor_item_id, sortValue: w.bottle_count });
  });
  needsAttention.sort((a, b) => (a.color === b.color ? a.sortValue - b.sortValue : (a.color === 'red' ? -1 : 1)));

  const naEl = document.getElementById('inv-dash-needs-attention');
  if (!needsAttention.length) {
    naEl.innerHTML = '<div class="loading">Nothing low right now.</div>';
    return;
  }
  const rows = needsAttention.map((n) => {
    const catLabel = n.cat === 'wine' ? 'Wine' : INV_CATEGORY_LABELS[n.cat];
    return '<tr><td>' + invStatusBadge(n.color) + '</td>'
      + '<td style="font-size:12px;color:var(--sub);">' + escHtml(catLabel) + '</td>'
      + '<td style="font-weight:500;">' + escHtml(n.name) + '</td>'
      + '<td style="font-size:12px;color:var(--sub);">' + escHtml(n.location || '—') + '</td>'
      + '<td>' + escHtml(n.valueLabel) + '</td>'
      + '<td>' + invVendorItemLabel(n.vendorItemId) + '</td>'
      + '<td>' + invOrderCellHtml(n.itemType, n.id, n.color, n.vendorItemId, n.cat) + '</td></tr>';
  }).join('');
  naEl.innerHTML = '<div class="table-wrap"><table><thead><tr><th></th><th>Category</th><th>Item</th><th>Location</th><th>Level</th><th>Vendor / Reorder Info</th><th>Order Status</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
}

function invDashCardHtml(label, colors) {
  const red = colors.filter((c) => c === 'red').length;
  const amber = colors.filter((c) => c === 'amber').length;
  const valueClass = red ? 'red-value' : (amber ? 'amber' : 'teal');
  const valueColor = red ? 'var(--red)' : (amber ? 'var(--amber)' : 'var(--teal)');
  return '<div class="card"><div class="card-title">' + escHtml(label) + '</div>'
    + '<div class="card-value" style="color:' + valueColor + ';">' + (red + amber) + '</div>'
    + '<div class="card-sub">' + red + ' red &middot; ' + amber + ' yellow &middot; ' + colors.length + ' tracked</div></div>';
}

// ── CONSUMABLES / SNACKS / COFFEE / MERCHANDISE (shared template) ──
function ensureCategoryTemplateBuilt(cat) {
  const el = document.getElementById('inventorytab-' + cat);
  if (el.dataset.built) return;
  const label = INV_CATEGORY_LABELS[cat];
  el.innerHTML = '<div class="menu-col-header">'
    + '<div class="section-label" style="margin:0;" id="inv-' + cat + '-form-label">Add ' + label + ' Item</div>'
    + '<button class="btn btn-sm btn-secondary" id="inv-' + cat + '-cancel-edit" style="visibility:hidden;" onclick="cancelItemEdit(\'' + cat + '\')">&#10005; Cancel Edit</button>'
    + '</div>'
    + '<div class="card" style="margin-bottom:20px;">'
    + '<div class="form-row">'
    + '<div class="form-group"><label class="form-label">Name</label><input class="form-input" style="width:100%;" type="text" id="inv-' + cat + '-name"></div>'
    + '<div class="form-group"><label class="form-label">Subcategory</label><input class="form-input" style="width:100%;" type="text" id="inv-' + cat + '-subcategory" placeholder="optional"></div>'
    + '</div>'
    + '<div class="form-row">'
    + '<div class="form-group"><label class="form-label">Location</label><input class="form-input" style="width:100%;" type="text" id="inv-' + cat + '-location" placeholder="optional"></div>'
    + '<div class="form-group"><label class="form-label">% Remaining</label><input class="form-input" style="width:100%;" type="number" min="0" max="100" id="inv-' + cat + '-percent" value="100"></div>'
    + '</div>'
    + '<div class="form-row">'
    + '<div class="form-group"><label class="form-label">Yellow at / below %</label><input class="form-input" style="width:100%;" type="number" min="0" max="100" id="inv-' + cat + '-low" value="50"></div>'
    + '<div class="form-group"><label class="form-label">Red at / below %</label><input class="form-input" style="width:100%;" type="number" min="0" max="100" id="inv-' + cat + '-critical" value="25"></div>'
    + '</div>'
    + '<div class="form-group" style="margin-bottom:16px;"><label class="form-label">Vendor Item (for reorder)</label><select class="form-select" style="width:100%;" id="inv-' + cat + '-vendor-item"><option value="">None linked</option></select></div>'
    + '<div id="inv-' + cat + '-alert" style="display:none;padding:10px 14px;border-radius:6px;font-size:13px;margin-bottom:12px;font-family:\'DM Mono\',monospace;"></div>'
    + '<button class="btn btn-primary" style="width:100%;" id="inv-' + cat + '-save-btn" onclick="saveItem(\'' + cat + '\')">Add Item</button>'
    + '</div>'
    + '<div id="inv-' + cat + '-list"><div class="loading">Loading...</div></div>';
  el.dataset.built = '1';
}

async function loadInventoryCategory(cat) {
  await invEnsureRefData();
  const { data, error } = await window.supabase.from('inventory_items').select('*');
  if (error) { toast(error.message, true); return; }
  invItemsCache = data || [];
  await invLoadOpenOrders();
  document.getElementById('inv-' + cat + '-vendor-item').innerHTML = invVendorItemOptions(null, cat);
  renderItemsTable(cat);
}

function renderItemsTable(cat) {
  const el = document.getElementById('inv-' + cat + '-list');
  const rows = invItemsCache.filter((i) => i.category === cat).sort((a, b) => a.percent_remaining - b.percent_remaining);
  if (!rows.length) { el.innerHTML = '<div class="loading">No items yet — add one above.</div>'; return; }
  const trs = rows.map((i) => {
    const color = invStatusColor(i.percent_remaining, i.low_threshold, i.critical_threshold);
    return '<tr>'
      + '<td style="font-weight:500;">' + escHtml(i.name) + (i.subcategory ? '<div style="font-size:11px;color:var(--sub);">' + escHtml(i.subcategory) + '</div>' : '') + '</td>'
      + '<td style="font-size:12px;color:var(--sub);">' + escHtml(i.location || '—') + '</td>'
      + '<td>' + invStatusBadge(color) + '</td>'
      + '<td><input class="form-input" style="width:64px;padding:6px 8px;" type="number" min="0" max="100" id="inv-pct-' + i.id + '" value="' + i.percent_remaining + '"> <button class="btn btn-sm btn-secondary" onclick="saveItemPercent(\'' + cat + '\',\'' + i.id + '\')">Save</button></td>'
      + '<td>' + invVendorItemLabel(i.vendor_item_id) + '</td>'
      + '<td>' + invOrderCellHtml('item', i.id, color, i.vendor_item_id, cat) + '</td>'
      + '<td><button class="btn btn-sm btn-secondary" onclick="editItem(\'' + cat + '\',\'' + i.id + '\')">Edit</button> <button class="btn btn-sm btn-danger" onclick="deleteItem(\'' + cat + '\',\'' + i.id + '\')">Delete</button></td>'
      + '</tr>';
  }).join('');
  el.innerHTML = '<div class="table-wrap"><table><thead><tr><th>Item</th><th>Location</th><th>Status</th><th>% Remaining</th><th>Vendor / Reorder Info</th><th>Order Status</th><th></th></tr></thead><tbody>' + trs + '</tbody></table></div>';
}

async function saveItemPercent(cat, id) {
  const pct = invClampInt(document.getElementById('inv-pct-' + id).value, 0, 100, 0);
  const { error } = await window.supabase.from('inventory_items')
    .update({ percent_remaining: pct, last_checked_at: new Date().toISOString(), last_checked_by: window.currentStaff.id })
    .eq('id', id);
  if (error) { toast(error.message, true); return; }
  toast('Updated');
  await loadInventoryCategory(cat);
}

async function saveItem(cat) {
  const name = invVal('inv-' + cat + '-name');
  if (!name) { invAlert('inv-' + cat + '-alert', 'Name is required.', true); return; }
  const payload = {
    category: cat,
    subcategory: invVal('inv-' + cat + '-subcategory') || null,
    name,
    location: invVal('inv-' + cat + '-location') || null,
    percent_remaining: invClampInt(invVal('inv-' + cat + '-percent'), 0, 100, 100),
    low_threshold: invClampInt(invVal('inv-' + cat + '-low'), 0, 100, 50),
    critical_threshold: invClampInt(invVal('inv-' + cat + '-critical'), 0, 100, 25),
    vendor_item_id: invVal('inv-' + cat + '-vendor-item') || null,
    last_checked_at: new Date().toISOString(),
    last_checked_by: window.currentStaff.id,
  };
  const editId = invItemEditId[cat];
  const { error } = editId
    ? await window.supabase.from('inventory_items').update(payload).eq('id', editId)
    : await window.supabase.from('inventory_items').insert(payload);
  if (error) { invAlert('inv-' + cat + '-alert', error.message, true); return; }
  toast(editId ? 'Item updated' : 'Item added');
  cancelItemEdit(cat);
  await loadInventoryCategory(cat);
}

function editItem(cat, id) {
  const i = invItemsCache.find((x) => x.id === id);
  if (!i) return;
  invItemEditId[cat] = id;
  invSetVal('inv-' + cat + '-name', i.name);
  invSetVal('inv-' + cat + '-subcategory', i.subcategory || '');
  invSetVal('inv-' + cat + '-location', i.location || '');
  invSetVal('inv-' + cat + '-percent', i.percent_remaining);
  invSetVal('inv-' + cat + '-low', i.low_threshold);
  invSetVal('inv-' + cat + '-critical', i.critical_threshold);
  document.getElementById('inv-' + cat + '-vendor-item').value = i.vendor_item_id || '';
  document.getElementById('inv-' + cat + '-form-label').textContent = 'Edit Item';
  document.getElementById('inv-' + cat + '-cancel-edit').style.visibility = 'visible';
  document.getElementById('inv-' + cat + '-save-btn').textContent = 'Save Changes';
  invClearAlert('inv-' + cat + '-alert');
}

function cancelItemEdit(cat) {
  invItemEditId[cat] = null;
  invSetVal('inv-' + cat + '-name', '');
  invSetVal('inv-' + cat + '-subcategory', '');
  invSetVal('inv-' + cat + '-location', '');
  invSetVal('inv-' + cat + '-percent', 100);
  invSetVal('inv-' + cat + '-low', 50);
  invSetVal('inv-' + cat + '-critical', 25);
  const vSel = document.getElementById('inv-' + cat + '-vendor-item');
  if (vSel) vSel.value = '';
  document.getElementById('inv-' + cat + '-form-label').textContent = 'Add ' + INV_CATEGORY_LABELS[cat] + ' Item';
  document.getElementById('inv-' + cat + '-cancel-edit').style.visibility = 'hidden';
  document.getElementById('inv-' + cat + '-save-btn').textContent = 'Add Item';
  invClearAlert('inv-' + cat + '-alert');
}

async function deleteItem(cat, id) {
  if (!confirm('Remove this item from inventory?')) return;
  const { error } = await window.supabase.from('inventory_items').delete().eq('id', id);
  if (error) { toast(error.message, true); return; }
  toast('Item removed');
  await loadInventoryCategory(cat);
}

// ── WINE ─────────────────────────────────────────
async function loadInventoryWine() {
  await invEnsureRefData();
  const { data, error } = await window.supabase.from('inventory_wine').select('*');
  if (error) { toast(error.message, true); return; }
  invWineCache = data || [];
  await invLoadOpenOrders();
  document.getElementById('inv-wine-vendor-item').innerHTML = invVendorItemOptions(null, 'wine');
  renderWineTable();
}

function renderWineTable() {
  const el = document.getElementById('inv-wine-list');
  const rows = [...invWineCache].sort((a, b) => a.bottle_count - b.bottle_count);
  if (!rows.length) { el.innerHTML = '<div class="loading">No wine tracked yet — add one above.</div>'; return; }
  const trs = rows.map((w) => {
    const color = invStatusColor(w.bottle_count, w.low_count_threshold, w.critical_count_threshold);
    return '<tr>'
      + '<td style="font-weight:500;">' + escHtml(w.label) + (w.vintage ? '<div style="font-size:11px;color:var(--sub);">' + escHtml(w.vintage) + '</div>' : '') + '</td>'
      + '<td style="font-size:12px;color:var(--sub);">' + escHtml(w.location || '—') + '</td>'
      + '<td>' + invStatusBadge(color) + '</td>'
      + '<td><input class="form-input" style="width:64px;padding:6px 8px;" type="number" min="0" id="inv-wine-count-' + w.id + '" value="' + w.bottle_count + '"> <button class="btn btn-sm btn-secondary" onclick="saveWineCount(\'' + w.id + '\')">Save</button></td>'
      + '<td>' + invVendorItemLabel(w.vendor_item_id) + '</td>'
      + '<td>' + invOrderCellHtml('wine', w.id, color, w.vendor_item_id) + '</td>'
      + '<td><button class="btn btn-sm btn-secondary" onclick="editWine(\'' + w.id + '\')">Edit</button> <button class="btn btn-sm btn-danger" onclick="deleteWine(\'' + w.id + '\')">Delete</button></td>'
      + '</tr>';
  }).join('');
  el.innerHTML = '<div class="table-wrap"><table><thead><tr><th>Wine</th><th>Location</th><th>Status</th><th>Bottles</th><th>Vendor / Reorder Info</th><th>Order Status</th><th></th></tr></thead><tbody>' + trs + '</tbody></table></div>';
}

async function saveWineCount(id) {
  const count = invClampInt(document.getElementById('inv-wine-count-' + id).value, 0, 100000, 0);
  const { error } = await window.supabase.from('inventory_wine')
    .update({ bottle_count: count, last_checked_at: new Date().toISOString(), last_checked_by: window.currentStaff.id })
    .eq('id', id);
  if (error) { toast(error.message, true); return; }
  toast('Updated');
  await loadInventoryWine();
}

async function saveWine() {
  const label = invVal('inv-wine-label');
  if (!label) { invAlert('inv-wine-alert', 'Label is required.', true); return; }
  const payload = {
    label,
    vintage: invVal('inv-wine-vintage') || null,
    location: invVal('inv-wine-location') || null,
    bottle_count: invClampInt(invVal('inv-wine-count'), 0, 100000, 0),
    low_count_threshold: invClampInt(invVal('inv-wine-low'), 0, 100000, 6),
    critical_count_threshold: invClampInt(invVal('inv-wine-critical'), 0, 100000, 3),
    vendor_item_id: invVal('inv-wine-vendor-item') || null,
    last_checked_at: new Date().toISOString(),
    last_checked_by: window.currentStaff.id,
  };
  const editId = invWineEditId;
  const { error } = editId
    ? await window.supabase.from('inventory_wine').update(payload).eq('id', editId)
    : await window.supabase.from('inventory_wine').insert(payload);
  if (error) { invAlert('inv-wine-alert', error.message, true); return; }
  toast(editId ? 'Wine updated' : 'Wine added');
  cancelWineEdit();
  await loadInventoryWine();
}

function editWine(id) {
  const w = invWineCache.find((x) => x.id === id);
  if (!w) return;
  invWineEditId = id;
  invSetVal('inv-wine-label', w.label);
  invSetVal('inv-wine-vintage', w.vintage || '');
  invSetVal('inv-wine-location', w.location || '');
  invSetVal('inv-wine-count', w.bottle_count);
  invSetVal('inv-wine-low', w.low_count_threshold);
  invSetVal('inv-wine-critical', w.critical_count_threshold);
  document.getElementById('inv-wine-vendor-item').value = w.vendor_item_id || '';
  document.getElementById('inv-wine-form-label').textContent = 'Edit Wine';
  document.getElementById('inv-wine-cancel-edit').style.visibility = 'visible';
  document.getElementById('inv-wine-save-btn').textContent = 'Save Changes';
}

function cancelWineEdit() {
  invWineEditId = null;
  invSetVal('inv-wine-label', '');
  invSetVal('inv-wine-vintage', '');
  invSetVal('inv-wine-location', '');
  invSetVal('inv-wine-count', 0);
  invSetVal('inv-wine-low', 6);
  invSetVal('inv-wine-critical', 3);
  const vSel = document.getElementById('inv-wine-vendor-item');
  if (vSel) vSel.value = '';
  document.getElementById('inv-wine-form-label').textContent = 'Add Wine';
  document.getElementById('inv-wine-cancel-edit').style.visibility = 'hidden';
  document.getElementById('inv-wine-save-btn').textContent = 'Add Wine';
  invClearAlert('inv-wine-alert');
}

async function deleteWine(id) {
  if (!confirm('Remove this wine from inventory?')) return;
  const { error } = await window.supabase.from('inventory_wine').delete().eq('id', id);
  if (error) { toast(error.message, true); return; }
  toast('Wine removed');
  await loadInventoryWine();
}

// ── VENDORS ──────────────────────────────────────
function invIsAdmin() { return window.currentStaff && window.currentStaff.role === 'admin'; }

async function loadInventoryVendors() {
  await invEnsureRefData(true);
  document.getElementById('inv-vendor-form-card').style.display = invIsAdmin() ? '' : 'none';
  renderVendorsList();
  if (invSelectedVendorId && !invVendorsCache.some((v) => v.id === invSelectedVendorId)) invSelectedVendorId = null;
  renderVendorItemsPanel();
}

function renderVendorsList() {
  const el = document.getElementById('inv-vendors-list');
  if (!invVendorsCache.length) { el.innerHTML = '<div class="loading">No vendors yet' + (invIsAdmin() ? ' — add one above.' : '.') + '</div>'; return; }
  const rows = invVendorsCache.map((v) => {
    const sel = v.id === invSelectedVendorId;
    const itemCount = invVendorItemsCache.filter((vi) => vi.vendor_id === v.id).length;
    return '<tr style="cursor:pointer' + (sel ? ';background:rgba(42,184,166,0.06)' : '') + '" onclick="selectVendor(\'' + v.id + '\')">'
      + '<td style="font-weight:500' + (sel ? ';color:var(--teal)' : '') + '">' + escHtml(v.name) + '</td>'
      + '<td style="font-size:12px;color:var(--sub);">' + escHtml(v.contact_name || '—') + '</td>'
      + '<td style="font-size:12px;color:var(--sub);">' + escHtml(v.phone || v.email || '—') + '</td>'
      + '<td style="font-size:12px;color:var(--sub);">' + itemCount + ' item' + (itemCount === 1 ? '' : 's') + '</td>'
      + (invIsAdmin() ? '<td><button class="btn btn-sm btn-danger" onclick="event.stopPropagation();deleteVendor(\'' + v.id + '\')">Delete</button></td>' : '<td></td>')
      + '</tr>';
  }).join('');
  el.innerHTML = '<div class="table-wrap"><table><thead><tr><th>Vendor</th><th>Contact</th><th>Phone / Email</th><th>Items</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div>';
}

function selectVendor(id) {
  invSelectedVendorId = id;
  renderVendorsList();
  renderVendorItemsPanel();
}

function renderVendorItemsPanel() {
  const titleEl = document.getElementById('inv-vendor-items-title');
  const panelEl = document.getElementById('inv-vendor-items-panel');
  if (!invSelectedVendorId) {
    titleEl.textContent = 'Items & Services';
    panelEl.innerHTML = '<div class="loading">Select a vendor to see what they supply.</div>';
    return;
  }
  const vendor = invVendorsCache.find((v) => v.id === invSelectedVendorId);
  titleEl.textContent = vendor ? vendor.name + ' — Items & Services' : 'Items & Services';
  const items = invVendorItemsCache.filter((vi) => vi.vendor_id === invSelectedVendorId);

  const formHtml = !invIsAdmin() ? '' : (
    '<div class="card" style="margin-bottom:16px;">'
    + '<div class="menu-col-header"><div class="form-label" style="margin:0;" id="inv-vitem-form-label">Add Item / Service</div>'
    + '<button class="btn btn-sm btn-secondary" id="inv-vitem-cancel-edit" style="visibility:hidden;" onclick="cancelVendorItemEdit()">&#10005; Cancel Edit</button></div>'
    + '<div class="form-row">'
    + '<div class="form-group"><label class="form-label">Item / Service Name</label><input class="form-input" style="width:100%;" type="text" id="inv-vitem-name" placeholder="e.g. Paper Towel Case"></div>'
    + '<div class="form-group"><label class="form-label">SKU / Item #</label><input class="form-input" style="width:100%;" type="text" id="inv-vitem-sku" placeholder="optional"></div>'
    + '</div>'
    + '<div class="form-row">'
    + '<div class="form-group"><label class="form-label">Category</label><select class="form-select" style="width:100%;" id="inv-vitem-category">'
    + '<option value="">General / Service</option><option value="consumables">Consumables</option><option value="snacks">Snacks</option><option value="coffee">Coffee</option><option value="wine">Wine</option><option value="merchandise">Merchandise</option></select></div>'
    + '<div class="form-group"><label class="form-label">Unit Cost</label><input class="form-input" style="width:100%;" type="number" step="0.01" min="0" id="inv-vitem-cost" placeholder="optional"></div>'
    + '</div>'
    + '<div class="form-group" style="margin-bottom:16px;"><label class="form-label">Notes</label><input class="form-input" style="width:100%;" type="text" id="inv-vitem-notes" placeholder="optional"></div>'
    + '<button class="btn btn-primary" style="width:100%;" id="inv-vitem-save-btn" onclick="saveVendorItem()">Add Item</button>'
    + '</div>'
  );

  if (!items.length) {
    panelEl.innerHTML = formHtml + '<div class="loading">Nothing on file for this vendor yet.</div>';
    return;
  }
  const rows = items.map((vi) => {
    const catLabel = vi.category ? (INV_CATEGORY_LABELS[vi.category] || 'Wine') : 'General / Service';
    return '<tr>'
      + '<td style="font-weight:500;">' + escHtml(vi.item_name) + '</td>'
      + '<td style="font-size:12px;color:var(--sub);">' + escHtml(vi.sku_or_item_number || '—') + '</td>'
      + '<td style="font-size:12px;color:var(--sub);">' + escHtml(catLabel) + '</td>'
      + '<td style="font-size:12px;color:var(--sub);">' + (vi.unit_cost != null ? '$' + Number(vi.unit_cost).toFixed(2) : '—') + '</td>'
      + (invIsAdmin() ? '<td><button class="btn btn-sm btn-secondary" onclick="editVendorItem(\'' + vi.id + '\')">Edit</button> <button class="btn btn-sm btn-danger" onclick="deleteVendorItem(\'' + vi.id + '\')">Delete</button></td>' : '<td></td>')
      + '</tr>';
  }).join('');
  panelEl.innerHTML = formHtml + '<div class="table-wrap"><table><thead><tr><th>Item / Service</th><th>SKU / #</th><th>Category</th><th>Cost</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div>';
}

async function saveVendor() {
  if (!invIsAdmin()) return;
  const name = invVal('inv-vendor-name');
  if (!name) { invAlert('inv-vendor-alert', 'Vendor name is required.', true); return; }
  const payload = {
    name,
    contact_name: invVal('inv-vendor-contact') || null,
    phone: invVal('inv-vendor-phone') || null,
    email: invVal('inv-vendor-email') || null,
    notes: invVal('inv-vendor-notes') || null,
  };
  const { error } = await window.supabase.from('inventory_vendors').insert(payload);
  if (error) { invAlert('inv-vendor-alert', error.message, true); return; }
  toast('Vendor added');
  invSetVal('inv-vendor-name', '');
  invSetVal('inv-vendor-contact', '');
  invSetVal('inv-vendor-phone', '');
  invSetVal('inv-vendor-email', '');
  invSetVal('inv-vendor-notes', '');
  invClearAlert('inv-vendor-alert');
  await loadInventoryVendors();
}

async function deleteVendor(id) {
  if (!invIsAdmin()) return;
  if (!confirm('Delete this vendor? Any items/services on file for them go too.')) return;
  const { error } = await window.supabase.from('inventory_vendors').delete().eq('id', id);
  if (error) { toast(error.message, true); return; }
  if (invSelectedVendorId === id) invSelectedVendorId = null;
  toast('Vendor deleted');
  await loadInventoryVendors();
}

async function saveVendorItem() {
  if (!invIsAdmin() || !invSelectedVendorId) return;
  const itemName = invVal('inv-vitem-name');
  if (!itemName) { toast('Item name is required.', true); return; }
  const payload = {
    vendor_id: invSelectedVendorId,
    item_name: itemName,
    sku_or_item_number: invVal('inv-vitem-sku') || null,
    category: invVal('inv-vitem-category') || null,
    unit_cost: invVal('inv-vitem-cost') ? parseFloat(invVal('inv-vitem-cost')) : null,
    notes: invVal('inv-vitem-notes') || null,
  };
  const editId = invVendorItemEditId;
  const { error } = editId
    ? await window.supabase.from('inventory_vendor_items').update(payload).eq('id', editId)
    : await window.supabase.from('inventory_vendor_items').insert(payload);
  if (error) { toast(error.message, true); return; }
  toast(editId ? 'Item updated' : 'Item added');
  cancelVendorItemEdit();
  await loadInventoryVendors();
}

function editVendorItem(id) {
  const vi = invVendorItemsCache.find((x) => x.id === id);
  if (!vi) return;
  invVendorItemEditId = id;
  invSetVal('inv-vitem-name', vi.item_name);
  invSetVal('inv-vitem-sku', vi.sku_or_item_number || '');
  invSetVal('inv-vitem-category', vi.category || '');
  invSetVal('inv-vitem-cost', vi.unit_cost != null ? vi.unit_cost : '');
  invSetVal('inv-vitem-notes', vi.notes || '');
  document.getElementById('inv-vitem-form-label').textContent = 'Edit Item / Service';
  document.getElementById('inv-vitem-cancel-edit').style.visibility = 'visible';
  document.getElementById('inv-vitem-save-btn').textContent = 'Save Changes';
}

function cancelVendorItemEdit() {
  invVendorItemEditId = null;
  renderVendorItemsPanel();
}

async function deleteVendorItem(id) {
  if (!invIsAdmin()) return;
  if (!confirm('Remove this item/service from the vendor?')) return;
  const { error } = await window.supabase.from('inventory_vendor_items').delete().eq('id', id);
  if (error) { toast(error.message, true); return; }
  toast('Item removed');
  await loadInventoryVendors();
}
