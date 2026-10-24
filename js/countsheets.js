// countsheets.js
// Screen: Inventory > Run Inventory (migration_050). Build a one-off
// count sheet with a shopping-cart flow: add whole categories and/or
// hand-picked items and merch sizes to the cart,
// assign it to an employee, and it shows up on their phone
// (mobile/js/countsheets.js) with a push notification. They count every
// line and submit; submit_count_sheet() then applies the counts to live
// inventory in one go, recording what each level was just before.
//
// A sheet is a snapshot: the lines are written when it is built, so
// items added to a category afterwards aren't on it. Merch lines are
// one per size at a location (a style can be counted by color and size).
// Percent items whose wine menu item is archived are left out — they're
// zeroed on purpose.
//
// Open sheets can be reassigned, resent, or cancelled; anything counted
// on a cancelled sheet is never applied.
// Depends on: window.supabase, window.currentStaff, toast(), escHtml()
// (js/menu.js), INV_CATEGORY_LABELS, invLoadWineMenu/invWineMenuStatus
// (inventory.js), invLoadLocations/invLocationPath/invLocationsFlat
// (locations.js)

const CS_PERCENT_CATEGORIES = ['consumables', 'snacks', 'coffee', 'wine'];
const CS_NO_LOCATION = 'No location set';
const CS_STATUS_BADGE = { assigned: ['badge-amber', 'Out for counting'], submitted: ['badge-teal', 'Submitted'], cancelled: ['badge-muted', 'Cancelled'] };

let csStaff = [];
let csItems = [];
let csMerch = { products: [], styles: [], variants: [], stock: [] };
let csSheets = [];
let csProgress = {};            // sheet id -> { total, counted } for sheets still out
let csFilter = 'assigned';      // list filter: assigned | submitted | cancelled | all
let csSearch = '';
let csCart = { cats: new Set(), items: new Set(), merch: [] };  // see the BUILDER section
let csPanel = null;          // category whose add panel is open
let csMerchType = null;      // merch flow: a type, then a style, then its sizes
let csMerchStyleId = null;
let csMerchSizes = new Set();
let csMerchLoc = '';
let csDetailId = null;

async function csAuthHeaders() {
  const { data: { session } } = await window.supabase.auth.getSession();
  return session ? { 'Content-Type': 'application/json', Authorization: 'Bearer ' + session.access_token } : null;
}

function csStaffName(id) {
  const s = csStaff.find((x) => x.id === id);
  return s ? s.name : 'Unassigned';
}

// ── LOAD ─────────────────────────────────────────
async function loadRunInventory() {
  await Promise.all([invLoadLocations(), invLoadWineMenu()]);
  const [staff, items, products, styles, variants, stock] = await Promise.all([
    window.supabase.from('staff_profiles').select('id,name,show_in_roster').order('name'),
    window.supabase.from('inventory_items').select('id,name,category,subcategory,location,location_id,photo_url,wine_menu_id'),
    window.supabase.from('inventory_merch_products').select('id,name,product_type').eq('status', 'active'),
    window.supabase.from('inventory_merch_styles').select('id,product_id,color,design,photo_url').eq('status', 'active'),
    window.supabase.from('inventory_merch_variants').select('id,style_id,size,size_sort').order('size_sort'),
    window.supabase.from('inventory_merch_stock').select('variant_id,location_id'),
  ]);
  csStaff = (staff.data || []).filter((s) => s.show_in_roster !== false);
  csItems = (items.data || []).filter((i) => invWineMenuStatus(i) !== 'archived');
  csMerch = { products: products.data || [], styles: styles.data || [], variants: variants.data || [], stock: stock.data || [] };

  const sel = document.getElementById('cs-assignee');
  const prev = sel.value;
  sel.innerHTML = '<option value="">Choose who counts it</option>' + csStaff.map((s) => '<option value="' + s.id + '">' + escHtml(s.name) + '</option>').join('');
  if (csStaff.some((s) => s.id === prev)) sel.value = prev;
  const titleEl = document.getElementById('cs-title');
  if (!titleEl.value) titleEl.value = 'Inventory count — ' + new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

  renderCsBuilder();
  await loadCsSheets();
}

