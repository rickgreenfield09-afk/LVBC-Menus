// countsheets.js (mobile)
// Count sheets assigned to you from the desktop Inventory > Run Inventory
// screen (js/countsheets.js, migration_050). They sit at the top of the
// Inventory tab, and a dot with the number on the tab bar says how many
// are waiting. Tapping the push notification opens the app at #count.
//
// A sheet opens full-screen, listed by location in walking order. Each
// line shows what inventory had ("was 60%") and three controls: minus,
// "Still 60%" to confirm the number unchanged, and plus. Merch sizes of
// one style at one location sit together on a single card. Counts are
// staged on the sheet only — nothing in inventory changes until you tap
// Submit, which applies every counted line at once
// (submit_count_sheet()). Lines you leave uncounted stay as they are.
//
// Like the other counts, each tap goes into a localStorage queue and
// syncs from there, so a walk-in with no signal doesn't lose anything.
// Submitting needs a connection.
//
// Cancel Count (top of an open sheet) is for when you can't do it: you
// write a reason, the sheet closes with nothing applied to inventory
// (close_count_sheet(), migration_051), and the person who sent it gets
// your message as a push (api/notify-count-sheet.js, event 'closed').
//
// The "count for you" push opens straight onto its sheet: its link is
// #count=<sheet id> (see showCountSheets() in core.js).
// Depends on: window.supabase, window.currentStaff, toast(), escHtml(),
// toDateStr(), readJson(), writeJson() (core.js), mMyStaffIds,
// resolveMyStaffIds() (schedule.js), mPhotoHtml() (inventory.js),
// loadInventoryCount(), mTasksRefresh() (inventory.js / tasks.js)

const M_SHEETS_KEY = 'lvbc-mobile-sheets';
const M_SHEET_QUEUE_KEY = 'lvbc-mobile-sheet-queue';
const M_SHEET_PCT_STEP = 5;

let mSheets = [];        // sheets assigned to me and still open
let mSheetLines = {};    // sheet id -> lines
let mSheetWas = {};      // item id | "variantId|locationId" -> what inventory has now
let mSheetCreators = {}; // staff id -> name, for the people who built my sheets
let mSheetOpenId = null;
let mPendingSheetId = null; // a push linked straight to this sheet; opened once the list has loaded
let mSheetFlushing = false;
let mSheetFlushTimer = null;

// Queue shape: { [lineId]: { value, at } } — one pending count per line.
function mSheetQueue() { return readJson(M_SHEET_QUEUE_KEY) || {}; }

function mSheetWasKey(l) { return l.kind === 'percent' ? l.item_id : l.variant_id + '|' + (l.location_id || ''); }
function mSheetUnit(l, v) { return l.kind === 'percent' ? v + '%' : String(v); }

