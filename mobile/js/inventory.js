// inventory.js (mobile)
// Screen: #screen-inventory — the walk-around count. Same data as the
// desktop Inventory screen (js/inventory.js, migration_020/022): each
// item carries a rough percent remaining, and status colour is derived
// from that against the row's own low/critical thresholds.
//
// Adding/editing items, vendors and the order log stay on the desktop
// panel — this screen only records levels.
//
// Every change is written to a localStorage queue first and synced
// from there, so a count taken with no signal (walk-in, cellar) isn't
// lost: it sends the next time the phone is online. "Counted today"
// is derived from last_checked_at, never stored separately.
// Depends on: window.supabase, window.currentStaff, toast(),
// escHtml(), toDateStr(), readJson(), writeJson() (core.js)

const M_INV_CATEGORY_LABELS = { consumables: 'Consumables', snacks: 'Snacks', coffee: 'Coffee', wine: 'Wine', merchandise: 'Merchandise' };
const M_INV_ITEMS_KEY = 'lvbc-mobile-inv-items';
const M_INV_QUEUE_KEY = 'lvbc-mobile-inv-queue';
const M_INV_STEP = 5;

let mInvItems = [];
let mInvFilter = 'all';
let mInvFlushTimer = null;
let mInvFlushing = false;

// Queue shape: { [itemId]: { pct, at } } — one pending level per item,
// so tapping + five times sends one update, not five.
function mInvQueue() { return readJson(M_INV_QUEUE_KEY) || {}; }

async function loadInventoryCount() {
  const { data, error } = await window.supabase.from('inventory_items').select('*');
  if (error) {
    mInvItems = readJson(M_INV_ITEMS_KEY) || [];
    if (!mInvItems.length) { document.getElementById('m-inv-list').innerHTML = '<div class="loading">Could not load inventory: ' + escHtml(error.message) + '</div>'; return; }
  } else {
    mInvItems = data || [];
    writeJson(M_INV_ITEMS_KEY, mInvItems);
  }
  // Counts still waiting to sync win over whatever the server last had.
  const queue = mInvQueue();
  mInvItems.forEach((i) => { if (queue[i.id]) { i.percent_remaining = queue[i.id].pct; i.last_checked_at = queue[i.id].at; } });
  renderInvChips();
  renderInvList();
  mInvFlush();
}

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
  renderInvList();
}

function renderInvChips() {
  const cats = ['all'].concat(Object.keys(M_INV_CATEGORY_LABELS).filter((c) => mInvItems.some((i) => i.category === c)));
  document.getElementById('m-inv-chips').innerHTML = cats.map((c) =>
    '<div class="badge-pill' + (c === mInvFilter ? ' selected' : '') + '" onclick="setInvFilter(\'' + c + '\')">' + (c === 'all' ? 'All' : M_INV_CATEGORY_LABELS[c]) + '</div>').join('');
}

// Grouped by location so the list reads in the order you walk the room.
function renderInvList() {
  const el = document.getElementById('m-inv-list');
  const rows = mInvItems.filter((i) => mInvFilter === 'all' || i.category === mInvFilter)
    .sort((a, b) => (a.location || '~').localeCompare(b.location || '~') || a.name.localeCompare(b.name));

  document.getElementById('m-inv-progress').textContent = rows.filter(mInvCountedToday).length + ' / ' + rows.length;
  renderInvSyncStatus();
  if (!rows.length) { el.innerHTML = '<div class="loading">No items yet — add them from the staff panel.</div>'; return; }

  let html = '';
  let lastLoc = null;
  rows.forEach((i) => {
    const loc = i.location || 'No location set';
    if (loc !== lastLoc) { html += '<div class="m-loc-label">' + escHtml(loc) + '</div>'; lastLoc = loc; }
    const counted = mInvCountedToday(i);
    const sub = [mInvFilter === 'all' ? M_INV_CATEGORY_LABELS[i.category] : null, i.subcategory].filter(Boolean).map(escHtml).join(' &middot; ');
    html += '<div class="m-item' + (counted ? ' counted' : '') + '">'
      + '<div class="m-item-top"><div><div class="m-item-name">' + escHtml(i.name) + '</div>' + (sub ? '<div class="m-item-sub">' + sub + '</div>' : '') + '</div></div>'
      + '<div class="m-item-ctl">'
      + '<button class="m-step" aria-label="Decrease" onclick="stepInvItem(\'' + i.id + '\',-' + M_INV_STEP + ')">&minus;</button>'
      + '<div class="m-pct ' + mInvStatusColor(i) + '">' + i.percent_remaining + '%</div>'
      + '<button class="m-step" aria-label="Increase" onclick="stepInvItem(\'' + i.id + '\',' + M_INV_STEP + ')">+</button>'
      + '<button class="m-same" onclick="stepInvItem(\'' + i.id + '\',0)">' + (counted ? '&#10003; Done' : 'Same') + '</button>'
      + '</div></div>';
  });
  el.innerHTML = html;
}

function renderInvSyncStatus() {
  const pending = Object.keys(mInvQueue()).length;
  document.getElementById('m-inv-sync').textContent = pending ? pending + ' waiting to sync' : '';
}

// delta 0 is the "Same" button — the level hasn't moved, but the item
// still gets stamped as checked.
function stepInvItem(id, delta) {
  const item = mInvItems.find((i) => i.id === id);
  if (!item) return;
  item.percent_remaining = Math.min(100, Math.max(0, item.percent_remaining + delta));
  item.last_checked_at = new Date().toISOString();

  const queue = mInvQueue();
  queue[id] = { pct: item.percent_remaining, at: item.last_checked_at };
  writeJson(M_INV_QUEUE_KEY, queue);
  writeJson(M_INV_ITEMS_KEY, mInvItems);
  renderInvList();

  clearTimeout(mInvFlushTimer);
  mInvFlushTimer = setTimeout(mInvFlush, 800);
}

// A failed send stays queued and is retried on the next change, the
// next time this screen opens, or when the phone comes back online.
async function mInvFlush() {
  if (mInvFlushing || !navigator.onLine || !window.currentStaff) return;
  mInvFlushing = true;
  const sending = mInvQueue();
  let failed = false;
  for (const id of Object.keys(sending)) {
    const { error } = await window.supabase.from('inventory_items')
      .update({ percent_remaining: sending[id].pct, last_checked_at: sending[id].at, last_checked_by: window.currentStaff.id })
      .eq('id', id);
    if (error) { failed = true; continue; }
    // Only clear it if the count wasn't changed again while this was in flight.
    const queue = mInvQueue();
    if (queue[id] && queue[id].at === sending[id].at) { delete queue[id]; writeJson(M_INV_QUEUE_KEY, queue); }
  }
  mInvFlushing = false;
  renderInvSyncStatus();
  if (!failed && Object.keys(mInvQueue()).length) mInvFlush();
}

window.addEventListener('online', mInvFlush);
