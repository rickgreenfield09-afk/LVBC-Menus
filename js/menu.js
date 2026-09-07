// menu.js
// Screen: #screen-menu
// Combines the old app's "On Tap" browse screen with Admin > Beers CRUD
// into one location. Any signed-in staff can browse; add/edit/retire
// controls only render when window.currentStaff.role === 'admin'.
// Depends on: window.supabase, toast()

let menuFilter = 'ontap';
let menuCategories = [];
let menuBeers = [];
let menuEditingId = null;

function isMenuAdmin() {
  return !!(window.currentStaff && window.currentStaff.role === 'admin');
}

function numOrNull(id) {
  const val = document.getElementById(id).value;
  return val === '' ? null : parseFloat(val);
}

async function loadMenu() {
  document.getElementById('menu-admin-form-wrap').style.display = isMenuAdmin() ? 'block' : 'none';

  const [{ data: categories }, { data: beers }] = await Promise.all([
    window.supabase.from('beer_categories').select('*').order('sort_order', { ascending: true }),
    window.supabase.from('beers').select('*').order('sort_order', { ascending: true }).order('name', { ascending: true }),
  ]);

  menuCategories = categories || [];
  menuBeers = beers || [];

  if (isMenuAdmin()) populateMenuCategorySelect();
  renderMenuGrid();
}

function populateMenuCategorySelect() {
  const sel = document.getElementById('menu-beer-category');
  sel.innerHTML = menuCategories.map((c) => `<option value="${c.id}">${c.name}</option>`).join('');
}

function setMenuFilter(filter, btn) {
  menuFilter = filter;
  document.querySelectorAll('#screen-menu .tap-toggle-btn').forEach((b) => b.classList.remove('active'));
  btn.classList.add('active');
  renderMenuGrid();
}

