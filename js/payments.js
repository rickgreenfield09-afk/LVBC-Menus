// payments.js
// Screen: #screen-payments — what we sell for money, and who has paid.
//
//   Orders        everyone who bought a ticket or a pre-order, with
//                 check-in (admit people / hand over units) and a ticket
//                 scanner; ring up a sale taken at the Toast register
//   Items         the one-off catalog: events and merch pre-orders
//   Memberships   the Mug Club plans and who is subscribed
//   Settings      sales tax rate and the member merch discount
//
// The store (migration_046) lives in our own tables; Stripe is asked to
// charge only at checkout, so adding an item here needs nothing done in
// the Stripe dashboard. Orders are never written from here directly:
// check-in, Toast sales and refund marks go through store_redeem(),
// store_record_toast_sale() and store_set_order_status(). Only admins
// can add or change items, plans and settings (RLS enforces it; the
// forms are hidden for everyone else).
//
// Membership plans are priced in Stripe (migration_045): this screen
// shows them and can switch one on or off, but a price change means a new
// plan row plus scripts/stripe-sync-plans.mjs.
// Depends on: window.supabase, window.currentStaff, toast() (app-core.js),
// escHtml() (menu.js), memLoadZxing() (members.js)

const PAY_VIEWS = ['orders', 'items', 'plans', 'settings'];
const PAY_STATUS_BADGE = { paid: 'badge-teal', pending: 'badge-amber', refunded: 'badge-red', canceled: 'badge-muted' };

let payView = 'orders';
let payItems = [];
let payOrders = [];
let payFilterItem = '';
let payFilterText = '';
let payEditItem = null;   // the item open in the form, or null for a new one
let payTicket = null;     // the order a scan just found
let payScanner = null;

