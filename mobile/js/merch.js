// merch.js (mobile)
// The "Merch" chip on #screen-inventory — the unit count for
// merchandise (js/merch.js on desktop, migration_034 + 036). Unlike
// the percent items next to it, merch is counted in actual units.
//
// The list shows one read-only card per style (a product's color +
// design, with its photo). Edit opens that style on the shared sheet:
// pick the location you're standing at, enter the units of each size
// there, Save. Count and location are the only things a phone can
// change; products, photos, retiring and trends stay on the desktop.
//
// Merch sits in more than one place, so a count is for a size AT a
// location and the total is the sum across locations. Stock carried
// over from the old spreadsheet has no location; the first count of a
// size at a real location replaces that size's old un-located number.
//
// Nothing is written to a variant or a stock row directly: each number
// goes through record_merch_count() and the database triggers do the
// rest. Like the percent items, a saved count goes into a localStorage
// queue first and syncs from there, so one taken with no signal isn't
// lost.
// Depends on: window.supabase, window.currentStaff, toast(),
// escHtml(), toDateStr(), readJson(), writeJson() (core.js),
// mInvCountedToday(), renderInvSyncStatus(), mLocationPath(),
// mLocationsFlat(), mPhotoHtml(), mOpenSheet(), mCloseSheet(),
// mInvFilter (inventory.js), mTasksRefresh() (tasks.js)

const M_MERCH_TYPE_LABELS = { shirt: 'Shirts', tank: 'Tanks', long_sleeve: 'Long Sleeves', sweatshirt: 'Sweatshirts', outerwear: 'Outerwear', hat: 'Hats', visor: 'Visors', drinkware: 'Drinkware', accessory: 'Accessories', other: 'Other' };
const M_MERCH_DATA_KEY = 'lvbc-mobile-merch-data';
const M_MERCH_QUEUE_KEY = 'lvbc-mobile-merch-queue';
const M_MERCH_UNSPLIT = ''; // location key for stock not yet split by location

let mMerchProducts = [];
let mMerchStyles = [];
let mMerchVariants = [];
let mMerchStock = [];
let mMerchFlushing = false;
let mMerchDraft = null; // { styleId, locKey, byLoc: { locKey: { variantId: n } } } while a style's sheet is open

// Queue shape: { "variantId|locKey": { variant_id, location_id, n, at, day } }
function mMerchQueue() { return readJson(M_MERCH_QUEUE_KEY) || {}; }
function mMerchPending() { return Object.keys(mMerchQueue()).length; }

async function loadMerchCount() {
  const el = document.getElementById('m-inv-list');
  const res = await Promise.all([
    window.supabase.from('inventory_merch_products').select('id,name,product_type,style_number').eq('status', 'active').order('name'),
    window.supabase.from('inventory_merch_styles').select('id,product_id,color,design,photo_url').eq('status', 'active'),
    window.supabase.from('inventory_merch_variants').select('id,style_id,size,size_sort,unit_count,needs_verification,last_checked_at').order('size_sort'),
    window.supabase.from('inventory_merch_stock').select('variant_id,location_id,unit_count,last_checked_at'),
  ]);
  const failed = res.find((r) => r.error);
  if (failed) {
    const cached = readJson(M_MERCH_DATA_KEY);
    if (!cached) { el.innerHTML = '<div class="loading">Could not load merchandise: ' + escHtml(failed.error.message) + '</div>'; return; }
    ({ products: mMerchProducts, styles: mMerchStyles, variants: mMerchVariants, stock: mMerchStock } = cached);
  } else {
    mMerchProducts = res[0].data;
    mMerchStyles = res[1].data;
    const styleIds = new Set(mMerchStyles.map((s) => s.id));
    mMerchVariants = res[2].data.filter((v) => styleIds.has(v.style_id));
    mMerchStock = res[3].data;
    mMerchSaveCache();
  }
  // Counts still waiting to sync win over whatever the server last had.
  Object.values(mMerchQueue()).forEach((qd) => mMerchApply(qd.variant_id, qd.location_id || M_MERCH_UNSPLIT, qd.n, qd.at));
  if (mInvFilter === 'merch') renderMerchCount();
  mMerchFlush();
}