// ── BUILDER (cart) ───────────────────────────────
// Category buttons open a panel to add items to the cart. Merchandise
// goes type > style > sizes (and where to count them). The cart holds
// whole categories, single items, and merch style/size picks; the sheet
// is built from it when you press Create.
function csMerchStyleLabel(s) {
  const p = csMerch.products.find((x) => x.id === s.product_id);
  const detail = [s.color, s.design].filter(Boolean).join(' · ');
  return (p ? p.name : 'Merch') + (detail ? ' — ' + detail : '');
}

function csMerchStyleList() {
  const live = new Set(csMerch.products.map((p) => p.id));
  return csMerch.styles.filter((s) => live.has(s.product_id)).sort((a, b) => csMerchStyleLabel(a).localeCompare(csMerchStyleLabel(b)));
}
function csMerchTypeOf(style) {
  const p = csMerch.products.find((x) => x.id === style.product_id);
  return p ? p.product_type : 'other';
}
function csMerchVariantsOf(styleId) { return csMerch.variants.filter((v) => v.style_id === styleId); }
function csSizeLabel(v) { return v.size || 'One size'; }
function csMerchKey(styleId, locId) { return styleId + '|' + (locId || ''); }
function csMerchEntry(styleId, locId) { return csCart.merch.find((e) => e.key === csMerchKey(styleId, locId)); }

function csResetCart() {
  csCart = { cats: new Set(), items: new Set(), merch: [] };
  csPanel = null; csMerchType = null; csMerchStyleId = null; csMerchSizes = new Set(); csMerchLoc = ''; csSearch = '';
}
function csClearCart() { csResetCart(); renderCsBuilder(); }

function renderCsBuilder() {
  renderCsCatButtons();
  renderCsPanel();
  renderCsCart();
  renderCsSummary();
}

// What's in the cart for a category, as a short badge: "All" or a count.
function csCartBadge(cat) {
  if (csCart.cats.has(cat)) return 'All';
  if (cat === 'merchandise') return csCart.merch.length || '';
  return csItems.filter((i) => i.category === cat && csCart.items.has(i.id)).length || '';
}

function renderCsCatButtons() {
  document.getElementById('cs-cat-btns').innerHTML = CS_PERCENT_CATEGORIES.concat('merchandise').map((cat) => {
    const n = csCartBadge(cat);
    return '<button class="tap-toggle-btn' + (csPanel === cat ? ' active' : '') + '" onclick="csTogglePanel(\'' + cat + '\')">'
      + escHtml(INV_CATEGORY_LABELS[cat]) + (n ? ' <span class="cs-badge">' + n + '</span>' : '') + '</button>';
  }).join('');
}

function csTogglePanel(cat) {
  csPanel = csPanel === cat ? null : cat;
  csSearch = ''; csMerchType = null; csMerchStyleId = null;
  renderCsBuilder();
}

function renderCsPanel() {
  const el = document.getElementById('cs-panel');
  if (!csPanel) { el.innerHTML = ''; return; }
  if (csPanel === 'merchandise') { el.innerHTML = csMerchPanelHtml(); return; }
  const cat = csPanel;
  const label = INV_CATEGORY_LABELS[cat];
  const count = csItems.filter((i) => i.category === cat).length;
  const whole = csCart.cats.has(cat);
  el.innerHTML = '<div class="cs-panel"><div class="cs-panel-head"><div><strong>' + escHtml(label) + '</strong> <span class="cs-count">' + count + ' item' + (count === 1 ? '' : 's') + '</span></div>'
    + (whole ? '<button class="btn btn-sm btn-secondary" onclick="csRemoveCat(\'' + cat + '\')">Remove whole category</button>'
      : '<button class="btn btn-sm btn-primary"' + (count ? '' : ' disabled') + ' onclick="csAddCat(\'' + cat + '\')">Add all ' + count + '</button>') + '</div>'
    + '<input class="form-input" style="width:100%;margin-bottom:8px;" type="text" id="cs-search" placeholder="Search ' + escHtml(label.toLowerCase()) + '" value="' + escHtml(csSearch) + '" oninput="csSetSearch(this.value)">'
    + '<div class="cs-list" id="cs-items-list"></div></div>';
  renderCsItemList();
}

function csSetSearch(v) {
  csSearch = v.trim().toLowerCase();
  renderCsItemList();
}

