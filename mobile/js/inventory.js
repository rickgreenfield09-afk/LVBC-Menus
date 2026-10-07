// inventory.js (mobile)
// Screen: #screen-inventory — the walk-around count. Same data as the
// desktop Inventory screen (js/inventory.js, migration_020/022/036):
// each item carries a rough percent remaining, and status color is
// derived from that against the row's own low/critical thresholds.
//
// The list itself is read-only. To change anything you tap Edit on one
// record, which opens it on its own sheet with its photo, and nothing
// is written until Save — so a stray tap while scrolling can't change
// the wrong item. From the phone you can change two things only: the
// count and the location. Names, photos, thresholds, vendors and the
// order log stay on the desktop panel.
//
// Merchandise is the exception to "percent": it's counted in units and
// lives behind the Merch chip, drawn by mobile/js/merch.js into the
// same list area and the same edit sheet.
//
// A saved change goes into a localStorage queue first and syncs from
// there, so a count taken with no signal (walk-in, cellar) isn't lost:
// it sends the next time the phone is online. "Counted today" is
// derived from last_checked_at, never stored separately.
// Depends on: window.supabase, window.currentStaff, toast(),
// escHtml(), toDateStr(), readJson(), writeJson() (core.js)

const M_INV_CATEGORY_LABELS = { consumables: 'Consumables', snacks: 'Snacks', coffee: 'Coffee', wine: 'Wine', merchandise: 'Merchandise' };
const M_INV_ITEMS_KEY = 'lvbc-mobile-inv-items';
const M_INV_QUEUE_KEY = 'lvbc-mobile-inv-queue';
const M_INV_LOCATIONS_KEY = 'lvbc-mobile-inv-locations';
const M_INV_STEP = 5;

let mInvItems = [];
let mInvFilter = 'all';
let mInvFlushTimer = null;
let mInvFlushing = false;
let mLocations = [];
let mItemDraft = null; // { id, pct } while an item's edit sheet is open

// Queue shape: { [itemId]: { pct, location_id, at } } — one pending save per item.
function mInvQueue() { return readJson(M_INV_QUEUE_KEY) || {}; }

async function loadInventoryCount() {
  const [{ data, error }, { data: locs, error: locErr }] = await Promise.all([
    window.supabase.from('inventory_items').select('*'),
    window.supabase.from('inventory_locations').select('*').order('sort_order').order('name'),
  ]);
  if (locErr) mLocations = readJson(M_INV_LOCATIONS_KEY) || [];
  else { mLocations = locs || []; writeJson(M_INV_LOCATIONS_KEY, mLocations); }
  if (error) {
    mInvItems = readJson(M_INV_ITEMS_KEY) || [];
    if (!mInvItems.length && mInvFilter !== 'merch') { renderInvChips(); document.getElementById('m-inv-list').innerHTML = '<div class="loading">Could not load inventory: ' + escHtml(error.message) + '</div>'; return; }
  } else {
    mInvItems = data || [];
    writeJson(M_INV_ITEMS_KEY, mInvItems);
  }
  // Saves still waiting to sync win over whatever the server last had.
  const queue = mInvQueue();
  mInvItems.forEach((i) => { if (queue[i.id]) { i.percent_remaining = queue[i.id].pct; i.location_id = queue[i.id].location_id; i.last_checked_at = queue[i.id].at; } });
  renderInvChips();
  if (mInvFilter === 'merch') loadMerchCount(); else renderInvList();
  mInvFlush();
}

// ── LOCATIONS (shared with merch.js) ─────────────
// "Break room > Rack 1 > Box 2"
function mLocationPath(id) {
  const parts = [];
  for (let l = mLocations.find((x) => x.id === id); l; l = mLocations.find((x) => x.id === l.parent_id)) parts.unshift(l.name);
  return parts.join(' > ');
}

// Every location in tree order, each labelled with its full path.
function mLocationsFlat() {
  const out = [];
  const walk = (parentId) => mLocations.filter((l) => l.parent_id === parentId).forEach((l) => { out.push({ id: l.id, path: mLocationPath(l.id) }); walk(l.id); });
  walk(null);
  return out;
}