function payIsAdmin() { return !!(window.currentStaff && window.currentStaff.role === 'admin'); }
function payMoney(cents) { return '$' + (Number(cents || 0) / 100).toFixed(2); }
function payDate(d) { return d ? new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—'; }
function payField(label, inner, full) {
  return '<div class="admin-field"' + (full ? ' style="grid-column:1/-1;"' : '') + '><label class="admin-label">' + label + '</label>' + inner + '</div>';
}
function payBody(html) { document.getElementById('pay-body').innerHTML = html; }
function payNoun(kind) { return kind === 'event' ? 'Admit' : 'Hand over'; }
// '2026-05-02T18:00:00Z' -> value for <input type="datetime-local"> in local time
function payLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

// ── ROUTER ───────────────────────────────────────────────
async function loadPayments() {
  const { data } = await window.supabase.from('store_items').select('*').order('created_at', { ascending: false });
  payItems = data || [];
  setPaymentsView(payView);
}

function setPaymentsView(view) {
  payView = view;
  PAY_VIEWS.forEach((v) => document.getElementById('pay-view-' + v).classList.toggle('active', v === view));
  ({ orders: payRenderOrders, items: payRenderItems, plans: payRenderPlans, settings: payRenderSettings })[view]();
}

// ── ORDERS ───────────────────────────────────────────────
async function payRenderOrders() {
  payBody('<div class="loading">Loading...</div>');
  const { data, error } = await window.supabase.from('store_orders')
    .select('*, store_items(name, kind)').neq('status', 'pending').order('created_at', { ascending: false }).limit(500);
  if (payView !== 'orders') return;
  if (error) { payBody('<div class="loading">Could not load orders.</div>'); return; }
  payOrders = data;
  payDrawOrders();
}

function payOrderMatches(o) {
  if (payFilterItem && o.item_id !== payFilterItem) return false;
  const t = payFilterText.trim().toLowerCase();
  return !t || o.buyer_name.toLowerCase().includes(t) || (o.buyer_email || '').toLowerCase().includes(t);
}

function payDrawOrders() {
  const rows = payOrders.filter(payOrderMatches);
  const paid = rows.filter((o) => o.status === 'paid');
  const units = paid.reduce((n, o) => n + o.quantity, 0);
  const done = paid.reduce((n, o) => n + o.fulfilled_qty, 0);
  const revenue = paid.reduce((n, o) => n + (o.total_cents || 0), 0);

  const ticket = payTicket ? payTicketCard(payTicket) : '';
  const list = rows.length ? '<div class="table-wrap">' + rows.map(payOrderRow).join('') + '</div>' : '<div class="loading">No orders yet</div>';

  payBody(
    '<div class="grid-4">'
    + '<div class="card"><div class="card-title">Sold</div><div class="card-value teal">' + units + '</div><div class="card-sub">tickets / units</div></div>'
    + '<div class="card"><div class="card-title">Collected</div><div class="card-value amber">' + payMoney(revenue) + '</div><div class="card-sub">incl. tax</div></div>'
    + '<div class="card"><div class="card-title">Checked In</div><div class="card-value">' + done + '</div><div class="card-sub">of ' + units + '</div></div>'
    + '<div class="card"><div class="card-title">Orders</div><div class="card-value">' + paid.length + '</div><div class="card-sub">paid</div></div>'
    + '</div>'
    + '<div class="lookup-toolbar">'
    + '<select class="admin-select" style="max-width:240px;" onchange="payFilterItem = this.value; payDrawOrders()"><option value="">All items</option>'
    + payItems.map((i) => '<option value="' + i.id + '"' + (i.id === payFilterItem ? ' selected' : '') + '>' + escHtml(i.name) + '</option>').join('') + '</select>'
    + '<input class="search-bar" type="text" id="pay-search" placeholder="Search by name or email..." value="' + escHtml(payFilterText) + '" oninput="payFilterText = this.value; payDrawOrders(); payRefocusSearch()">'
    + '<button class="btn btn-scan" onclick="payOpenScanner()">Scan Ticket</button>'
    + '</div>'
    + ticket
    + list
    + '<div class="section-label">Record a Toast Sale</div>' + payToastForm());
}

function payRefocusSearch() {
  const el = document.getElementById('pay-search');
  if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
}

function payOrderRow(o) {
  const item = o.store_items || {};
  const left = o.quantity - o.fulfilled_qty;
  const actions = o.status === 'paid'
    ? (left > 0 ? '<button class="btn btn-sm btn-primary" onclick="payRedeem(\'' + o.id + '\', 1)">' + payNoun(item.kind) + ' 1</button>'
      + (left > 1 ? '<button class="btn btn-sm btn-secondary" onclick="payRedeem(\'' + o.id + '\', ' + left + ')">All ' + left + '</button>' : '') : '<span class="badge badge-teal">Done</span>')
      + (payIsAdmin() ? '<button class="btn btn-sm btn-secondary" onclick="payMarkRefunded(\'' + o.id + '\')">Refunded</button>' : '')
    : '';
  return '<div class="reward-admin-row"' + (o.status === 'paid' ? '' : ' style="opacity:0.55;"') + '><div style="min-width:0;">'
    + '<div style="font-weight:500;font-size:13px;">' + escHtml(o.buyer_name) + ' <span class="badge ' + (PAY_STATUS_BADGE[o.status] || 'badge-muted') + '">' + o.status + '</span>'
    + (o.source === 'toast' ? ' <span class="badge badge-purple">Toast</span>' : '') + '</div>'
    + '<div style="font-size:11px;color:var(--muted);font-family:\'DM Mono\',monospace;margin-top:2px;">'
    + escHtml(item.name || '') + ' · ×' + o.quantity + ' · ' + payMoney(o.total_cents) + ' · ' + payDate(o.created_at)
    + (o.buyer_email ? ' · ' + escHtml(o.buyer_email) : '') + '</div></div>'
    + '<div style="display:flex;align-items:center;gap:8px;">'
    + '<span class="scoring-desc">' + o.fulfilled_qty + ' / ' + o.quantity + '</span>' + actions + '</div></div>';
}

function payTicketCard(o) {
  const item = o.store_items || {};
  const left = o.quantity - o.fulfilled_qty;
  return '<div class="card" style="border-color:var(--teal);margin-bottom:16px;">'
    + '<div class="card-title">Ticket — ' + escHtml(item.name || '') + '</div>'
    + '<div style="font-size:18px;font-weight:600;margin:4px 0;">' + escHtml(o.buyer_name) + '</div>'
    + '<div class="card-sub">' + (o.status === 'paid' ? '<strong>' + left + ' of ' + o.quantity + '</strong> still to ' + (item.kind === 'event' ? 'admit' : 'hand over') : 'This order is ' + o.status) + '</div>'
    + '<div style="display:flex;gap:8px;margin-top:12px;">'
    + (o.status === 'paid' && left > 0 ? '<button class="btn btn-primary" onclick="payRedeem(\'' + o.id + '\', 1)">' + payNoun(item.kind) + ' 1</button>'
      + (left > 1 ? '<button class="btn btn-secondary" style="margin-top:0;" onclick="payRedeem(\'' + o.id + '\', ' + left + ')">All ' + left + '</button>' : '') : '')
    + '<button class="btn btn-secondary" style="margin-top:0;" onclick="payTicket = null; payDrawOrders()">Dismiss</button></div></div>';
}

async function payRedeem(orderId, qty) {
  const { data, error } = await window.supabase.rpc('store_redeem', { p_order: orderId, p_qty: qty });
  if (error) { toast(error.message, true); return; }
  toast(qty === 1 ? 'Done' : qty + ' done');
  const idx = payOrders.findIndex((o) => o.id === orderId);
  if (idx >= 0) payOrders[idx] = { ...payOrders[idx], ...data };
  if (payTicket && payTicket.id === orderId) payTicket = { ...payTicket, ...data };
  payDrawOrders();
}

async function payMarkRefunded(orderId) {
  if (!confirm('Mark this order refunded? It frees the stock. Refund the money itself in Stripe.')) return;
  const { error } = await window.supabase.rpc('store_set_order_status', { p_order: orderId, p_status: 'refunded' });
  if (error) { toast(error.message, true); return; }
  toast('Marked refunded');
  payRenderOrders();
}

function payToastForm() {
  const open = payItems.filter((i) => i.is_active);
  if (!open.length) return '<div class="card-sub">Add an item first.</div>';
  return '<div class="card"><div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">'
    + payField('Item', '<select class="admin-select" id="pay-ts-item">' + open.map((i) => '<option value="' + i.id + '">' + escHtml(i.name) + ' — ' + payMoney(i.price_cents) + '</option>').join('') + '</select>', true)
    + payField('Buyer Name', '<input class="admin-input" type="text" id="pay-ts-name">')
    + payField('Email (optional)', '<input class="admin-input" type="email" id="pay-ts-email">')
    + payField('Quantity', '<input class="admin-input" type="number" min="1" value="1" id="pay-ts-qty">')
    + payField('Total Paid (optional)', '<input class="admin-input" type="number" step="0.01" min="0" id="pay-ts-total" placeholder="price × quantity">')
    + payField('Note', '<input class="admin-input" type="text" id="pay-ts-note" placeholder="e.g. Toast check #1234">', true)
    + '</div><button class="btn btn-primary" onclick="payRecordToast()">Record Sale</button></div>';
}

async function payRecordToast() {
  const total = document.getElementById('pay-ts-total').value;
  const { error } = await window.supabase.rpc('store_record_toast_sale', {
    p_item: document.getElementById('pay-ts-item').value,
    p_qty: +document.getElementById('pay-ts-qty').value,
    p_name: document.getElementById('pay-ts-name').value,
    p_email: document.getElementById('pay-ts-email').value,
    p_member: null,
    p_total_cents: total === '' ? null : Math.round(+total * 100),
    p_note: document.getElementById('pay-ts-note').value || null,
  });
  if (error) { toast(error.message, true); return; }
  toast('Sale recorded');
  payRenderOrders();
}

// ── TICKET SCANNER ───────────────────────────────────────
async function payOpenScanner() {
  let overlay = document.getElementById('pay-scanner');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'pay-scanner';
    overlay.className = 'scanner-overlay';
    overlay.innerHTML = '<div class="scanner-box"><video id="pay-scanner-video" autoplay playsinline muted></video>'
      + '<div class="scanner-corner tl"></div><div class="scanner-corner tr"></div><div class="scanner-corner bl"></div><div class="scanner-corner br"></div><div class="scanner-line"></div></div>'
      + '<div class="scanner-label">POINT AT TICKET QR CODE</div><div class="scanner-status" id="pay-scanner-status"></div>'
      + '<div class="scanner-btn-row"><button class="btn-cancel" onclick="payCloseScanner()">Cancel</button></div>';
    document.body.appendChild(overlay);
  }
  overlay.classList.add('active');
  const status = document.getElementById('pay-scanner-status');
  status.textContent = 'Starting camera...';
  try {
    await memLoadZxing();
    payScanner = new ZXing.BrowserQRCodeReader();
    status.textContent = 'Ready — point at QR code';
    payScanner.decodeFromVideoDevice(null, 'pay-scanner-video', (result) => { if (result) payScanned(result.getText()); });
  } catch (e) {
    status.textContent = 'Could not start the camera';
  }
}