function renderCsItemList() {
  const el = document.getElementById('cs-items-list');
  if (!el || !csPanel || csPanel === 'merchandise') return;
  const top = el.scrollTop;
  const whole = csCart.cats.has(csPanel);
  const rows = csItems.filter((i) => i.category === csPanel && (!csSearch || (i.name + ' ' + (i.subcategory || '')).toLowerCase().includes(csSearch)))
    .sort((a, b) => a.name.localeCompare(b.name));
  el.innerHTML = rows.length ? rows.map((i) => {
    const added = csCart.items.has(i.id);
    const btn = whole ? '<span class="cs-count">In cart</span>'
      : '<button class="btn btn-sm ' + (added ? 'btn-secondary' : 'btn-primary') + '" onclick="csToggleItem(\'' + i.id + '\')">' + (added ? '&#10003; Added' : '+ Add') + '</button>';
    return '<div class="cs-row"><div class="cs-row-name">' + escHtml(i.name) + (i.subcategory ? ' <span class="cs-count">' + escHtml(i.subcategory) + '</span>' : '') + '</div>' + btn + '</div>';
  }).join('') : '<div class="loading">' + (csSearch ? 'Nothing matches that.' : 'No items yet.') + '</div>';
  el.scrollTop = top;
}

function csToggleItem(id) {
  if (csCart.items.has(id)) csCart.items.delete(id); else csCart.items.add(id);
  renderCsItemList();
  renderCsCatButtons();
  renderCsCart();
  renderCsSummary();
}

function csAddCat(cat) {
  csCart.cats.add(cat);
  if (cat === 'merchandise') csCart.merch = [];
  else csItems.filter((i) => i.category === cat).forEach((i) => csCart.items.delete(i.id));
  renderCsBuilder();
}
function csRemoveCat(cat) {
  csCart.cats.delete(cat);
  renderCsBuilder();
}

// ── merchandise: type > style > sizes ──
function csMerchPanelHtml() {
  const styles = csMerchStyleList();
  const sizeTotal = csMerch.variants.filter((v) => styles.some((s) => s.id === v.style_id)).length;
  const whole = csCart.cats.has('merchandise');
  let html = '<div class="cs-panel"><div class="cs-panel-head"><div><strong>Merchandise</strong> <span class="cs-count">' + styles.length + ' styles, ' + sizeTotal + ' sizes</span></div>'
    + (whole ? '<button class="btn btn-sm btn-secondary" onclick="csRemoveCat(\'merchandise\')">Remove all merchandise</button>'
      : '<button class="btn btn-sm btn-primary"' + (styles.length ? '' : ' disabled') + ' onclick="csAddCat(\'merchandise\')">Add all merchandise</button>') + '</div>';
  if (whole) return html + '<div class="cs-note">Every style and size is in the cart.</div></div>';

  if (!csMerchType) {
    const types = Object.keys(MERCH_TYPE_LABELS).filter((t) => styles.some((s) => csMerchTypeOf(s) === t));
    html += '<div class="cs-step">1 &middot; Choose a type</div>' + (types.length ? types.map((t) => {
      const ts = styles.filter((s) => csMerchTypeOf(s) === t);
      return '<div class="cs-row"><div class="cs-row-name">' + escHtml(MERCH_TYPE_LABELS[t]) + ' <span class="cs-count">' + ts.length + ' style' + (ts.length === 1 ? '' : 's') + '</span></div>'
        + '<div style="display:flex;gap:6px;"><button class="btn btn-sm btn-secondary" onclick="csAddMerchType(\'' + t + '\')">Add all</button>'
        + '<button class="btn btn-sm btn-primary" onclick="csPickMerchType(\'' + t + '\')">Choose &rsaquo;</button></div></div>';
    }).join('') : '<div class="loading">No merchandise yet.</div>');
    return html + '</div>';
  }

  if (!csMerchStyleId) {
    const ts = styles.filter((s) => csMerchTypeOf(s) === csMerchType);
    html += '<div class="cs-crumbs"><button class="merch-link" onclick="csMerchBack()">&lsaquo; Types</button> / ' + escHtml(MERCH_TYPE_LABELS[csMerchType] || csMerchType) + '</div>'
      + '<div class="cs-step">2 &middot; Choose a style</div>' + ts.map((s) => {
        const inCart = csCart.merch.filter((e) => e.styleId === s.id);
        return '<div class="cs-row"><div class="cs-row-name">' + escHtml(csMerchStyleLabel(s))
          + (inCart.length ? ' <span class="cs-count">in cart</span>' : '') + '</div>'
          + '<button class="btn btn-sm btn-primary" onclick="csPickMerchStyle(\'' + s.id + '\')">Sizes &rsaquo;</button></div>';
      }).join('');
    return html + '</div>';
  }

  const style = csMerch.styles.find((s) => s.id === csMerchStyleId);
  const variants = csMerchVariantsOf(csMerchStyleId);
  const existing = csMerchEntry(csMerchStyleId, csMerchLoc);
  html += '<div class="cs-crumbs"><button class="merch-link" onclick="csMerchBack()">&lsaquo; ' + escHtml(MERCH_TYPE_LABELS[csMerchType] || 'Back') + '</button> / ' + escHtml(csMerchStyleLabel(style)) + '</div>'
    + '<div class="cs-step">3 &middot; Choose the sizes to count</div>'
    + '<div class="cs-chips">' + variants.map((v) => '<button class="cs-chip' + (csMerchSizes.has(v.id) ? ' on' : '') + '" onclick="csToggleSize(\'' + v.id + '\')">' + escHtml(csSizeLabel(v)) + '</button>').join('') + '</div>'
    + '<div style="display:flex;gap:14px;margin:8px 0 12px;"><button class="merch-link" onclick="csSelectSizes(true)">all sizes</button><button class="merch-link" onclick="csSelectSizes(false)">none</button></div>'
    + '<div class="form-group" style="margin-bottom:12px;"><label class="form-label">Count at</label><select class="form-select" style="width:100%;" onchange="csSetMerchLoc(this.value)">'
    + '<option value="">Where it’s stocked now</option>'
    + invLocationsFlat().map((l) => '<option value="' + l.id + '"' + (l.id === csMerchLoc ? ' selected' : '') + '>' + escHtml(l.path) + '</option>').join('') + '</select></div>'
    + '<button class="btn btn-primary" style="width:100%;"' + (csMerchSizes.size ? '' : ' disabled') + ' onclick="csAddMerchStyle()">'
    + (existing ? 'Update cart' : 'Add ' + csMerchSizes.size + ' size' + (csMerchSizes.size === 1 ? '' : 's') + ' to cart') + '</button></div>';
  return html;
}