// ── LOAD ─────────────────────────────────────────
async function loadMySheets() {
  if (!window.currentStaff) return;
  const ids = mMyStaffIds.length ? mMyStaffIds : await resolveMyStaffIds();
  const { data: sheets, error } = await window.supabase.from('inventory_count_sheets')
    .select('*').eq('status', 'assigned').in('assigned_to', ids).order('assigned_at');
  if (error) {
    const cached = readJson(M_SHEETS_KEY);
    if (!cached) return;
    ({ sheets: mSheets, lines: mSheetLines, was: mSheetWas } = cached);
    mSheetCreators = cached.creators || {};
  } else {
    mSheets = sheets || [];
    mSheetLines = {};
    mSheetWas = {};
    const creatorIds = [...new Set(mSheets.map((s) => s.created_by).filter(Boolean))];
    if (creatorIds.length) {
      const { data: people } = await window.supabase.from('staff_profiles').select('id,name').in('id', creatorIds);
      (people || []).forEach((p) => { mSheetCreators[p.id] = p.name; });
    }
    if (mSheets.length) {
      const { data: lines } = await window.supabase.from('inventory_count_sheet_lines')
        .select('*').in('sheet_id', mSheets.map((s) => s.id)).order('sort_order');
      (lines || []).forEach((l) => (mSheetLines[l.sheet_id] = mSheetLines[l.sheet_id] || []).push(l));
      const all = lines || [];
      const itemIds = [...new Set(all.filter((l) => l.item_id).map((l) => l.item_id))];
      const variantIds = [...new Set(all.filter((l) => l.variant_id).map((l) => l.variant_id))];
      const [items, stock] = await Promise.all([
        itemIds.length ? window.supabase.from('inventory_items').select('id,percent_remaining').in('id', itemIds) : { data: [] },
        variantIds.length ? window.supabase.from('inventory_merch_stock').select('variant_id,location_id,unit_count').in('variant_id', variantIds) : { data: [] },
      ]);
      (items.data || []).forEach((i) => { mSheetWas[i.id] = i.percent_remaining; });
      (stock.data || []).forEach((r) => { mSheetWas[r.variant_id + '|' + (r.location_id || '')] = r.unit_count; });
    }
    writeJson(M_SHEETS_KEY, { sheets: mSheets, lines: mSheetLines, was: mSheetWas, creators: mSheetCreators });
  }
  // Counts still waiting to sync win over whatever the server last had.
  const queue = mSheetQueue();
  Object.values(mSheetLines).flat().forEach((l) => { if (queue[l.id]) { l.counted_value = queue[l.id].value; l.counted_at = queue[l.id].at; } });
  mSheetsBadge();
  renderMySheets();
  if (mSheetOpenId) {
    if (mSheets.some((s) => s.id === mSheetOpenId)) paintSheet(); else mSheetClose();
  }
  if (mPendingSheetId) {
    const id = mPendingSheetId;
    mPendingSheetId = null;
    if (mSheets.some((s) => s.id === id)) openMySheet(id);
    else toast('That count sheet isn\u2019t open any more.', true);
  }
  mSheetFlush();
}

function mSheetsBadge() {
  const btn = document.querySelectorAll('.m-tabbar .nav-btn')[2];
  if (btn) btn.innerHTML = 'Inventory' + (mSheets.length ? ' <span class="m-nav-dot">' + mSheets.length + '</span>' : '');
}

function mSheetProgress(sheetId) {
  const lines = mSheetLines[sheetId] || [];
  return { total: lines.length, counted: lines.filter((l) => l.counted_value !== null && l.counted_value !== undefined).length };
}

function renderMySheets() {
  const el = document.getElementById('m-sheets');
  if (!el) return;
  if (!mSheets.length) { el.innerHTML = ''; return; }
  el.innerHTML = '<div class="section-label" style="margin-top:0;">Count Sheets For You</div>'
    + mSheets.map((s) => {
      const p = mSheetProgress(s.id);
      return '<div class="card m-sheet-card"><div style="flex:1;min-width:0;"><div class="m-item-name">' + escHtml(s.title) + '</div>'
        + (s.notes ? '<div class="m-item-sub">' + escHtml(s.notes) + '</div>' : '')
        + '<div class="m-rec-done" style="color:' + (p.counted === p.total && p.total ? 'var(--teal)' : 'var(--amber)') + ';">' + p.counted + ' of ' + p.total + ' counted</div></div>'
        + '<button class="btn btn-primary btn-sm" onclick="openMySheet(\'' + s.id + '\')">' + (p.counted ? 'Continue' : 'Start') + '</button></div>';
    }).join('');
}

// ── THE SHEET ────────────────────────────────────
function openMySheet(id) {
  mSheetOpenId = id;
  const sheet = document.getElementById('m-sheet');
  sheet.style.display = 'flex';
  document.body.style.overflow = 'hidden';
  paintSheet();
  sheet.scrollTop = 0;
}

function mSheetClose() {
  mSheetOpenId = null;
  document.getElementById('m-sheet').style.display = 'none';
  document.body.style.overflow = '';
}

