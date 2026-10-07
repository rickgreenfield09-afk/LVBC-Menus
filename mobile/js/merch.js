// merch.js (mobile)
// The "Merch" chip on #screen-inventory — the unit count for
// merchandise (js/merch.js on desktop, migration_034). Unlike the
// percent items next to it, merch is counted in actual units, one
// number per colour / design / size.
//
// Only active variants are listed. Adding products, retiring colours,
// clearing verification flags and trends all stay on the desktop panel.
//
// A count is never written to the variant: it's upserted into
// inventory_merch_counts (one row per variant per day) and the
// database trigger carries it onto the variant. Like the percent
// items, every number goes into a localStorage queue first and syncs
// from there, so a count taken with no signal isn't lost.
// Depends on: window.supabase, window.currentStaff, toast(),
// escHtml(), toDateStr(), readJson(), writeJson() (core.js),
// mInvCountedToday(), renderInvSyncStatus() (inventory.js)

const M_MERCH_TYPE_LABELS = { shirt: 'Shirts', tank: 'Tanks', long_sleeve: 'Long Sleeves', sweatshirt: 'Sweatshirts', outerwear: 'Outerwear', hat: 'Hats', visor: 'Visors', drinkware: 'Drinkware', accessory: 'Accessories', other: 'Other' };
const M_MERCH_DATA_KEY = 'lvbc-mobile-merch-data';
const M_MERCH_QUEUE_KEY = 'lvbc-mobile-merch-queue';

let mMerchProducts = [];
let mMerchVariants = [];
let mMerchFlushTimer = null;
let mMerchFlushing = false;

// Queue shape: { [variantId]: { n, at, day } } — one pending count per variant.
function mMerchQueue() { return readJson(M_MERCH_QUEUE_KEY) || {}; }
function mMerchPending() { return Object.keys(mMerchQueue()).length; }

async function loadMerchCount() {
  const el = document.getElementById('m-inv-list');
  const [{ data: products, error: pErr }, { data: variants, error: vErr }] = await Promise.all([
    window.supabase.from('inventory_merch_products').select('id,name,product_type,style_number').eq('status', 'active').order('name'),
    window.supabase.from('inventory_merch_variants').select('id,product_id,color,design,size,size_sort,unit_count,needs_verification,last_checked_at').eq('status', 'active').order('size_sort'),
  ]);
  if (pErr || vErr) {
    const cached = readJson(M_MERCH_DATA_KEY);
    if (!cached) { el.innerHTML = '<div class="loading">Could not load merchandise: ' + escHtml((pErr || vErr).message) + '</div>'; return; }
    mMerchProducts = cached.products;
    mMerchVariants = cached.variants;
  } else {
    mMerchProducts = products || [];
    mMerchVariants = variants || [];
    writeJson(M_MERCH_DATA_KEY, { products: mMerchProducts, variants: mMerchVariants });
  }
  // Counts still waiting to sync win over whatever the server last had.
  const queue = mMerchQueue();
  mMerchVariants.forEach((v) => { if (queue[v.id]) { v.unit_count = queue[v.id].n; v.last_checked_at = queue[v.id].at; } });
  if (mInvFilter === 'merch') renderMerchCount();
  mMerchFlush();
}

function mMerchUpdateProgress() {
  document.getElementById('m-inv-progress').textContent = mMerchVariants.filter(mInvCountedToday).length + ' / ' + mMerchVariants.length;
  renderInvSyncStatus();
}