function mMerchSaveCache() {
  writeJson(M_MERCH_DATA_KEY, { products: mMerchProducts, styles: mMerchStyles, variants: mMerchVariants, stock: mMerchStock });
}

// Mirrors the database triggers on the local copy: set the stock at
// that location, drop the un-located number once a real location is
// counted, and re-total the variant.
function mMerchApply(variantId, locKey, n, at) {
  const v = mMerchVariants.find((x) => x.id === variantId);
  if (!v) return;
  const row = mMerchStock.find((r) => r.variant_id === variantId && (r.location_id || M_MERCH_UNSPLIT) === locKey);
  if (row) { row.unit_count = n; row.last_checked_at = at; } else mMerchStock.push({ variant_id: variantId, location_id: locKey || null, unit_count: n, last_checked_at: at });
  if (locKey !== M_MERCH_UNSPLIT) mMerchStock = mMerchStock.filter((r) => !(r.variant_id === variantId && !r.location_id));
  v.unit_count = mMerchStock.filter((r) => r.variant_id === variantId).reduce((a, r) => a + r.unit_count, 0);
  v.last_checked_at = at;
}

function mMerchStyleLabel(s) { return [s.color, s.design].filter(Boolean).join(' · '); }
function mMerchVariantsFor(styleId) { return mMerchVariants.filter((v) => v.style_id === styleId).sort((a, b) => a.size_sort - b.size_sort); }
// Whether this size has ever been counted at this location.
function mMerchHasStockRow(variantId, locKey) {
  return mMerchStock.some((r) => r.variant_id === variantId && (r.location_id || M_MERCH_UNSPLIT) === locKey);
}
function mMerchStockAt(variantId, locKey) {
  const row = mMerchStock.find((r) => r.variant_id === variantId && (r.location_id || M_MERCH_UNSPLIT) === locKey);
  return row ? row.unit_count : 0;
}
// Location keys where this style currently has a stock row.
function mMerchStyleLocKeys(styleId) {
  const ids = mMerchVariantsFor(styleId).map((v) => v.id);
  return [...new Set(mMerchStock.filter((r) => ids.includes(r.variant_id)).map((r) => r.location_id || M_MERCH_UNSPLIT))];
}

// ── LIST ─────────────────────────────────────────
// One card per style, grouped under its product type.
function renderMerchCount() {
  const el = document.getElementById('m-inv-list');
  const counted = (s) => mMerchVariantsFor(s.id).every(mInvCountedToday);
  document.getElementById('m-inv-progress').textContent = mMerchStyles.filter(counted).length + ' / ' + mMerchStyles.length;
  renderInvSyncStatus();
  if (!mMerchStyles.length) { el.innerHTML = '<div class="loading">No active merchandise — add it from the staff panel.</div>'; return; }

  const typeOrder = Object.keys(M_MERCH_TYPE_LABELS);
  const productById = {};
  mMerchProducts.forEach((p) => { productById[p.id] = p; });
  const styles = mMerchStyles.filter((s) => productById[s.product_id]).sort((a, b) => {
    const pa = productById[a.product_id], pb = productById[b.product_id];
    return typeOrder.indexOf(pa.product_type) - typeOrder.indexOf(pb.product_type) || pa.name.localeCompare(pb.name) || mMerchStyleLabel(a).localeCompare(mMerchStyleLabel(b));
  });
  let html = '';
  let lastType = null;
  styles.forEach((s) => {
    const p = productById[s.product_id];
    if (p.product_type !== lastType) { html += '<div class="m-loc-label">' + escHtml(M_MERCH_TYPE_LABELS[p.product_type] || 'Other') + '</div>'; lastType = p.product_type; }
    const variants = mMerchVariantsFor(s.id);
    const locs = mMerchStyleLocKeys(s.id).filter((k) => k !== M_MERCH_UNSPLIT).map(mLocationPath);
    const done = counted(s);
    html += '<div class="m-item m-rec' + (done ? ' counted' : '') + '">' + mPhotoHtml(s.photo_url, p.name + ' ' + mMerchStyleLabel(s))
      + '<div class="m-rec-body"><div class="m-item-name">' + escHtml(p.name) + '</div>'
      + (mMerchStyleLabel(s) ? '<div class="m-item-sub">' + escHtml(mMerchStyleLabel(s)) + '</div>' : '')
      + '<div class="m-item-sub">' + escHtml(locs.length ? locs.join(', ') : 'No location yet') + '</div>'
      + '<div class="m-rec-level"><span class="m-pct">' + variants.reduce((a, v) => a + v.unit_count, 0) + '</span><span class="m-rec-unit">units</span>'
      + (variants.some((v) => v.needs_verification) ? '<span class="m-rec-flag">&#9888; verify</span>' : '') + (done ? '<span class="m-rec-done">&#10003; counted today</span>' : '') + '</div></div>'
      + '<button class="btn btn-sm btn-secondary" onclick="openMerchEdit(\'' + s.id + '\')">Edit</button></div>';
  });
  el.innerHTML = html;
}