let payScanBusy = false;
async function payScanned(token) {
  if (payScanBusy) return;
  payScanBusy = true;
  const status = document.getElementById('pay-scanner-status');
  status.textContent = 'Looking up ticket...';
  const { data } = await window.supabase.from('store_orders').select('*, store_items(name, kind)').eq('ticket_token', token.trim()).maybeSingle();
  payScanBusy = false;
  if (!data) { status.textContent = 'Ticket not recognized — try again'; return; }
  payCloseScanner();
  payTicket = data;
  if (payView !== 'orders') setPaymentsView('orders'); else payDrawOrders();
}

function payCloseScanner() {
  if (payScanner) { try { payScanner.reset(); } catch (e) { /* camera already released */ } payScanner = null; }
  const overlay = document.getElementById('pay-scanner');
  if (overlay) overlay.classList.remove('active');
}

// ── ITEMS ────────────────────────────────────────────────
async function payRenderItems() {
  const { data } = await window.supabase.from('store_orders').select('item_id, quantity').eq('status', 'paid');
  if (payView !== 'items') return;
  const sold = {};
  (data || []).forEach((o) => { sold[o.item_id] = (sold[o.item_id] || 0) + o.quantity; });

  const list = payItems.length ? '<div class="table-wrap">' + payItems.map((i) =>
    '<div class="reward-admin-row"' + (i.is_active ? '' : ' style="opacity:0.5;"') + '><div style="min-width:0;">'
    + '<div style="font-weight:500;font-size:13px;">' + escHtml(i.name) + ' <span class="badge ' + (i.kind === 'event' ? 'badge-purple' : 'badge-amber') + '">' + (i.kind === 'event' ? 'Event' : 'Merch') + '</span>'
    + (i.taxable ? ' <span class="badge badge-muted">+ tax</span>' : '') + '</div>'
    + '<div style="font-size:11px;color:var(--muted);font-family:\'DM Mono\',monospace;margin-top:2px;">' + payMoney(i.price_cents)
    + ' · sold ' + (sold[i.id] || 0) + (i.quantity_limit ? ' / ' + i.quantity_limit : '')
    + (i.event_at ? ' · ' + payDate(i.event_at) : '') + '</div></div>'
    + '<div style="display:flex;gap:8px;">'
    + (payIsAdmin() ? '<button class="btn btn-sm btn-secondary" onclick="payToggleItem(\'' + i.id + '\')">' + (i.is_active ? 'Hide' : 'Show') + '</button>'
      + '<button class="btn btn-sm btn-secondary" onclick="payEditItemOpen(\'' + i.id + '\')">Edit</button>' : '')
    + '</div></div>').join('') + '</div>' : '<div class="loading">No items yet</div>';

  payBody(list + (payIsAdmin() ? payItemForm() : '<div class="card-sub" style="margin-top:12px;">Only admins can add or change items.</div>'));
}