// One card per product, grouped under its type; inside, one row of
// size boxes per colour / design.
function renderMerchCount() {
  const el = document.getElementById('m-inv-list');
  mMerchUpdateProgress();
  if (!mMerchVariants.length) { el.innerHTML = '<div class="loading">No active merchandise — add it from the staff panel.</div>'; return; }

  const typeOrder = Object.keys(M_MERCH_TYPE_LABELS);
  const products = mMerchProducts.filter((p) => mMerchVariants.some((v) => v.product_id === p.id))
    .sort((a, b) => typeOrder.indexOf(a.product_type) - typeOrder.indexOf(b.product_type) || a.name.localeCompare(b.name));
  let html = '';
  let lastType = null;
  products.forEach((p) => {
    if (p.product_type !== lastType) { html += '<div class="m-loc-label">' + escHtml(M_MERCH_TYPE_LABELS[p.product_type] || 'Other') + '</div>'; lastType = p.product_type; }
    const groups = [];
    mMerchVariants.filter((v) => v.product_id === p.id).forEach((v) => {
      let g = groups.find((x) => x.color === v.color && x.design === v.design);
      if (!g) { g = { color: v.color, design: v.design, variants: [] }; groups.push(g); }
      g.variants.push(v);
    });
    html += '<div class="m-item"><div class="m-item-name">' + escHtml(p.name) + '</div>' + (p.style_number ? '<div class="m-item-sub">Style ' + escHtml(p.style_number) + '</div>' : '');
    groups.forEach((g) => {
      const label = [g.color, g.design].filter(Boolean).map(escHtml).join(' &middot; ');
      html += (label ? '<div class="m-merch-group">' + label + '</div>' : '') + '<div class="m-merch-sizes">'
        + g.variants.map((v) => '<label class="m-merch-size' + (mInvCountedToday(v) ? ' counted' : '') + (v.needs_verification ? ' flagged' : '') + '" id="m-merch-box-' + v.id + '">'
          + '<span>' + escHtml(v.size || 'Qty') + '</span>'
          + '<input type="number" inputmode="numeric" pattern="[0-9]*" min="0" step="1" value="' + v.unit_count + '" onfocus="this.select()" onchange="setMerchCount(\'' + v.id + '\',this)">'
          + '</label>').join('') + '</div>';
    });
    html += '</div>';
  });
  el.innerHTML = html;
}

// Leaving a box at the number it already showed doesn't fire this, so
// "counted today" only ticks for sizes someone actually confirmed by
// typing — re-enter the same number to confirm an unchanged count.
function setMerchCount(variantId, input) {
  const v = mMerchVariants.find((x) => x.id === variantId);
  const n = parseInt(input.value, 10);
  if (!v || isNaN(n) || n < 0) { input.value = v ? v.unit_count : 0; toast('Enter a whole number, 0 or more', true); return; }
  v.unit_count = n;
  v.last_checked_at = new Date().toISOString();
  input.value = n;

  const queue = mMerchQueue();
  queue[variantId] = { n, at: v.last_checked_at, day: toDateStr(new Date()) };
  writeJson(M_MERCH_QUEUE_KEY, queue);
  writeJson(M_MERCH_DATA_KEY, { products: mMerchProducts, variants: mMerchVariants });
  // Updated in place rather than re-rendered, so the keyboard and focus survive moving to the next box.
  document.getElementById('m-merch-box-' + variantId).classList.add('counted');
  mMerchUpdateProgress();

  clearTimeout(mMerchFlushTimer);
  mMerchFlushTimer = setTimeout(mMerchFlush, 800);
}

// A failed send stays queued and is retried on the next change, the
// next time this screen opens, or when the phone comes back online.
async function mMerchFlush() {
  if (mMerchFlushing || !navigator.onLine || !window.currentStaff) return;
  const sending = mMerchQueue();
  const ids = Object.keys(sending);
  if (!ids.length) return;
  mMerchFlushing = true;
  const { error } = await window.supabase.from('inventory_merch_counts').upsert(
    ids.map((id) => ({ variant_id: id, counted_on: sending[id].day, counted_at: sending[id].at, unit_count: sending[id].n, counted_by: window.currentStaff.id, source: 'app' })),
    { onConflict: 'variant_id,counted_on' });
  if (!error) {
    // Only clear the ones that weren't changed again while this was in flight.
    const queue = mMerchQueue();
    ids.forEach((id) => { if (queue[id] && queue[id].at === sending[id].at) delete queue[id]; });
    writeJson(M_MERCH_QUEUE_KEY, queue);
  }
  mMerchFlushing = false;
  renderInvSyncStatus();
  if (!error && mMerchPending()) mMerchFlush();
}

window.addEventListener('online', mMerchFlush);