function mSheetValue(l) { return l.counted_value !== null && l.counted_value !== undefined ? l.counted_value : null; }
function mSheetWasValue(l) { const w = mSheetWas[mSheetWasKey(l)]; return w === undefined ? 0 : w; }

function mSheetControls(l) {
  const v = mSheetValue(l);
  const step = l.kind === 'percent' ? M_SHEET_PCT_STEP : 1;
  const mid = v === null
    ? '<button class="btn btn-secondary m-cs-same" onclick="mSheetSame(\'' + l.id + '\')">Still ' + mSheetUnit(l, mSheetWasValue(l)) + '</button>'
    : '<div class="m-pct m-cs-val">' + mSheetUnit(l, v) + '</div>';
  return '<div class="m-item-ctl m-cs-ctl">'
    + '<button class="m-step" aria-label="Decrease" onclick="mSheetStep(\'' + l.id + '\',-' + step + ')">&minus;</button>' + mid
    + '<button class="m-step" aria-label="Increase" onclick="mSheetStep(\'' + l.id + '\',' + step + ')">+</button></div>';
}

function paintSheet() {
  const sheet = mSheets.find((s) => s.id === mSheetOpenId);
  const el = document.getElementById('m-sheet');
  if (!sheet) return;
  const lines = mSheetLines[sheet.id] || [];
  const p = mSheetProgress(sheet.id);

  let html = '';
  let group = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.group_label !== group) { html += '<div class="m-loc-label">' + escHtml(l.group_label) + '</div>'; group = l.group_label; }
    const done = mSheetValue(l) !== null;
    if (l.kind === 'percent') {
      html += '<div class="m-item m-cs-card' + (done ? ' counted' : '') + '"><div class="m-rec">' + mPhotoHtml(l.photo_url, l.label)
        + '<div class="m-rec-body"><div class="m-item-name">' + escHtml(l.label) + '</div>'
        + (l.detail ? '<div class="m-item-sub">' + escHtml(l.detail) + '</div>' : '')
        + (done ? '<div class="m-rec-done">&#10003; counted &middot; was ' + mSheetUnit(l, mSheetWasValue(l)) + '</div>' : '')
        + '</div></div>' + mSheetControls(l) + '</div>';
    } else {
      // Every size of one style at one location is one card.
      const sizes = [l];
      while (lines[i + 1] && lines[i + 1].kind === 'units' && lines[i + 1].label === l.label && lines[i + 1].group_label === l.group_label) sizes.push(lines[++i]);
      const allDone = sizes.every((s) => mSheetValue(s) !== null);
      html += '<div class="m-item m-cs-card' + (allDone ? ' counted' : '') + '"><div class="m-rec">' + mPhotoHtml(l.photo_url, l.label)
        + '<div class="m-rec-body"><div class="m-item-name">' + escHtml(l.label) + '</div></div></div>'
        + sizes.map((s) => '<div class="m-cs-size"><div class="m-cs-size-name">' + escHtml(s.size || '') + '<span>was ' + mSheetWasValue(s) + '</span></div>' + mSheetControls(s) + '</div>').join('')
        + (sizes.some((s) => mSheetValue(s) === null) ? '<button class="btn btn-secondary btn-sm" style="margin-top:10px;" onclick="mSheetAllSame(\'' + sizes.filter((s) => mSheetValue(s) === null).map((s) => s.id).join(',') + '\')">All sizes unchanged</button>' : '')
        + '</div>';
    }
  }

  const scroll = el.scrollTop;
  el.innerHTML = '<div class="m-sheet-body">'
    + '<div class="m-sheet-title">' + escHtml(sheet.title) + '</div>'
    + (sheet.notes ? '<div class="m-sheet-note">' + escHtml(sheet.notes) + '</div>' : '')
    + '<div class="m-cs-head"><div class="m-rec-done" style="color:' + (p.counted === p.total ? 'var(--teal)' : 'var(--amber)') + ';">' + p.counted + ' of ' + p.total + ' counted</div>'
    + '<button class="btn btn-sm btn-secondary" onclick="mSheetCancelDialog(\'' + sheet.id + '\')">Cancel Count</button></div>'
    + html + '</div>'
    + '<div class="m-sheet-actions"><button class="btn btn-secondary" onclick="mSheetClose()">Close</button>'
    + '<button class="btn btn-primary" onclick="mSheetSubmit(\'' + sheet.id + '\')">Submit Count</button></div>';
  el.scrollTop = scroll;
}