function csPickMerchType(t) { csMerchType = t; csMerchStyleId = null; renderCsPanel(); }
function csPickMerchStyle(id) {
  csMerchStyleId = id;
  csMerchLoc = '';
  const existing = csMerchEntry(id, '');
  csMerchSizes = new Set(existing ? existing.variantIds : csMerchVariantsOf(id).map((v) => v.id));
  renderCsPanel();
}
function csMerchBack() {
  if (csMerchStyleId) csMerchStyleId = null; else csMerchType = null;
  renderCsPanel();
}
function csToggleSize(id) {
  if (csMerchSizes.has(id)) csMerchSizes.delete(id); else csMerchSizes.add(id);
  renderCsPanel();
}
function csSelectSizes(all) {
  csMerchSizes = new Set(all ? csMerchVariantsOf(csMerchStyleId).map((v) => v.id) : []);
  renderCsPanel();
}
function csSetMerchLoc(v) {
  csMerchLoc = v;
  const existing = csMerchEntry(csMerchStyleId, v);
  if (existing) csMerchSizes = new Set(existing.variantIds);
  renderCsPanel();
}

function csSetMerchEntry(styleId, locId, variantIds) {
  const existing = csMerchEntry(styleId, locId);
  if (existing) existing.variantIds = new Set(variantIds);
  else csCart.merch.push({ key: csMerchKey(styleId, locId), styleId, locId: locId || '', variantIds: new Set(variantIds) });
}
function csAddMerchStyle() {
  if (!csMerchSizes.size) return;
  csSetMerchEntry(csMerchStyleId, csMerchLoc, csMerchSizes);
  csMerchStyleId = null;
  renderCsBuilder();
  toast('Added to cart');
}
function csAddMerchType(t) {
  csMerchStyleList().filter((s) => csMerchTypeOf(s) === t).forEach((s) => csSetMerchEntry(s.id, '', csMerchVariantsOf(s.id).map((v) => v.id)));
  renderCsBuilder();
  toast('Added every ' + (MERCH_TYPE_LABELS[t] || t).toLowerCase() + ' style to the cart');
}
function csRemoveMerchEntry(key) {
  csCart.merch = csCart.merch.filter((e) => e.key !== key);
  renderCsBuilder();
}