// ── EDIT ONE STYLE ───────────────────────────────
// presetLocKey is passed by the Tasks screen, where the assignment already says which location to count.
function openMerchEdit(styleId, presetLocKey) {
  const located = mMerchStyleLocKeys(styleId).filter((k) => k !== M_MERCH_UNSPLIT);
  // Start at a location it's already kept in, in tree order; otherwise make the person choose.
  const start = mLocationsFlat().map((l) => l.id).find((id) => located.includes(id));
  mMerchDraft = { styleId, locKey: presetLocKey || start || (mLocationsFlat().length ? null : M_MERCH_UNSPLIT), byLoc: {} };
  renderMerchEdit();
}

function renderMerchEdit() {
  const { styleId, locKey } = mMerchDraft;
  const s = mMerchStyles.find((x) => x.id === styleId);
  const p = mMerchProducts.find((x) => x.id === s.product_id);
  const variants = mMerchVariantsFor(styleId);
  const keys = mMerchStyleLocKeys(styleId);
  const hasUnsplit = keys.includes(M_MERCH_UNSPLIT);
  const draft = locKey == null ? {} : (mMerchDraft.byLoc[locKey] = mMerchDraft.byLoc[locKey] || {});

  const here = keys.filter((k) => k !== M_MERCH_UNSPLIT);
  const option = (l) => '<option value="' + l.id + '"' + (l.id === locKey ? ' selected' : '') + '>' + escHtml(l.path) + '</option>';
  const flat = mLocationsFlat();
  let html = '<div class="m-sheet-body">'
    + mPhotoHtml(s.photo_url, p.name + ' ' + mMerchStyleLabel(s), true)
    + '<div class="m-sheet-title">' + escHtml(p.name) + '</div>'
    + '<div class="m-item-sub">' + escHtml([mMerchStyleLabel(s), p.style_number ? 'Style ' + p.style_number : null].filter(Boolean).join(' · ')) + '</div>'
    + '<label class="admin-label m-sheet-label" for="m-merch-draft-loc">Location you are counting</label>'
    + '<select class="admin-select" id="m-merch-draft-loc" onchange="setMerchEditLocation(this.value)">'
    + (locKey == null ? '<option value="" selected disabled>Choose a location…</option>' : '')
    + (here.length ? '<optgroup label="Kept here now">' + flat.filter((l) => here.includes(l.id)).map(option).join('') + '</optgroup>' : '')
    + '<optgroup label="' + (here.length ? 'Other locations' : 'Locations') + '">' + flat.filter((l) => !here.includes(l.id)).map(option).join('') + '</optgroup>'
    + '</select>';

  if (locKey == null) {
    html += '<div class="m-sheet-note">Pick where you are counting to enter numbers.</div>';
  } else {
    if (hasUnsplit && locKey !== M_MERCH_UNSPLIT) {
      html += '<div class="m-sheet-note">This style still has an old total that isn\'t tied to a location. Saving a count here replaces that old number for these sizes, so count every place it is kept.</div>';
    }
    html += '<label class="admin-label m-sheet-label">Units at ' + escHtml(locKey ? mLocationPath(locKey) : 'no location') + '</label><div class="m-merch-sizes">'
      + variants.map((v) => '<label class="m-merch-size' + (v.needs_verification ? ' flagged' : '') + '"><span>' + escHtml(v.size || 'Qty') + '</span>'
        + '<input type="number" inputmode="numeric" pattern="[0-9]*" min="0" step="1" placeholder="?" value="' + (draft[v.id] != null ? draft[v.id] : mMerchHasStockRow(v.id, locKey) ? mMerchStockAt(v.id, locKey) : '') + '" onfocus="this.select()" oninput="setMerchDraft(\'' + v.id + '\',this.value)"></label>').join('')
      + '</div>';
  }
  html += '</div><div class="m-sheet-actions"><button class="btn btn-secondary" onclick="closeMerchEdit()">Cancel</button>'
    + '<button class="btn btn-primary"' + (locKey == null ? ' disabled' : '') + ' onclick="saveMerchEdit()">Save</button></div>';
  mOpenSheet(html);
}