function payItemForm() {
  const i = payEditItem || { kind: 'event', name: '', description: '', price_cents: '', taxable: false, quantity_limit: '', max_per_order: 10, event_at: null, sales_close_at: null, pickup_notes: '', is_active: true };
  return '<div class="section-label">' + (payEditItem ? 'Edit Item' : 'Add Item') + '</div><div class="card"><div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">'
    + payField('Name', '<input class="admin-input" type="text" id="pay-i-name" value="' + escHtml(i.name) + '" placeholder="e.g. Maifest Stein Pre-Order">', true)
    + payField('Type', '<select class="admin-select" id="pay-i-kind"><option value="event"' + (i.kind === 'event' ? ' selected' : '') + '>Event (tickets)</option><option value="merch"' + (i.kind === 'merch' ? ' selected' : '') + '>Merch (pre-order)</option></select>')
    + payField('Price ($ each)', '<input class="admin-input" type="number" step="0.01" min="0.5" id="pay-i-price" value="' + (i.price_cents === '' ? '' : (i.price_cents / 100).toFixed(2)) + '">')
    + payField('Quantity Available', '<input class="admin-input" type="number" min="1" id="pay-i-limit" value="' + (i.quantity_limit || '') + '" placeholder="unlimited">')
    + payField('Max Per Order', '<input class="admin-input" type="number" min="1" id="pay-i-max" value="' + i.max_per_order + '">')
    + payField('Event Date / Time', '<input class="admin-input" type="datetime-local" id="pay-i-event" value="' + payLocalInput(i.event_at) + '">')
    + payField('Sales Close', '<input class="admin-input" type="datetime-local" id="pay-i-close" value="' + payLocalInput(i.sales_close_at) + '">')
    + payField('Description', '<textarea class="admin-input" id="pay-i-desc" rows="2">' + escHtml(i.description || '') + '</textarea>', true)
    + payField('Pickup / Arrival Notes', '<input class="admin-input" type="text" id="pay-i-pickup" value="' + escHtml(i.pickup_notes || '') + '" placeholder="e.g. Pick up at the bar during Maifest">', true)
    + '</div>'
    + '<div class="checkbox-row"><input type="checkbox" id="pay-i-tax"' + (i.taxable ? ' checked' : '') + '><label for="pay-i-tax">Charge sales tax (merch)</label></div>'
    + '<div class="checkbox-row"><input type="checkbox" id="pay-i-active"' + (i.is_active ? ' checked' : '') + '><label for="pay-i-active">On sale</label></div>'
    + '<div style="display:flex;gap:8px;"><button class="btn btn-primary" onclick="paySaveItem()">' + (payEditItem ? 'Save Changes' : 'Add Item') + '</button>'
    + (payEditItem ? '<button class="btn btn-secondary" onclick="payEditItem = null; payRenderItems()">Cancel</button>' : '') + '</div></div>';
}