// ── the cart ──
function renderCsCart() {
  let rows = '';
  const x = (onclick) => '<button class="cs-x" aria-label="Remove" onclick="' + onclick + '">&times;</button>';

  [...csCart.cats].forEach((cat) => {
    const merch = cat === 'merchandise';
    const n = merch ? csMerch.variants.filter((v) => csMerchStyleList().some((s) => s.id === v.style_id)).length : csItems.filter((i) => i.category === cat).length;
    rows += '<div class="cs-cart-row"><div><strong>' + escHtml(INV_CATEGORY_LABELS[cat]) + '</strong> <span class="cs-count">everything &middot; ' + n + (merch ? ' sizes' : ' items') + '</span></div>' + x('csRemoveCat(\'' + cat + '\')') + '</div>';
  });
  csItems.filter((i) => csCart.items.has(i.id)).sort((a, b) => a.name.localeCompare(b.name)).forEach((i) => {
    rows += '<div class="cs-cart-row"><div>' + escHtml(i.name) + ' <span class="cs-count">' + escHtml(INV_CATEGORY_LABELS[i.category]) + '</span></div>' + x('csToggleItem(\'' + i.id + '\')') + '</div>';
  });
  csCart.merch.forEach((e) => {
    const style = csMerch.styles.find((s) => s.id === e.styleId);
    if (!style) return;
    const all = csMerchVariantsOf(e.styleId);
    const picked = all.filter((v) => e.variantIds.has(v.id));
    const sizes = picked.length === all.length ? 'all sizes' : picked.map(csSizeLabel).join(', ');
    rows += '<div class="cs-cart-row"><div>' + escHtml(csMerchStyleLabel(style)) + '<div class="cs-count">' + escHtml(sizes) + ' &middot; ' + (e.locId ? escHtml(invLocationPath(e.locId)) : 'where it’s stocked now') + '</div></div>'
      + x('csRemoveMerchEntry(\'' + e.key + '\')') + '</div>';
  });
  document.getElementById('cs-cart').innerHTML = rows
    ? '<div class="cs-cart-scroll">' + rows + '</div>'
    : '<div class="cs-empty">Your cart is empty. Pick a category above and add what you want counted.</div>';
}

// One line per thing to count, in walking order: by location, then name.
function csBuildLines() {
  const lines = [];
  const seen = new Set();
  const add = (key, line) => { if (!seen.has(key)) { seen.add(key); lines.push(line); } };

  csItems.filter((i) => csCart.cats.has(i.category) || csCart.items.has(i.id)).forEach((i) => add('p|' + i.id, {
    kind: 'percent', item_id: i.id, label: i.name,
    detail: [i.subcategory, INV_CATEGORY_LABELS[i.category]].filter(Boolean).join(' · '),
    group_label: invLocationPath(i.location_id) || i.location || CS_NO_LOCATION,
    photo_url: i.photo_url, _sort: i.name,
  }));

  const entries = csCart.cats.has('merchandise')
    ? csMerchStyleList().map((s) => ({ styleId: s.id, locId: '', variantIds: null }))
    : csCart.merch;
  entries.forEach((e) => {
    const style = csMerch.styles.find((s) => s.id === e.styleId);
    if (!style) return;
    csMerchVariantsOf(e.styleId).filter((v) => !e.variantIds || e.variantIds.has(v.id)).forEach((v) => {
      const stocked = [...new Set(csMerch.stock.filter((r) => r.variant_id === v.id && r.location_id).map((r) => r.location_id))];
      const locs = e.locId ? [e.locId] : (stocked.length ? stocked : [null]);
      locs.forEach((locId) => add('u|' + v.id + '|' + (locId || ''), {
        kind: 'units', variant_id: v.id, location_id: locId, label: csMerchStyleLabel(style), size: csSizeLabel(v),
        detail: null, group_label: (locId && invLocationPath(locId)) || CS_NO_LOCATION, photo_url: style.photo_url,
        _sort: csMerchStyleLabel(style) + '\u0000' + String(v.size_sort).padStart(4, '0'),
      }));
    });
  });

  lines.sort((a, b) => {
    const an = a.group_label === CS_NO_LOCATION, bn = b.group_label === CS_NO_LOCATION;
    return (an - bn) || a.group_label.localeCompare(b.group_label) || a._sort.localeCompare(b._sort);
  });
  return lines.map((l, idx) => { const { _sort, ...rest } = l; return Object.assign(rest, { sort_order: idx }); });
}

