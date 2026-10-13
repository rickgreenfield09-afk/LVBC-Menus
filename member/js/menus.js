// menus.js (member app)
// Pages: #tab-tap (On Tap) and #tab-events.
//
// Both are read-only views of what staff already maintain on the
// staff panel's Menus and Schedule screens — nothing is kept twice.
//
//   On Tap   Beer   beers, active only, new releases first
//            Wine   wine_menu's 'Wine by the Glass' / 'Wine by the Bottle'
//            Coffee coffee_menu — one row per size, grouped per drink
//            N/A    wine_menu's 'N/A Beer' / 'N/A Options' groups
//   Events   member_upcoming_events(): one-off events plus recurring
//            ones (weekly trivia, ...) expanded into dates, 60 days out
//
// 'off' and 'archived' menu items are hidden, same as the printed menus.
// Depends on: window.supabase, escHtml(), fmtTime(), money() (core.js)

const WINE_GROUPS = ['Wine by the Glass', 'Wine by the Bottle'];
const NA_GROUPS = ['N/A Beer', 'N/A Options'];
const EVENT_TYPE_LABELS = { trivia: 'Trivia Night', bingo: 'Music Bingo', karaoke: 'Karaoke', special: 'Special Event', market: 'Farmers Market', foodtruck: 'Food Truck', vfw: 'VFW Night' };

let tapView = 'beer';
let tapData = null;

// ── ON TAP ───────────────────────────────────────────────
async function loadTapList() {
  const sb = window.supabase;
  const [beers, wine, coffee] = await Promise.all([
    sb.from('beers').select('name, style, abv, description, image_url, badges, category').eq('status', 'active').order('name'),
    sb.from('wine_menu').select('name, winery, type, display_group, description, price_glass, price_bottle').eq('status', 'active').order('sort_order'),
    sb.from('coffee_menu').select('drink_name, size_label, price, description').eq('status', 'active').order('sort_order'),
  ]);
  tapData = { beers: beers.data || [], wine: wine.data || [], coffee: coffee.data || [] };
  setTapView(tapView);
}

function setTapView(view) {
  tapView = view;
  ['beer', 'wine', 'coffee', 'na'].forEach((v) => document.getElementById('tap-btn-' + v).classList.toggle('active', v === view));
  if (!tapData) return;
  const html = { beer: beerListHtml, wine: () => wineGroupsHtml(WINE_GROUPS, '🍷'), coffee: coffeeListHtml, na: () => wineGroupsHtml(NA_GROUPS, '🥤') }[view]();
  document.getElementById('tap-view').innerHTML = html || '<div class="empty">Nothing on this menu right now</div>';
}

function menuCard(o) {
  return '<div class="beer-card' + (o.highlight ? ' new-release' : '') + '"><div class="beer-card-header"><div class="beer-card-left">'
    + (o.image ? '<img class="beer-thumb" src="' + escHtml(o.image) + '" alt="">' : '<div class="beer-thumb-placeholder">' + o.icon + '</div>')
    + '<div><div class="beer-name">' + escHtml(o.name) + (o.tag || '') + '</div>'
    + (o.sub ? '<div class="beer-style">' + escHtml(o.sub) + '</div>' : '') + '</div></div>'
    + (o.right ? '<div class="beer-abv">' + escHtml(o.right) + '</div>' : '') + '</div>'
    + (o.desc ? '<div class="beer-desc">' + escHtml(o.desc) + '</div>' : '') + (o.extra || '') + '</div>';
}

function beerListHtml() {
  const isNew = (b) => ((b.badges || []).includes('new_release') ? 1 : 0);
  return tapData.beers.slice().sort((a, b) => isNew(b) - isNew(a)).map((b) => menuCard({
    icon: '🍺', image: b.image_url, name: b.name, sub: b.style, desc: b.description, highlight: isNew(b),
    tag: isNew(b) ? '<span class="badge-new">New Release</span>' : b.category === 'Non-Alcoholic' ? ' <span class="badge-na">N/A</span>' : '',
    right: b.abv ? Number(b.abv) + '%' : '',
  })).join('');
}

function wineGroupsHtml(groups, icon) {
  return groups.map((g) => {
    const rows = tapData.wine.filter((w) => w.display_group === g);
    if (!rows.length) return '';
    return '<div class="section-header">' + escHtml(g) + '</div>' + rows.map((w) => {
      const prices = [];
      if (w.price_glass) prices.push('Glass ' + money(w.price_glass));
      if (w.price_bottle) prices.push('Bottle ' + money(w.price_bottle));
      return menuCard({
        icon, name: w.name, sub: [w.winery, w.type].filter(Boolean).join(' · '), desc: w.description,
        extra: prices.length ? '<div class="wine-price">' + prices.join(' · ') + '</div>' : '',
      });
    }).join('');
  }).join('');
}

function coffeeListHtml() {
  const drinks = [];
  tapData.coffee.forEach((c) => {
    let d = drinks.find((x) => x.name === c.drink_name);
    if (!d) drinks.push(d = { name: c.drink_name, desc: c.description, sizes: [] });
    d.sizes.push(c);
  });
  return drinks.map((d) => menuCard({
    icon: '☕', name: d.name, desc: d.desc,
    extra: '<div class="coffee-sizes">' + d.sizes.map((s) => '<span>' + escHtml(s.size_label) + '<b>' + money(s.price) + '</b></span>').join('') + '</div>',
  })).join('');
}

// ── EVENTS ───────────────────────────────────────────────
function eventCardHtml(e) {
  const d = new Date(e.event_date + 'T12:00:00');
  const type = EVENT_TYPE_LABELS[e.event_type] || '';
  const meta = [d.toLocaleDateString('en-US', { weekday: 'long' }), fmtTime(e.start_time) + (e.end_time ? ' – ' + fmtTime(e.end_time) : '')].filter(Boolean).join(' · ');
  return '<div class="event-card"><div class="event-date-block">'
    + '<div class="event-month">' + d.toLocaleDateString('en-US', { month: 'short' }) + '</div><div class="event-day">' + d.getDate() + '</div></div>'
    + '<div class="event-details"><div class="event-title">' + escHtml(e.name) + '</div>'
    + '<div class="event-meta">' + escHtml(meta) + '</div>'
    + (type && type !== e.name ? '<div class="event-meta">' + escHtml(type) + '</div>' : '')
    + (e.points ? '<div class="event-pts">+' + e.points + ' pts for attending</div>' : '')
    + (e.is_beer_release ? '<span class="event-release-badge">Beer Release</span>' : '') + '</div></div>';
}

async function loadEvents() {
  const { data, error } = await window.supabase.rpc('member_upcoming_events', { p_days: 60 });
  const soonEl = document.getElementById('events-soon-list');
  const laterEl = document.getElementById('events-later-list');
  if (error) { soonEl.innerHTML = '<div class="empty">Could not load events</div>'; laterEl.innerHTML = ''; return; }

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() + 14);
  const cut = cutoff.getFullYear() + '-' + String(cutoff.getMonth() + 1).padStart(2, '0') + '-' + String(cutoff.getDate()).padStart(2, '0');
  const soon = data.filter((e) => e.event_date <= cut);
  // further out, the weekly regulars would just repeat — show the one-offs
  const later = data.filter((e) => e.event_date > cut && !e.recurring);
  soonEl.innerHTML = soon.length ? soon.map(eventCardHtml).join('') : '<div class="empty">Nothing scheduled in the next two weeks</div>';
  laterEl.innerHTML = later.length ? later.map(eventCardHtml).join('') : '<div class="empty">No special events scheduled yet</div>';
}