function renderMenuGrid() {
  const grid = document.getElementById('menu-grid');
  const admin = isMenuAdmin();

  const filtered = menuBeers.filter((b) => {
    if (menuFilter === 'ontap') return b.is_on_tap && !b.retired;
    if (menuFilter === 'retired') return b.retired;
    return true;
  });

  if (!filtered.length) {
    grid.innerHTML = '<div class="loading" style="grid-column:1/-1">No beers in this view</div>';
    return;
  }

  const catName = (id) => (menuCategories.find((c) => c.id === id) || {}).name || '';

  grid.innerHTML = filtered
    .map((b) => {
      let badges = '';
      if (b.is_new_release && !b.retired) badges += '<span class="tap-badge tap-badge-new">★ New Release</span>';
      if (b.retired) badges += '<span class="tap-badge tap-badge-retired">Retired</span>';
      if (b.abv != null) badges += `<span class="tap-badge tap-badge-abv">${b.abv}% ABV</span>`;
      if (b.price != null) badges += `<span class="tap-badge tap-badge-abv">$${Number(b.price).toFixed(2)}</span>`;

      let flavorGrid = '';
      if (b.ibu != null) flavorGrid += `<div class="tap-flavor-item"><div class="tap-flavor-label">IBU</div><div class="tap-flavor-val">${b.ibu}</div></div>`;
      if (b.srm != null) flavorGrid += `<div class="tap-flavor-item"><div class="tap-flavor-label">Color (SRM)</div><div class="tap-flavor-val">${b.srm}</div></div>`;
      if (b.og != null) flavorGrid += `<div class="tap-flavor-item"><div class="tap-flavor-label">OG</div><div class="tap-flavor-val">${b.og}</div></div>`;
      if (b.fg != null) flavorGrid += `<div class="tap-flavor-item"><div class="tap-flavor-label">FG</div><div class="tap-flavor-val">${b.fg}</div></div>`;
      if (flavorGrid) flavorGrid = `<div class="tap-card-divider"></div><div class="tap-flavor-grid">${flavorGrid}</div>`;

      const thumb = b.image_url
        ? `<div class="tap-card-thumb"><img src="${b.image_url}" alt="${b.name}" onerror="this.parentElement.innerHTML='🍺'"></div>`
        : '<div class="tap-card-thumb">🍺</div>';

      const tappedOn = b.tapped_on
        ? `<div style="font-size:11px;color:var(--muted);font-family:'DM Mono',monospace;margin-top:6px">Tapped ${new Date(b.tapped_on).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</div>`
        : '';

      const cat = catName(b.category_id);
      const styleLine = [cat, b.style].filter(Boolean).join(' · ');

      let actions = '';
      if (admin) {
        const nameEsc = b.name.replace(/'/g, "\\'");
        if (!b.retired) {
          const newRelLabel = b.is_new_release ? 'Remove New Release' : '★ Mark New Release';
          actions = `<div class="tap-card-actions">
            <button class="btn-new-release-toggle" onclick="toggleMenuNewRelease('${b.id}', ${b.is_new_release})">${newRelLabel}</button>
            <button class="btn-secondary btn-sm" onclick="startMenuEdit('${b.id}')">Edit</button>
            <button class="btn-retire" onclick="retireMenuBeer('${b.id}', '${nameEsc}')">Retire</button>
          </div>`;
        } else {
          actions = `<div class="tap-card-actions">
            <button class="btn-secondary btn-sm" onclick="restoreMenuBeer('${b.id}', '${nameEsc}')">Restore</button>
          </div>`;
        }
      }

      return `<div class="tap-card${b.is_new_release && !b.retired ? ' new-release' : ''}${b.retired ? ' retired-card' : ''}">
        <div class="tap-card-inner">
          <div class="tap-card-body">
            ${badges ? `<div class="tap-card-badges">${badges}</div>` : ''}
            <div class="tap-card-name">${b.name}</div>
            ${styleLine ? `<div class="tap-card-style">${styleLine}</div>` : ''}
            ${b.description ? `<div class="tap-section-title">Description</div><div class="tap-section-text">${b.description}</div>` : ''}
            ${b.tasting_notes ? `<div class="tap-section-title">Tasting Notes</div><div class="tap-section-text">${b.tasting_notes}</div>` : ''}
            ${flavorGrid}${tappedOn}${actions}
          </div>
          ${thumb}
        </div>
      </div>`;
    })
    .join('');
}

// ── ADMIN: ADD / EDIT ────────────────────────────────────
function startMenuEdit(beerId) {
  const b = menuBeers.find((x) => x.id === beerId);
  if (!b) return;
  menuEditingId = beerId;

  document.getElementById('menu-form-title').textContent = 'Edit Beer';
  document.getElementById('menu-beer-id').value = b.id;
  document.getElementById('menu-beer-name').value = b.name || '';
  document.getElementById('menu-beer-category').value = b.category_id || '';
  document.getElementById('menu-beer-style').value = b.style || '';
  document.getElementById('menu-beer-price').value = b.price != null ? b.price : '';
  document.getElementById('menu-beer-abv').value = b.abv != null ? b.abv : '';
  document.getElementById('menu-beer-ibu').value = b.ibu != null ? b.ibu : '';
  document.getElementById('menu-beer-desc').value = b.description || '';
  document.getElementById('menu-beer-notes').value = b.tasting_notes || '';
  document.getElementById('menu-beer-img').value = b.image_url || '';
  document.getElementById('menu-beer-tapped').value = b.tapped_on ? b.tapped_on.slice(0, 10) : '';
  document.getElementById('menu-beer-release').checked = !!b.is_new_release;

  document.getElementById('menu-beer-submit').textContent = 'Save Changes';
  document.getElementById('menu-beer-cancel').style.display = 'inline-block';
  document.getElementById('menu-admin-form-wrap').scrollIntoView({ behavior: 'smooth' });
}

function cancelMenuEdit() {
  menuEditingId = null;
  document.getElementById('menu-form-title').textContent = 'Add New Beer';
  document.getElementById('menu-beer-id').value = '';
  ['menu-beer-name', 'menu-beer-style', 'menu-beer-price', 'menu-beer-abv', 'menu-beer-ibu', 'menu-beer-desc', 'menu-beer-notes', 'menu-beer-img', 'menu-beer-tapped'].forEach((id) => {
    document.getElementById(id).value = '';
  });
  document.getElementById('menu-beer-release').checked = false;
  document.getElementById('menu-beer-submit').textContent = 'Add Beer to Tap List';
  document.getElementById('menu-beer-cancel').style.display = 'none';
}

function showMenuAlert(msg, isError) {
  const el = document.getElementById('menu-beer-alert');
  el.textContent = msg;
  el.style.display = 'block';
  el.style.background = isError ? 'rgba(224,82,82,0.15)' : 'rgba(42,184,166,0.15)';
  el.style.border = '1px solid ' + (isError ? 'var(--red)' : 'var(--teal)');
  el.style.color = isError ? 'var(--red)' : 'var(--teal)';
  setTimeout(() => { el.style.display = 'none'; }, 4000);
}

async function saveMenuBeer() {
  const name = document.getElementById('menu-beer-name').value.trim();
  if (!name) { showMenuAlert('Beer name is required', true); return; }

  const payload = {
    name,
    category_id: document.getElementById('menu-beer-category').value || null,
    style: document.getElementById('menu-beer-style').value.trim() || null,
    price: numOrNull('menu-beer-price'),
    abv: numOrNull('menu-beer-abv'),
    ibu: document.getElementById('menu-beer-ibu').value === '' ? null : parseInt(document.getElementById('menu-beer-ibu').value, 10),
    description: document.getElementById('menu-beer-desc').value.trim() || null,
    tasting_notes: document.getElementById('menu-beer-notes').value.trim() || null,
    image_url: document.getElementById('menu-beer-img').value.trim() || null,
    is_new_release: document.getElementById('menu-beer-release').checked,
  };
  const tapped = document.getElementById('menu-beer-tapped').value;

  try {
    if (menuEditingId) {
      const { error } = await window.supabase.from('beers').update(payload).eq('id', menuEditingId);
      if (error) throw error;
      showMenuAlert(`✓ ${name} updated`);
    } else {
      payload.tapped_on = tapped ? new Date(tapped).toISOString() : new Date().toISOString();
      payload.is_on_tap = true;
      payload.retired = false;
      const { error } = await window.supabase.from('beers').insert(payload);
      if (error) throw error;
      showMenuAlert(`✓ ${name} added to tap list`);
    }
    cancelMenuEdit();
    await loadMenu();
  } catch (e) {
    showMenuAlert('Error saving beer', true);
    console.error(e);
  }
}

async function toggleMenuNewRelease(beerId, currentState) {
  try {
    const { error } = await window.supabase.from('beers').update({ is_new_release: !currentState }).eq('id', beerId);
    if (error) throw error;
    toast(!currentState ? '★ Marked as new release' : 'New release flag removed');
    await loadMenu();
  } catch (e) {
    toast('Error updating beer', true);
  }
}

async function retireMenuBeer(beerId, beerName) {
  if (!confirm(`Retire "${beerName}"? This removes it from the active tap list — you can restore it later from the Retired view.`)) return;
  try {
    const { error } = await window.supabase.from('beers').update({ retired: true, is_on_tap: false, retired_on: new Date().toISOString() }).eq('id', beerId);
    if (error) throw error;
    toast(`🪦 ${beerName} retired`);
    await loadMenu();
  } catch (e) {
    toast('Error retiring beer', true);
  }
}

async function restoreMenuBeer(beerId, beerName) {
  try {
    const { error } = await window.supabase.from('beers').update({ retired: false, is_on_tap: true, retired_on: null }).eq('id', beerId);
    if (error) throw error;
    toast(`✓ ${beerName} restored to tap list`);
    await loadMenu();
  } catch (e) {
    toast('Error restoring beer', true);
  }
}