function renderCsSummary() {
  const lines = csBuildLines();
  const items = lines.filter((l) => l.kind === 'percent').length;
  const sizes = lines.filter((l) => l.kind === 'units').length;
  document.getElementById('cs-summary').textContent = lines.length
    ? lines.length + ' line' + (lines.length === 1 ? '' : 's') + ' to count' + (items && sizes ? ' (' + items + ' items, ' + sizes + ' merch sizes)' : '')
    : 'Nothing in the cart yet.';
}

function csAlert(msg, isError) {
  const el = document.getElementById('cs-alert');
  el.style.display = msg ? 'block' : 'none';
  el.style.background = isError ? 'rgba(220,53,69,0.1)' : 'rgba(42,184,166,0.1)';
  el.style.color = isError ? 'var(--red)' : 'var(--teal)';
  el.textContent = msg || '';
}

async function csCreateSheet() {
  const title = document.getElementById('cs-title').value.trim();
  const assignee = document.getElementById('cs-assignee').value;
  if (!title) { csAlert('Give the sheet a name.', true); return; }
  if (!assignee) { csAlert('Choose who is counting it.', true); return; }
  const lines = csBuildLines();
  if (!lines.length) { csAlert('Add at least one category or item.', true); return; }

  const btn = document.getElementById('cs-create-btn');
  btn.disabled = true;
  csAlert('');
  try {
    const { data: sheet, error } = await window.supabase.from('inventory_count_sheets')
      .insert({ title, notes: document.getElementById('cs-notes').value.trim() || null, assigned_to: assignee, created_by: window.currentStaff.id })
      .select().single();
    if (error) throw error;
    for (let i = 0; i < lines.length; i += 200) {
      const { error: lineErr } = await window.supabase.from('inventory_count_sheet_lines')
        .insert(lines.slice(i, i + 200).map((l) => Object.assign({ sheet_id: sheet.id }, l)));
      if (lineErr) {
        await window.supabase.from('inventory_count_sheets').delete().eq('id', sheet.id);
        throw lineErr;
      }
    }
    csResetCart();
    document.getElementById('cs-notes').value = '';
    document.getElementById('cs-title').value = 'Inventory count — ' + new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    renderCsBuilder();
    await csNotify(sheet.id, assignee);
    csFilter = 'assigned';
    await loadCsSheets();
  } catch (e) {
    csAlert('Could not create the sheet: ' + e.message, true);
  } finally {
    btn.disabled = false;
  }
}

