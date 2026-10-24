// countsheets.js
// Screen: Inventory > Run Inventory (migration_050). Build a one-off
// count sheet from whole categories and/or hand-picked items and merch,
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
let csSelCats = new Set();
let csSelItems = new Set();
let csSelStyles = new Set();
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
    window.supabase.from('inventory_merch_products').select('id,name').eq('status', 'active'),
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
  document.getElementById('cs-merch-loc').innerHTML = '<option value="">Where it’s stocked now</option>'
    + invLocationsFlat().map((l) => '<option value="' + l.id + '">' + escHtml(l.path) + '</option>').join('');

  renderCsBuilder();
  await loadCsSheets();
}

// ── BUILDER ──────────────────────────────────────
function csMerchStyleLabel(s) {
  const p = csMerch.products.find((x) => x.id === s.product_id);
  const detail = [s.color, s.design].filter(Boolean).join(' · ');
  return (p ? p.name : 'Merch') + (detail ? ' — ' + detail : '');
}

function csMerchStyleList() {
  const live = new Set(csMerch.products.map((p) => p.id));
  return csMerch.styles.filter((s) => live.has(s.product_id)).sort((a, b) => csMerchStyleLabel(a).localeCompare(csMerchStyleLabel(b)));
}

function csToggleCat(cat, on) {
  if (on) csSelCats.add(cat); else csSelCats.delete(cat);
  renderCsBuilder();
}
function csToggleItem(id, on) {
  if (on) csSelItems.add(id); else csSelItems.delete(id);
  renderCsBuilder();
}
function csToggleStyle(id, on) {
  if (on) csSelStyles.add(id); else csSelStyles.delete(id);
  renderCsBuilder();
}
function csSetSearch(v) {
  csSearch = v.trim().toLowerCase();
  renderCsPicker();
}

function renderCsBuilder() {
  const merchStyles = csMerchStyleList();
  const merchSizes = csMerch.variants.filter((v) => merchStyles.some((s) => s.id === v.style_id)).length;
  document.getElementById('cs-categories').innerHTML = CS_PERCENT_CATEGORIES.concat('merchandise').map((cat) => {
    const n = cat === 'merchandise' ? merchStyles.length : csItems.filter((i) => i.category === cat).length;
    const unit = cat === 'merchandise' ? 'style' : 'item';
    return '<label class="cs-check"><input type="checkbox"' + (csSelCats.has(cat) ? ' checked' : '') + ' onchange="csToggleCat(\'' + cat + '\', this.checked)"> '
      + escHtml(INV_CATEGORY_LABELS[cat]) + ' <span class="cs-count">' + n + ' ' + unit + (n === 1 ? '' : 's') + (cat === 'merchandise' ? ', ' + merchSizes + ' sizes' : '') + '</span></label>';
  }).join('');
  renderCsPicker();
  renderCsSummary();
}

function renderCsPicker() {
  const match = (text) => !csSearch || text.toLowerCase().includes(csSearch);
  let html = '';
  CS_PERCENT_CATEGORIES.filter((cat) => !csSelCats.has(cat)).forEach((cat) => {
    const rows = csItems.filter((i) => i.category === cat && match(i.name + ' ' + (i.subcategory || ''))).sort((a, b) => a.name.localeCompare(b.name));
    if (!rows.length) return;
    html += '<div class="cs-pick-head">' + escHtml(INV_CATEGORY_LABELS[cat]) + '</div>'
      + rows.map((i) => '<label class="cs-check"><input type="checkbox"' + (csSelItems.has(i.id) ? ' checked' : '') + ' onchange="csToggleItem(\'' + i.id + '\', this.checked)"> '
        + escHtml(i.name) + (i.subcategory ? ' <span class="cs-count">' + escHtml(i.subcategory) + '</span>' : '') + '</label>').join('');
  });
  if (!csSelCats.has('merchandise')) {
    const rows = csMerchStyleList().filter((s) => match(csMerchStyleLabel(s)));
    if (rows.length) {
      html += '<div class="cs-pick-head">Merchandise</div>'
        + rows.map((s) => '<label class="cs-check"><input type="checkbox"' + (csSelStyles.has(s.id) ? ' checked' : '') + ' onchange="csToggleStyle(\'' + s.id + '\', this.checked)"> '
          + escHtml(csMerchStyleLabel(s)) + '</label>').join('');
    }
  }
  document.getElementById('cs-picker').innerHTML = html || '<div class="loading">' + (csSearch ? 'Nothing matches that.' : 'Every category is already included.') + '</div>';
}

// One line per thing to count, in walking order: by location, then name.
function csBuildLines() {
  const lines = [];
  const seenItems = new Set();
  csItems.filter((i) => csSelCats.has(i.category) || csSelItems.has(i.id)).forEach((i) => {
    if (seenItems.has(i.id)) return;
    seenItems.add(i.id);
    lines.push({
      kind: 'percent', item_id: i.id, label: i.name,
      detail: [i.subcategory, INV_CATEGORY_LABELS[i.category]].filter(Boolean).join(' · '),
      group_label: invLocationPath(i.location_id) || i.location || CS_NO_LOCATION,
      photo_url: i.photo_url, _sort: i.name,
    });
  });

  const overrideLoc = document.getElementById('cs-merch-loc').value || null;
  const styleIds = csSelCats.has('merchandise') ? csMerchStyleList().map((s) => s.id) : [...csSelStyles];
  styleIds.forEach((styleId) => {
    const style = csMerch.styles.find((s) => s.id === styleId);
    if (!style) return;
    // The location override only applies to hand-picked styles, not the whole category.
    const useOverride = overrideLoc && !csSelCats.has('merchandise');
    csMerch.variants.filter((v) => v.style_id === styleId).forEach((v) => {
      const stocked = [...new Set(csMerch.stock.filter((r) => r.variant_id === v.id && r.location_id).map((r) => r.location_id))];
      const locs = useOverride ? [overrideLoc] : (stocked.length ? stocked : [null]);
      locs.forEach((locId) => lines.push({
        kind: 'units', variant_id: v.id, location_id: locId, label: csMerchStyleLabel(style), size: v.size || 'One size',
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
    : 'Nothing selected yet — tick a category or pick items below.';
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
    csSelCats = new Set(); csSelItems = new Set(); csSelStyles = new Set();
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