// ── EDIT SHEET (shared with merch.js) ────────────
function mPhotoHtml(url, alt, large) {
  const cls = large ? 'm-photo-lg' : 'm-thumb';
  return url
    ? '<img class="' + cls + '" src="' + escHtml(url) + '" alt="' + escHtml(alt || '') + '" loading="lazy">'
    : '<div class="' + cls + ' m-photo-empty">No photo</div>';
}

function mOpenSheet(html) {
  const sheet = document.getElementById('m-sheet');
  sheet.innerHTML = html;
  sheet.style.display = 'flex';
  sheet.scrollTop = 0;
  document.body.style.overflow = 'hidden';
}

function mCloseSheet() {
  mItemDraft = null;
  document.getElementById('m-sheet').style.display = 'none';
  document.body.style.overflow = '';
}

// ── LIST ─────────────────────────────────────────
function mInvStatusColor(i) {
  if (i.percent_remaining <= i.critical_threshold) return 'red';
  if (i.percent_remaining <= i.low_threshold) return 'amber';
  return 'ok';
}

function mInvCountedToday(i) {
  return !!i.last_checked_at && toDateStr(new Date(i.last_checked_at)) === toDateStr(new Date());
}

function setInvFilter(cat) {
  mInvFilter = cat;
  renderInvChips();
  if (cat !== 'merch') { renderInvList(); return; }
  document.getElementById('m-inv-list').innerHTML = '<div class="loading">Loading...</div>';
  loadMerchCount();
}

function renderInvChips() {
  const cats = ['all'].concat(Object.keys(M_INV_CATEGORY_LABELS).filter((c) => mInvItems.some((i) => i.category === c)), ['merch']);
  document.getElementById('m-inv-chips').innerHTML = cats.map((c) =>
    '<div class="badge-pill' + (c === mInvFilter ? ' selected' : '') + '" onclick="setInvFilter(\'' + c + '\')">' + (c === 'all' ? 'All' : c === 'merch' ? 'Merch' : M_INV_CATEGORY_LABELS[c]) + '</div>').join('');
}

function mInvItemLocation(i) { return mLocationPath(i.location_id) || i.location || ''; }

// Grouped by location so the list reads in the order you walk the room.
function renderInvList() {
  const el = document.getElementById('m-inv-list');
  const rows = mInvItems.filter((i) => mInvFilter === 'all' || i.category === mInvFilter)
    .sort((a, b) => (mInvItemLocation(a) || '~').localeCompare(mInvItemLocation(b) || '~') || a.name.localeCompare(b.name));

  document.getElementById('m-inv-progress').textContent = rows.filter(mInvCountedToday).length + ' / ' + rows.length;
  renderInvSyncStatus();
  if (!rows.length) { el.innerHTML = '<div class="loading">No items yet — add them from the staff panel.</div>'; return; }

  let html = '';
  let lastLoc = null;
  rows.forEach((i) => {
    const loc = mInvItemLocation(i) || 'No location set';
    if (loc !== lastLoc) { html += '<div class="m-loc-label">' + escHtml(loc) + '</div>'; lastLoc = loc; }
    const counted = mInvCountedToday(i);
    const sub = [mInvFilter === 'all' ? M_INV_CATEGORY_LABELS[i.category] : null, i.subcategory].filter(Boolean).map(escHtml).join(' &middot; ');
    html += '<div class="m-item m-rec' + (counted ? ' counted' : '') + '">' + mPhotoHtml(i.photo_url, i.name)
      + '<div class="m-rec-body"><div class="m-item-name">' + escHtml(i.name) + '</div>' + (sub ? '<div class="m-item-sub">' + sub + '</div>' : '')
      + '<div class="m-rec-level"><span class="m-pct ' + mInvStatusColor(i) + '">' + i.percent_remaining + '%</span>' + (counted ? '<span class="m-rec-done">&#10003; counted today</span>' : '') + '</div></div>'
      + '<button class="btn btn-sm btn-secondary" onclick="openItemEdit(\'' + i.id + '\')">Edit</button></div>';
  });
  el.innerHTML = html;
}

function renderInvSyncStatus() {
  const pending = Object.keys(mInvQueue()).length + mMerchPending();
  document.getElementById('m-inv-sync').textContent = pending ? pending + ' waiting to sync' : '';
}