// The sheet is already saved by now, so a notification problem is only a heads-up.
async function csNotify(sheetId, staffId) {
  const name = csStaffName(staffId);
  try {
    const headers = await csAuthHeaders();
    if (!headers) throw new Error('Session expired — sign in again.');
    const res = await fetch('/api/notify-count-sheet', { method: 'POST', headers, body: JSON.stringify({ sheet_id: sheetId }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Notification failed');
    if (data.sent > 0) toast('Sent to ' + name + '’s phone');
    else toast('Assigned to ' + name + ' — they haven’t turned on notifications, so they’ll see it next time they open the app.');
  } catch (e) {
    toast('Assigned to ' + name + ', but the notification didn’t go out: ' + e.message, true);
  }
}

// ── SHEET LIST ───────────────────────────────────
async function loadCsSheets() {
  const el = document.getElementById('cs-list');
  const { data, error } = await window.supabase.from('inventory_count_sheets').select('*').order('created_at', { ascending: false });
  if (error) { el.innerHTML = '<div class="loading">Could not load count sheets: ' + escHtml(error.message) + '</div>'; return; }
  csSheets = data || [];
  csProgress = {};
  const openIds = csSheets.filter((s) => s.status === 'assigned').map((s) => s.id);
  if (openIds.length) {
    const { data: lines } = await window.supabase.from('inventory_count_sheet_lines').select('sheet_id,counted_value').in('sheet_id', openIds);
    (lines || []).forEach((l) => {
      const p = csProgress[l.sheet_id] || (csProgress[l.sheet_id] = { total: 0, counted: 0 });
      p.total++;
      if (l.counted_value !== null) p.counted++;
    });
  }
  renderCsList();
}

function setCsFilter(f) {
  csFilter = f;
  renderCsList();
}

function renderCsList() {
  const el = document.getElementById('cs-list');
  ['assigned', 'submitted', 'cancelled', 'all'].forEach((f) => {
    const b = document.getElementById('cs-filter-' + f);
    if (b) b.classList.toggle('active', f === csFilter);
  });
  const rows = csSheets.filter((s) => csFilter === 'all' || s.status === csFilter);
  if (!rows.length) {
    el.innerHTML = '<div class="loading">' + (csFilter === 'assigned' ? 'No sheets out for counting right now.' : 'Nothing here yet.') + '</div>';
    return;
  }
  const trs = rows.map((s) => {
    const [cls, label] = CS_STATUS_BADGE[s.status];
    const p = csProgress[s.id];
    const when = s.status === 'submitted' && s.submitted_at ? 'Submitted ' + csShortDate(s.submitted_at) : 'Sent ' + csShortDate(s.assigned_at || s.created_at);
    return '<tr style="cursor:pointer;" onclick="openCsDetail(\'' + s.id + '\')">'
      + '<td style="font-weight:500;">' + escHtml(s.title) + '<div style="font-size:11px;color:var(--sub);">' + escHtml(when) + '</div></td>'
      + '<td style="font-size:12px;color:var(--sub);">' + escHtml(csStaffName(s.assigned_to)) + '</td>'
      + '<td style="font-family:\'DM Mono\',monospace;font-size:12px;white-space:nowrap;">' + (p ? p.counted + ' / ' + p.total : '—') + '</td>'
      + '<td><span class="badge ' + cls + '">' + label + '</span></td></tr>';
  }).join('');
  el.innerHTML = '<div class="table-wrap"><table><thead><tr><th>Sheet</th><th>Counting</th><th>Counted</th><th>Status</th></tr></thead><tbody>' + trs + '</tbody></table></div>';
}

function csShortDate(ts) {
  return new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

// ── DETAIL ───────────────────────────────────────
async function openCsDetail(id) {
  csDetailId = id;
  document.getElementById('cs-detail-modal').style.display = 'flex';
  document.getElementById('cs-detail-body').innerHTML = '<div class="loading">Loading...</div>';
  await renderCsDetail();
}

function closeCsDetail() {
  csDetailId = null;
  document.getElementById('cs-detail-modal').style.display = 'none';
}

async function renderCsDetail() {
  const s = csSheets.find((x) => x.id === csDetailId);
  if (!s) return;
  const { data: lines, error } = await window.supabase.from('inventory_count_sheet_lines').select('*').eq('sheet_id', s.id).order('sort_order');
  if (error) { document.getElementById('cs-detail-body').innerHTML = '<div class="loading">Error: ' + escHtml(error.message) + '</div>'; return; }
  if (csDetailId !== s.id) return;

  const [cls, label] = CS_STATUS_BADGE[s.status];
  const counted = lines.filter((l) => l.counted_value !== null).length;
  const unit = (l, v) => (v === null || v === undefined ? '—' : l.kind === 'percent' ? v + '%' : String(v));

  let body = '<div style="margin-bottom:14px;"><span class="badge ' + cls + '">' + label + '</span> '
    + '<span style="font-size:12px;color:var(--sub);">' + escHtml(csStaffName(s.assigned_to)) + ' · sent ' + escHtml(csShortDate(s.assigned_at || s.created_at))
    + (s.submitted_at ? ' · submitted ' + escHtml(csShortDate(s.submitted_at)) : '') + '</span></div>'
    + (s.notes ? '<div class="card" style="margin-bottom:14px;font-size:13px;color:var(--sub);">' + escHtml(s.notes) + '</div>' : '')
    + '<div style="font-size:12px;color:var(--sub);margin-bottom:10px;">' + counted + ' of ' + lines.length + ' counted'
    + (s.status === 'submitted' ? ' — counted lines were applied to inventory.' : s.status === 'cancelled' ? ' — nothing was applied.' : '') + '</div>';

  if (s.status === 'assigned') {
    body += '<div class="card" style="margin-bottom:16px;"><div class="form-row" style="grid-template-columns:2fr 1fr 1fr;align-items:end;margin-bottom:0;">'
      + '<div class="form-group"><label class="form-label">Reassign to</label><select class="form-select" style="width:100%;" id="cs-reassign">'
      + csStaff.map((x) => '<option value="' + x.id + '"' + (x.id === s.assigned_to ? ' selected' : '') + '>' + escHtml(x.name) + '</option>').join('') + '</select></div>'
      + '<button class="btn btn-secondary" onclick="csReassign()">Reassign</button>'
      + '<button class="btn btn-secondary" onclick="csResend()">Resend Push</button></div></div>';
  }

  let trs = '';
  let lastGroup = null;
  lines.forEach((l) => {
    if (l.group_label !== lastGroup) { trs += '<tr><td colspan="3" class="cs-group-row">' + escHtml(l.group_label) + '</td></tr>'; lastGroup = l.group_label; }
    let result;
    if (l.counted_value === null) result = '<span style="color:var(--muted);">' + (s.status === 'assigned' ? 'Not counted yet' : 'Not counted') + '</span>';
    else if (s.status === 'submitted' && l.before_value !== null) {
      const d = l.counted_value - l.before_value;
      result = escHtml(unit(l, l.before_value)) + ' &rarr; <strong>' + escHtml(unit(l, l.counted_value)) + '</strong> '
        + (d === 0 ? '<span style="color:var(--muted);">no change</span>' : '<span style="color:' + (d > 0 ? 'var(--teal)' : 'var(--red)') + ';">' + (d > 0 ? '+' : '') + d + (l.kind === 'percent' ? ' pts' : '') + '</span>');
    } else result = '<strong>' + escHtml(unit(l, l.counted_value)) + '</strong>';
    trs += '<tr><td style="font-weight:500;">' + escHtml(l.label) + (l.size ? ' <span style="color:var(--sub);font-weight:400;">' + escHtml(l.size) + '</span>' : '')
      + (l.detail ? '<div style="font-size:11px;color:var(--sub);">' + escHtml(l.detail) + '</div>' : '') + '</td>'
      + '<td>' + (l.kind === 'percent' ? '<span style="font-size:11px;color:var(--muted);">%</span>' : '<span style="font-size:11px;color:var(--muted);">units</span>') + '</td>'
      + '<td style="font-size:13px;">' + result + '</td></tr>';
  });
  body += '<div class="table-wrap" style="max-height:48vh;overflow-y:auto;"><table><thead><tr><th>Line</th><th></th><th>' + (s.status === 'submitted' ? 'Before → Counted' : 'Counted') + '</th></tr></thead><tbody>' + trs + '</tbody></table></div>';

  const actions = s.status === 'assigned'
    ? '<button class="btn btn-danger" onclick="csCancelSheet()">Cancel This Sheet</button>'
    : s.status === 'cancelled' ? '<button class="btn btn-danger" onclick="csDeleteSheet()">Delete</button>' : '';
  body += actions ? '<div style="margin-top:16px;display:flex;gap:10px;">' + actions + '</div>' : '';

  document.getElementById('cs-detail-title').textContent = s.title;
  document.getElementById('cs-detail-body').innerHTML = body;
}

async function csReassign() {
  const s = csSheets.find((x) => x.id === csDetailId);
  const to = document.getElementById('cs-reassign').value;
  if (!s || !to) return;
  if (to === s.assigned_to) { toast('Already assigned to ' + csStaffName(to)); return; }
  const { error } = await window.supabase.from('inventory_count_sheets').update({ assigned_to: to, assigned_at: new Date().toISOString() }).eq('id', s.id);
  if (error) { toast(error.message, true); return; }
  await csNotify(s.id, to);
  await loadCsSheets();
  await renderCsDetail();
}

async function csResend() {
  const s = csSheets.find((x) => x.id === csDetailId);
  if (s) await csNotify(s.id, s.assigned_to);
}

async function csCancelSheet() {
  const s = csSheets.find((x) => x.id === csDetailId);
  if (!s || !confirm('Cancel "' + s.title + '"? Anything already counted on it will not be applied to inventory.')) return;
  const { error } = await window.supabase.from('inventory_count_sheets').update({ status: 'cancelled' }).eq('id', s.id).eq('status', 'assigned');
  if (error) { toast(error.message, true); return; }
  toast('Sheet cancelled');
  await loadCsSheets();
  await renderCsDetail();
}

async function csDeleteSheet() {
  const s = csSheets.find((x) => x.id === csDetailId);
  if (!s || !confirm('Delete "' + s.title + '" for good?')) return;
  const { error } = await window.supabase.from('inventory_count_sheets').delete().eq('id', s.id);
  if (error) { toast(error.message, true); return; }
  toast('Sheet deleted');
  closeCsDetail();
  await loadCsSheets();
}