function payEditItemOpen(id) {
  payEditItem = payItems.find((i) => i.id === id) || null;
  payRenderItems();
  document.getElementById('pay-body').scrollTop = 1e6;
  window.scrollTo(0, document.body.scrollHeight);
}

async function paySaveItem() {
  const v = (id) => document.getElementById(id).value;
  const name = v('pay-i-name').trim();
  const price = Math.round(parseFloat(v('pay-i-price')) * 100);
  if (!name) { toast('Enter a name.', true); return; }
  if (!(price >= 50)) { toast('Enter a price of at least $0.50.', true); return; }
  const row = {
    kind: v('pay-i-kind'), name, price_cents: price,
    description: v('pay-i-desc').trim() || null,
    taxable: document.getElementById('pay-i-tax').checked,
    quantity_limit: v('pay-i-limit') ? +v('pay-i-limit') : null,
    max_per_order: +v('pay-i-max') || 10,
    event_at: v('pay-i-event') ? new Date(v('pay-i-event')).toISOString() : null,
    sales_close_at: v('pay-i-close') ? new Date(v('pay-i-close')).toISOString() : null,
    pickup_notes: v('pay-i-pickup').trim() || null,
    is_active: document.getElementById('pay-i-active').checked,
  };
  const q = payEditItem ? window.supabase.from('store_items').update(row).eq('id', payEditItem.id) : window.supabase.from('store_items').insert(row);
  const { error } = await q;
  if (error) { toast(error.message, true); return; }
  toast(payEditItem ? 'Item saved' : 'Item added');
  payEditItem = null;
  loadPayments();
}