// ── EDIT ONE ITEM ────────────────────────────────
function openItemEdit(id) {
  const i = mInvItems.find((x) => x.id === id);
  if (!i) return;
  mOpenSheet('<div class="m-sheet-body">'
    + mPhotoHtml(i.photo_url, i.name, true)
    + '<div class="m-sheet-title">' + escHtml(i.name) + '</div>'
    + '<div class="m-item-sub">' + [M_INV_CATEGORY_LABELS[i.category], i.subcategory, i.location].filter(Boolean).map(escHtml).join(' &middot; ') + '</div>'
    + '<label class="admin-label m-sheet-label">Percent remaining</label>'
    + '<div class="m-item-ctl">'
    + '<button class="m-step" aria-label="Decrease" onclick="stepItemDraft(-' + M_INV_STEP + ')">&minus;</button>'
    + '<div class="m-pct" id="m-item-draft-pct"></div>'
    + '<button class="m-step" aria-label="Increase" onclick="stepItemDraft(' + M_INV_STEP + ')">+</button>'
    + '</div>'
    + '<label class="admin-label m-sheet-label" for="m-item-draft-loc">Location</label>'
    + '<select class="admin-select" id="m-item-draft-loc"><option value="">No location set</option>'
    + mLocationsFlat().map((l) => '<option value="' + l.id + '"' + (l.id === i.location_id ? ' selected' : '') + '>' + escHtml(l.path) + '</option>').join('') + '</select>'
    + '</div><div class="m-sheet-actions"><button class="btn btn-secondary" onclick="mCloseSheet()">Cancel</button><button class="btn btn-primary" onclick="saveItemEdit()">Save</button></div>');
  mItemDraft = { id, pct: i.percent_remaining };
  stepItemDraft(0);
}

function stepItemDraft(delta) {
  const i = mInvItems.find((x) => x.id === mItemDraft.id);
  mItemDraft.pct = Math.min(100, Math.max(0, mItemDraft.pct + delta));
  const el = document.getElementById('m-item-draft-pct');
  el.textContent = mItemDraft.pct + '%';
  el.className = 'm-pct ' + mInvStatusColor(Object.assign({}, i, { percent_remaining: mItemDraft.pct }));
}

// Save always stamps the item as checked, even if the number didn't
// move — opening the record and confirming it is the count.
function saveItemEdit() {
  const item = mInvItems.find((x) => x.id === mItemDraft.id);
  item.percent_remaining = mItemDraft.pct;
  item.location_id = document.getElementById('m-item-draft-loc').value || null;
  item.last_checked_at = new Date().toISOString();

  const queue = mInvQueue();
  queue[item.id] = { pct: item.percent_remaining, location_id: item.location_id, at: item.last_checked_at };
  writeJson(M_INV_QUEUE_KEY, queue);
  writeJson(M_INV_ITEMS_KEY, mInvItems);
  mCloseSheet();
  renderInvList();
  toast('Saved');

  clearTimeout(mInvFlushTimer);
  mInvFlushTimer = setTimeout(mInvFlush, 300);
}

// A failed send stays queued and is retried on the next save, the
// next time this screen opens, or when the phone comes back online.
async function mInvFlush() {
  if (mInvFlushing || !navigator.onLine || !window.currentStaff) return;
  mInvFlushing = true;
  const sending = mInvQueue();
  let failed = false;
  for (const id of Object.keys(sending)) {
    const { error } = await window.supabase.from('inventory_items')
      .update({ percent_remaining: sending[id].pct, location_id: sending[id].location_id, last_checked_at: sending[id].at, last_checked_by: window.currentStaff.id })
      .eq('id', id);
    if (error) { failed = true; continue; }
    // Only clear it if the record wasn't saved again while this was in flight.
    const queue = mInvQueue();
    if (queue[id] && queue[id].at === sending[id].at) { delete queue[id]; writeJson(M_INV_QUEUE_KEY, queue); }
  }
  mInvFlushing = false;
  renderInvSyncStatus();
  if (!failed && Object.keys(mInvQueue()).length) mInvFlush();
}

window.addEventListener('online', mInvFlush);