// ── COUNTING ─────────────────────────────────────
function mSheetFindLine(lineId) {
  for (const lines of Object.values(mSheetLines)) {
    const l = lines.find((x) => x.id === lineId);
    if (l) return l;
  }
  return null;
}

function mSheetSet(lineId, value) {
  const l = mSheetFindLine(lineId);
  if (!l) return;
  l.counted_value = l.kind === 'percent' ? Math.min(100, Math.max(0, value)) : Math.max(0, value);
  l.counted_at = new Date().toISOString();
  const queue = mSheetQueue();
  queue[l.id] = { value: l.counted_value, at: l.counted_at };
  writeJson(M_SHEET_QUEUE_KEY, queue);
  writeJson(M_SHEETS_KEY, { sheets: mSheets, lines: mSheetLines, was: mSheetWas, creators: mSheetCreators });
}

function mSheetStep(lineId, delta) {
  const l = mSheetFindLine(lineId);
  if (!l) return;
  const base = mSheetValue(l) !== null ? mSheetValue(l) : mSheetWasValue(l);
  mSheetSet(lineId, base + delta);
  mSheetAfterChange();
}

function mSheetSame(lineId) {
  const l = mSheetFindLine(lineId);
  if (!l) return;
  mSheetSet(lineId, mSheetWasValue(l));
  mSheetAfterChange();
}

function mSheetAllSame(ids) {
  ids.split(',').forEach((id) => { const l = mSheetFindLine(id); if (l) mSheetSet(id, mSheetWasValue(l)); });
  mSheetAfterChange();
}

function mSheetAfterChange() {
  paintSheet();
  renderMySheets();
  clearTimeout(mSheetFlushTimer);
  mSheetFlushTimer = setTimeout(mSheetFlush, 400);
}

// A failed send stays queued and is retried on the next tap, the next
// time the sheet list loads, or when the phone comes back online.
async function mSheetFlush() {
  if (mSheetFlushing || !navigator.onLine || !window.currentStaff) return;
  mSheetFlushing = true;
  const sending = mSheetQueue();
  let failed = false;
  for (const id of Object.keys(sending)) {
    const { error } = await window.supabase.from('inventory_count_sheet_lines')
      .update({ counted_value: sending[id].value, counted_at: sending[id].at }).eq('id', id);
    if (error) { failed = true; continue; }
    // Only clear it if the line wasn't counted again while this was in flight.
    const queue = mSheetQueue();
    if (queue[id] && queue[id].at === sending[id].at) { delete queue[id]; writeJson(M_SHEET_QUEUE_KEY, queue); }
  }
  mSheetFlushing = false;
  if (!failed && Object.keys(mSheetQueue()).length) mSheetFlush();
}

async function mSheetSubmit(sheetId) {
  const p = mSheetProgress(sheetId);
  if (!p.counted) { toast('Count at least one line first.', true); return; }
  if (!navigator.onLine) { toast('You need a connection to submit. Your counts are saved on this phone.', true); return; }
  const left = p.total - p.counted;
  if (left && !confirm(left + (left === 1 ? ' line isn\u2019t' : ' lines aren\u2019t') + ' counted; inventory keeps the current ' + (left === 1 ? 'number' : 'numbers') + ' for ' + (left === 1 ? 'it' : 'them') + '. Submit anyway?')) return;

  // Wait for any counts still in the queue to reach the sheet before applying it.
  while (mSheetFlushing) await new Promise((r) => setTimeout(r, 100));
  await mSheetFlush();
  const lineIds = new Set((mSheetLines[sheetId] || []).map((l) => l.id));
  if (Object.keys(mSheetQueue()).some((id) => lineIds.has(id))) { toast('Some counts haven’t synced yet — try again in a moment.', true); return; }

  const { data, error } = await window.supabase.rpc('submit_count_sheet', { p_sheet_id: sheetId, p_counted_on: toDateStr(new Date()) });
  if (error) { toast(error.message, true); return; }
  toast('Submitted — ' + data + ' counted');
  mSheetClose();
  await loadMySheets();
  if (typeof loadInventoryCount === 'function') loadInventoryCount();
  if (typeof mTasksRefresh === 'function') mTasksRefresh();
}

