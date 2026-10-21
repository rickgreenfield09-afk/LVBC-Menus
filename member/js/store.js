// store.js (member app)
// Page: #tab-store — one-off things for sale (event tickets, merch
// pre-orders; migration_046) and the member's own tickets.
//
// "Available Now" comes from store_catalog() (items on sale, with how many
// are gone). Buying uses Stripe's Embedded Checkout, like the Membership
// page: /api/store-checkout holds the stock, works out the price (members
// get their tier's merch discount) and returns the client secret. The
// order is marked paid by Stripe's webhook a moment after payment, so
// after Checkout completes this page polls for it.
//
// "My Tickets" lists the member's paid orders (RLS shows only their own).
// Each has a QR code carrying its ticket_token; staff scan it in the
// Payments screen to admit people or hand over merch.
// Depends on: window.supabase, window.currentMember, toast(), escHtml(),
// money(), fmtDate() (core.js); apiPost(), loadStripeJs() (membership.js);
// QRCode (qrcodejs, loaded in index.html)

let storeCheckout = null;
let storeDiscountPct = 0;   // the member's tier discount on merch
let storeFocusItem = null;  // an item to scroll to once the page has drawn (set by the Events page)

function storeEl() { return document.getElementById('store-content'); }

function destroyStoreCheckout() {
  if (storeCheckout) { storeCheckout.destroy(); storeCheckout = null; }
}