async function payToggleItem(id) {
  const item = payItems.find((i) => i.id === id);
  const { error } = await window.supabase.from('store_items').update({ is_active: !item.is_active }).eq('id', id);
  if (error) { toast(error.message, true); return; }
  loadPayments();
}

// ── MEMBERSHIPS ──────────────────────────────────────────
async function payRenderPlans() {
  payBody('<div class="loading">Loading...</div>');
  const [plans, subs] = await Promise.all([
    window.supabase.from('membership_plans').select('*, tiers(name)').order('sort_order'),
    window.supabase.from('member_subscriptions').select('*, members(name, email), membership_plans(billing_interval, tiers(name))')
      .in('status', ['active', 'trialing', 'past_due']).order('current_period_end'),
  ]);
  if (payView !== 'plans') return;
  const count = {};
  (subs.data || []).forEach((s) => { count[s.plan_id] = (count[s.plan_id] || 0) + 1; });

  const planRows = (plans.data || []).length ? '<div class="table-wrap">' + plans.data.map((p) =>
    '<div class="reward-admin-row"' + (p.is_active ? '' : ' style="opacity:0.5;"') + '><div style="min-width:0;">'
    + '<div style="font-weight:500;font-size:13px;">' + escHtml(p.tiers.name) + ' — ' + (p.billing_interval === 'year' ? 'Annual' : 'Monthly')
    + (p.stripe_price_id ? '' : ' <span class="badge badge-amber">Not in Stripe yet</span>') + '</div>'
    + '<div style="font-size:11px;color:var(--muted);font-family:\'DM Mono\',monospace;margin-top:2px;">' + payMoney(p.price_cents) + ' · ' + (count[p.id] || 0) + ' subscribed'
    + (p.stripe_price_id ? ' · ' + escHtml(p.stripe_price_id) : '') + '</div></div>'
    + (payIsAdmin() ? '<button class="btn btn-sm btn-secondary" onclick="payTogglePlan(\'' + p.id + '\', ' + !p.is_active + ')">' + (p.is_active ? 'Disable' : 'Enable') + '</button>' : '')
    + '</div>').join('') + '</div>' : '<div class="loading">No plans yet</div>';

  const subRows = (subs.data || []).length ? '<div class="table-wrap">' + subs.data.map((s) =>
    '<div class="reward-admin-row"><div><div style="font-weight:500;font-size:13px;">' + escHtml(s.members ? s.members.name : '—')
    + ' <span class="badge ' + (s.status === 'past_due' ? 'badge-red' : 'badge-teal') + '">' + s.status.replace('_', ' ') + '</span>'
    + (s.cancel_at_period_end ? ' <span class="badge badge-amber">Ends ' + payDate(s.current_period_end) + '</span>' : '') + '</div>'
    + '<div style="font-size:11px;color:var(--muted);font-family:\'DM Mono\',monospace;margin-top:2px;">'
    + (s.membership_plans ? escHtml(s.membership_plans.tiers.name) + ' · ' + (s.membership_plans.billing_interval === 'year' ? 'annual' : 'monthly') : '')
    + ' · ' + (s.cancel_at_period_end ? 'ends' : 'renews') + ' ' + payDate(s.current_period_end) + '</div></div></div>').join('') + '</div>' : '<div class="loading">No subscribers yet</div>';

  payBody('<div class="section-label" style="margin-top:0;">Plans</div>' + planRows
    + '<div class="card-sub" style="margin-top:8px;">Prices are set in Stripe. To change one, add a new plan and run the plan sync script.</div>'
    + '<div class="section-label">Subscribers</div>' + subRows);
}