// ── CANCEL THE COUNT ─────────────────────────────
function mSheetCancelDialog(sheetId) {
  const sheet = mSheets.find((s) => s.id === sheetId);
  if (!sheet) return;
  const who = mSheetCreators[sheet.created_by] || 'the person who sent it';
  const d = document.createElement('div');
  d.id = 'm-cancel-dialog';
  d.className = 'm-dialog';
  d.innerHTML = '<div class="card m-dialog-card">'
    + '<div class="m-sheet-title" style="font-size:24px;">Cancel this count?</div>'
    + '<p class="m-item-sub" style="margin:8px 0 12px;line-height:1.45;">Tell ' + escHtml(who) + ' why you can\u2019t count it. They\u2019ll get your message, and nothing in inventory changes.</p>'
    + '<textarea class="admin-input m-dialog-text" id="m-cancel-reason" rows="4" maxlength="240" placeholder="e.g. The cellar is locked and I don\u2019t have the key"></textarea>'
    + '<div id="m-cancel-err" class="m-login-error"></div>'
    + '<div class="m-dialog-actions"><button class="btn btn-secondary" onclick="mSheetCancelDialogClose()">Back</button>'
    + '<button class="btn btn-danger" id="m-cancel-send" onclick="mSheetCancelSend(\'' + sheetId + '\')">Cancel Count</button></div></div>';
  document.body.appendChild(d);
  document.getElementById('m-cancel-reason').focus();
}

function mSheetCancelDialogClose() {
  const d = document.getElementById('m-cancel-dialog');
  if (d) d.remove();
}

async function mSheetCancelSend(sheetId) {
  const sheet = mSheets.find((s) => s.id === sheetId);
  const reason = document.getElementById('m-cancel-reason').value.trim();
  const err = document.getElementById('m-cancel-err');
  const btn = document.getElementById('m-cancel-send');
  if (reason.length < 3) { err.textContent = 'Please add a short reason.'; return; }
  if (!navigator.onLine) { err.textContent = 'You need a connection to cancel this. Try again when you have signal.'; return; }
  btn.disabled = true;
  err.textContent = '';

  const { error } = await window.supabase.rpc('close_count_sheet', { p_sheet_id: sheetId, p_reason: reason });
  if (error) { err.textContent = error.message; btn.disabled = false; return; }

  // Counts staged on it were never applied; stop them syncing.
  const queue = mSheetQueue();
  (mSheetLines[sheetId] || []).forEach((l) => { delete queue[l.id]; });
  writeJson(M_SHEET_QUEUE_KEY, queue);
  mSheetCancelDialogClose();
  mSheetClose();

  const who = (sheet && mSheetCreators[sheet.created_by]) || 'The sender';
  let told = false;
  try {
    const { data: { session } } = await window.supabase.auth.getSession();
    const res = await fetch('/api/notify-count-sheet', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + session.access_token },
      body: JSON.stringify({ sheet_id: sheetId, event: 'closed' }),
    });
    const data = await res.json().catch(() => ({}));
    told = res.ok && data.sent > 0;
  } catch (e) { /* the reason is on the sheet either way */ }
  toast(told ? 'Count cancelled \u2014 ' + who + ' has been told' : 'Count cancelled. ' + who + ' will see your message on the sheet.');
  await loadMySheets();
}

window.addEventListener('online', mSheetFlush);