function closeMerchEdit() { mMerchDraft = null; mCloseSheet(); }
function setMerchEditLocation(locKey) { mMerchDraft.locKey = locKey; renderMerchEdit(); }
function setMerchDraft(variantId, value) { mMerchDraft.byLoc[mMerchDraft.locKey][variantId] = value; }

// Save records every size at the location on screen — unchanged ones
// too, since confirming them is the count — plus any size that was
// edited at another location before switching. A size that has never
// been counted at that location has to be typed in first.
function saveMerchEdit() {
  const { styleId, locKey, byLoc } = mMerchDraft;
  const variants = mMerchVariantsFor(styleId);
  const entries = [];
  for (const k of Object.keys(byLoc)) {
    for (const v of variants) {
      const raw = byLoc[k][v.id];
      if (raw == null && k !== locKey) continue;
      // A size never counted here starts blank, not 0 — saving a 0 nobody typed would wipe its old un-located number.
      if ((raw == null || raw === '') && !mMerchHasStockRow(v.id, k)) { toast('Enter a count for every size — 0 if there are none here', true); return; }
      const n = raw == null ? mMerchStockAt(v.id, k) : parseInt(raw, 10);
      if (isNaN(n) || n < 0) { toast('Enter a whole number, 0 or more, for every size', true); return; }
      entries.push({ variant_id: v.id, location_id: k || null, n });
    }
  }
  const at = new Date().toISOString();
  const day = toDateStr(new Date());
  const queue = mMerchQueue();
  entries.forEach((e) => {
    queue[e.variant_id + '|' + (e.location_id || M_MERCH_UNSPLIT)] = Object.assign({ at, day }, e);
    mMerchApply(e.variant_id, e.location_id || M_MERCH_UNSPLIT, e.n, at);
  });
  writeJson(M_MERCH_QUEUE_KEY, queue);
  mMerchSaveCache();
  closeMerchEdit();
  if (mInvFilter === 'merch') renderMerchCount();
  mTasksRefresh();
  toast('Saved');
  mMerchFlush();
}

// A failed send stays queued and is retried on the next save, the
// next time this screen opens, or when the phone comes back online.
async function mMerchFlush() {
  if (mMerchFlushing || !navigator.onLine || !window.currentStaff) return;
  mMerchFlushing = true;
  const sending = mMerchQueue();
  let failed = false;
  for (const key of Object.keys(sending)) {
    const e = sending[key];
    const { error } = await window.supabase.rpc('record_merch_count', {
      p_variant_id: e.variant_id, p_location_id: e.location_id, p_unit_count: e.n, p_counted_on: e.day, p_counted_at: e.at });
    if (error) { failed = true; continue; }
    // Only clear it if the count wasn't saved again while this was in flight.
    const queue = mMerchQueue();
    if (queue[key] && queue[key].at === e.at) { delete queue[key]; writeJson(M_MERCH_QUEUE_KEY, queue); }
  }
  mMerchFlushing = false;
  renderInvSyncStatus();
  if (!failed && mMerchPending()) mMerchFlush();
}

window.addEventListener('online', mMerchFlush);