async function payTogglePlan(id, active) {
  const { error } = await window.supabase.from('membership_plans').update({ is_active: active }).eq('id', id);
  if (error) { toast(error.message, true); return; }
  payRenderPlans();
}

// ── SETTINGS ─────────────────────────────────────────────
async function payRenderSettings() {
  const [settings, tiers] = await Promise.all([
    window.supabase.from('store_settings').select('sales_tax_rate').eq('id', 1).maybeSingle(),
    window.supabase.from('tiers').select('id, name, rank, merch_discount_pct').gt('rank', 0).order('rank'),
  ]);
  if (payView !== 'settings') return;
  const rate = settings.data ? Math.round(Number(settings.data.sales_tax_rate) * 100000) / 1000 : '';
  const dis = payIsAdmin() ? '' : ' disabled';
  payBody('<div class="grid-2" style="align-items:start;"><div>'
    + '<div class="section-label" style="margin-top:0;">Sales Tax</div><div class="card">'
    + '<div class="card-sub" style="margin-bottom:10px;">Added at checkout to items marked "Charge sales tax". Use your combined state + local rate.</div>'
    + payField('Rate (%)', '<input class="admin-input" type="number" step="0.001" min="0" max="30" id="pay-tax-rate" value="' + rate + '"' + dis + '>')
    + (payIsAdmin() ? '<button class="btn btn-primary" onclick="paySaveTax()">Save Rate</button>' : '') + '</div></div><div>'
    + '<div class="section-label" style="margin-top:0;">Member Merch Discount</div><div class="card">'
    + '<div class="card-sub" style="margin-bottom:10px;">Percent off merch for each membership tier, applied automatically at checkout.</div>'
    + (tiers.data || []).map((t) => payField(escHtml(t.name) + ' (%)', '<input class="admin-input" type="number" min="0" max="100" id="pay-disc-' + t.id + '" value="' + t.merch_discount_pct + '"' + dis + '>')).join('')
    + (payIsAdmin() ? '<button class="btn btn-primary" onclick="paySaveDiscounts()">Save Discounts</button>' : '') + '</div></div></div>');
}

async function paySaveTax() {
  const pct = parseFloat(document.getElementById('pay-tax-rate').value);
  if (!(pct >= 0 && pct < 30)) { toast('Enter a rate between 0 and 30.', true); return; }
  const { error } = await window.supabase.from('store_settings').update({ sales_tax_rate: Math.round(pct * 1000) / 100000 }).eq('id', 1);
  if (error) { toast(error.message, true); return; }
  toast('Tax rate saved');
}

async function paySaveDiscounts() {
  const { data: tiers } = await window.supabase.from('tiers').select('id').gt('rank', 0);
  for (const t of tiers || []) {
    const pct = Math.round(+document.getElementById('pay-disc-' + t.id).value);
    if (!(pct >= 0 && pct <= 100)) { toast('Discounts must be between 0 and 100.', true); return; }
    const { error } = await window.supabase.from('tiers').update({ merch_discount_pct: pct }).eq('id', t.id);
    if (error) { toast(error.message, true); return; }
  }
  toast('Discounts saved');
}