async function loadStore() {
  destroyStoreCheckout();
  storeEl().innerHTML = '<div class="empty">Loading...</div>';
  const m = window.currentMember;
  const [catalog, orders, tier] = await Promise.all([
    window.supabase.rpc('store_catalog'),
    window.supabase.from('store_orders').select('*, store_items(name, kind, event_at, pickup_notes)')
      .eq('member_id', m.id).eq('status', 'paid').order('created_at', { ascending: false }),
    window.supabase.from('tiers').select('merch_discount_pct').eq('id', m.tier_id).maybeSingle(),
  ]);
  storeDiscountPct = (tier.data && tier.data.merch_discount_pct) || 0;
  if (catalog.error || orders.error) {
    storeEl().innerHTML = '<div class="empty">Could not load the store. Try again.</div>';
    return;
  }
  const tickets = renderStoreTickets(orders.data);
  storeEl().innerHTML = tickets + renderStoreItems(catalog.data, !tickets);
  orders.data.forEach(drawTicketQr);
  if (storeFocusItem) {
    const el = document.getElementById('store-item-' + storeFocusItem);
    storeFocusItem = null;
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

// Called from the Events page: open the store at one item.
function openStoreItem(itemId) {
  storeFocusItem = itemId;
  showTab('store');
}

// ── MY TICKETS ───────────────────────────────────────────
function renderStoreTickets(orders) {
  if (!orders.length) return '';
  return '<div class="events-section-label" style="margin-top:0;">My Tickets &amp; Orders</div>' + orders.map((o) => {
    const item = o.store_items || {};
    const left = o.quantity - o.fulfilled_qty;
    const verb = item.kind === 'event' ? 'admitted' : 'picked up';
    return '<div class="plan-card">'
      + '<div class="plan-name">' + escHtml(item.name || '') + '</div>'
      + '<p class="plan-note" style="margin-top:2px;">' + o.quantity + (item.kind === 'event' ? (o.quantity === 1 ? ' ticket' : ' tickets') : ' &times; ordered')
      + (item.event_at ? ' &middot; ' + escHtml(fmtDate(item.event_at)) : '') + '</p>'
      + (item.pickup_notes ? '<p class="plan-note">' + escHtml(item.pickup_notes) + '</p>' : '')
      + '<p class="plan-note"><strong>' + o.fulfilled_qty + ' of ' + o.quantity + '</strong> ' + verb + (left ? '' : ' — all done') + '</p>'
      + (left ? '<button class="btn btn-secondary" onclick="toggleTicketQr(\'' + o.id + '\')">Show Ticket</button>'
        + '<div id="ticket-qr-' + o.id + '" class="ticket-qr" style="display:none;"></div>' : '')
      + '</div>';
  }).join('');
}

function toggleTicketQr(orderId) {
  const el = document.getElementById('ticket-qr-' + orderId);
  el.style.display = el.style.display === 'none' ? 'block' : 'none';
}

function drawTicketQr(o) {
  if (o.quantity - o.fulfilled_qty <= 0) return;
  const el = document.getElementById('ticket-qr-' + o.id);
  if (!el) return;
  el.innerHTML = '<div class="qr-container"><div id="ticket-qr-img-' + o.id + '"></div></div><p class="plan-note" style="text-align:center;">Show this at the door or the bar.</p>';
  new QRCode(document.getElementById('ticket-qr-img-' + o.id), {
    text: o.ticket_token, width: 180, height: 180,
    colorDark: '#000000', colorLight: '#ffffff', correctLevel: QRCode.CorrectLevel.M,
  });
}

// ── AVAILABLE NOW ────────────────────────────────────────
function memberDiscountPct(item) { return item.kind === 'merch' ? storeDiscountPct : 0; }

function renderStoreItems(items, first) {
  const head = '<div class="events-section-label"' + (first ? ' style="margin-top:0;"' : '') + '>Available Now</div>';
  if (!items.length) return head + '<div class="empty">Nothing on sale right now.</div>';
  return head + items.map((i) => {
    const left = i.quantity_limit ? Math.max(i.quantity_limit - i.sold, 0) : null;
    const maxQty = Math.min(i.max_per_order, left === null ? i.max_per_order : left);
    const pct = memberDiscountPct(i);
    const price = pct ? Math.round(i.price_cents * (100 - pct) / 100) : i.price_cents;
    const options = Array.from({ length: maxQty }, (_, n) => '<option value="' + (n + 1) + '">' + (n + 1) + '</option>').join('');
    return '<div class="plan-card" id="store-item-' + i.id + '">'
      + (i.image_urls && i.image_urls.length ? '<div class="item-imgs">' + i.image_urls.map((u) => '<img src="' + escHtml(u) + '" alt="">').join('') + '</div>' : '')
      + '<div class="plan-name">' + escHtml(i.name) + '</div>'
      + '<div class="plan-price">' + money(price / 100)
      + (pct ? '<small> member price (<s>' + money(i.price_cents / 100) + '</s>)</small>' : '<small> each' + (i.taxable ? ' + tax' : '') + '</small>') + '</div>'
      + (i.description ? '<p class="plan-intro" style="margin-bottom:10px;">' + escHtml(i.description) + '</p>' : '')
      + (i.event_at ? '<p class="plan-note" style="margin-top:0;">' + escHtml(fmtDate(i.event_at)) + '</p>' : '')
      + (i.pickup_notes ? '<p class="plan-note">' + escHtml(i.pickup_notes) + '</p>' : '')
      + (left !== null ? '<p class="plan-note">' + (left > 0 ? left + ' left' : 'Sold out') + '</p>' : '')
      + (maxQty > 0
        ? '<div class="form-group" style="margin-top:12px;"><label class="form-label" for="store-qty-' + i.id + '">' + (i.kind === 'event' ? 'Tickets' : 'Quantity') + '</label>'
          + '<select id="store-qty-' + i.id + '">' + options + '</select></div>'
          + '<button class="btn btn-primary" onclick="startStoreCheckout(\'' + i.id + '\')">Buy</button>'
        : '')
      + '</div>';
  }).join('');
}

// ── CHECKOUT ─────────────────────────────────────────────
async function startStoreCheckout(itemId) {
  const quantity = +document.getElementById('store-qty-' + itemId).value;
  storeEl().innerHTML = '<div class="empty">Preparing checkout...</div>';
  try {
    await loadStripeJs();
    const { clientSecret, publishableKey, orderId } = await apiPost('/api/store-checkout', { item_id: itemId, quantity });
    storeEl().innerHTML =
      '<button class="btn-ghost" onclick="loadStore()">&larr; Back to store</button>'
      + '<div id="store-checkout-mount" class="checkout-mount"></div>';
    const stripe = window.Stripe(publishableKey);
    storeCheckout = await stripe.initEmbeddedCheckout({
      fetchClientSecret: async () => clientSecret,
      onComplete: () => waitForOrder(orderId),
    });
    storeCheckout.mount('#store-checkout-mount');
  } catch (err) {
    toast(err.message, true);
    loadStore();
  }
}

// Payment is done; the webhook marks the order paid a moment later.
async function waitForOrder(orderId) {
  destroyStoreCheckout();
  storeEl().innerHTML = '<div class="empty">Payment received. Getting your ticket...</div>';
  for (let i = 0; i < 20; i++) {
    const { data } = await window.supabase.from('store_orders').select('status').eq('id', orderId).maybeSingle();
    if (data && data.status === 'paid') { toast('You\'re all set!'); loadStore(); return; }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  storeEl().innerHTML = '<div class="empty">Your payment went through. Your ticket will show up here shortly. Check back in a minute.</div>';
}
