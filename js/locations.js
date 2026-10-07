// locations.js
// Inventory > Locations sub-tab, plus the location and photo helpers
// the rest of Inventory shares.
//
// Locations are one self-referencing table, three levels deep
// (migration_036): location > sublocation > spot, e.g.
// "Break room > Rack 1 > Box 2". Everyone can read them; only admins
// add, rename or delete (enforced again by RLS). A location that still
// has merch stock or count history can't be deleted — the database
// refuses, and the message says so.
//
// A location's id never changes, so anything keyed to it (a printed QR
// code, later) survives a rename.
//
// Photos for inventory records go in the public 'assets' bucket under
// inventory/, shrunk in the browser first so a phone-camera original
// doesn't get served to every list row.
// Depends on: window.supabase, toast(), escHtml() (menu.js),
// invIsAdmin() (inventory.js)

const INV_LOCATION_LEVELS = ['Location', 'Sublocation', 'Spot'];
const INV_PHOTO_MAX_PX = 1000;

let invLocations = [];
let invLocationsLoaded = false;

async function invLoadLocations(force) {
  if (invLocationsLoaded && !force) return;
  const { data, error } = await window.supabase.from('inventory_locations').select('*').order('sort_order').order('name');
  if (error) { toast('Could not load locations: ' + error.message, true); return; }
  invLocations = data || [];
  invLocationsLoaded = true;
}

function invLocationChildren(parentId) {
  return invLocations.filter((l) => l.parent_id === parentId);
}

// "Break room > Rack 1 > Box 2"
function invLocationPath(id) {
  const parts = [];
  for (let l = invLocations.find((x) => x.id === id); l; l = invLocations.find((x) => x.id === l.parent_id)) parts.unshift(l.name);
  return parts.join(' > ');
}

// Every location in tree order, each labelled with its full path.
function invLocationsFlat() {
  const out = [];
  const walk = (parentId) => invLocationChildren(parentId).forEach((l) => { out.push({ id: l.id, path: invLocationPath(l.id) }); walk(l.id); });
  walk(null);
  return out;
}

function invLocationOptions(selectedId, emptyLabel) {
  return '<option value="">' + escHtml(emptyLabel || 'No location set') + '</option>'
    + invLocationsFlat().map((l) => '<option value="' + l.id + '"' + (l.id === selectedId ? ' selected' : '') + '>' + escHtml(l.path) + '</option>').join('');
}

// ── LOCATIONS SCREEN ─────────────────────────────
async function loadInventoryLocations() {
  await invLoadLocations(true);
  renderInventoryLocations();
}

function renderInventoryLocations() {
  const el = document.getElementById('inv-locations-tree');
  const admin = invIsAdmin();
  const node = (l, depth) => {
    const kids = invLocationChildren(l.id);
    return '<div class="loc-node loc-depth-' + depth + '"><div class="loc-row">'
      + '<div><span class="loc-name">' + escHtml(l.name) + '</span> <span class="loc-level">' + INV_LOCATION_LEVELS[depth] + '</span></div>'
      + (admin ? '<div class="loc-actions">'
        + (depth < 2 ? '<button class="btn btn-sm btn-secondary" onclick="addInventoryLocation(\'' + l.id + '\',' + (depth + 1) + ')">+ ' + INV_LOCATION_LEVELS[depth + 1] + '</button>' : '')
        + '<button class="btn btn-sm btn-secondary" onclick="renameInventoryLocation(\'' + l.id + '\')">Rename</button>'
        + '<button class="btn btn-sm btn-danger" onclick="deleteInventoryLocation(\'' + l.id + '\')">Delete</button></div>' : '')
      + '</div>' + kids.map((k) => node(k, depth + 1)).join('') + '</div>';
  };
  const tops = invLocationChildren(null);
  el.innerHTML = (tops.length ? tops.map((l) => '<div class="card" style="margin-bottom:12px;">' + node(l, 0) + '</div>').join('') : '<div class="loading">No locations yet.</div>')
    + (admin ? '<button class="btn btn-secondary" onclick="addInventoryLocation(null,0)">+ Location</button>' : '');
}

async function addInventoryLocation(parentId, depth) {
  const name = (prompt('Name for the new ' + INV_LOCATION_LEVELS[depth].toLowerCase() + (parentId ? ' in ' + invLocationPath(parentId) : '') + ':') || '').trim();
  if (!name) return;
  const { error } = await window.supabase.from('inventory_locations')
    .insert({ parent_id: parentId, name, sort_order: invLocationChildren(parentId).length + 1 });
  if (error) { toast(error.code === '23505' ? 'There is already a "' + name + '" there' : error.message, true); return; }
  toast('Added');
  await loadInventoryLocations();
}

async function renameInventoryLocation(id) {
  const l = invLocations.find((x) => x.id === id);
  const name = (prompt('Rename "' + l.name + '" to:', l.name) || '').trim();
  if (!name || name === l.name) return;
  const { error } = await window.supabase.from('inventory_locations').update({ name }).eq('id', id);
  if (error) { toast(error.code === '23505' ? 'There is already a "' + name + '" there' : error.message, true); return; }
  toast('Renamed');
  await loadInventoryLocations();
}

async function deleteInventoryLocation(id) {
  const kids = invLocationsFlat().filter((l) => l.id !== id && l.path.startsWith(invLocationPath(id) + ' > ')).length;
  if (!confirm('Delete "' + invLocationPath(id) + '"' + (kids ? ' and the ' + kids + ' location' + (kids === 1 ? '' : 's') + ' inside it' : '') + '?')) return;
  const { error } = await window.supabase.from('inventory_locations').delete().eq('id', id);
  // 23503 = foreign_key_violation: items, merch stock or count history still point here
  if (error) { toast(error.code === '23503' ? 'Can\'t delete — items or count history are still tied to this location (or one inside it). Move them first.' : error.message, true); return; }
  toast('Deleted');
  await loadInventoryLocations();
}

// ── PHOTOS ───────────────────────────────────────
function invPhotoThumbHtml(url, alt) {
  return url
    ? '<img class="inv-thumb" src="' + escHtml(url) + '" alt="' + escHtml(alt || '') + '" loading="lazy">'
    : '<div class="inv-thumb inv-thumb-empty" aria-label="No photo">No photo</div>';
}

// Opens the file picker and hands back the chosen image, or nothing if cancelled.
function invPickPhoto(onPicked) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.onchange = () => { if (input.files[0]) onPicked(input.files[0]); };
  input.click();
}

function invResizePhoto(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, INV_PHOTO_MAX_PX / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(img.src);
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Could not read that image'))), 'image/jpeg', 0.82);
    };
    img.onerror = () => reject(new Error('Could not read that image'));
    img.src = URL.createObjectURL(file);
  });
}

// Uploads to assets/inventory/<path>.jpg, replacing any earlier photo
// at the same path, and returns its public URL. The ?v= suffix is only
// there so browsers don't keep showing the replaced image.
async function invUploadPhoto(path, file) {
  const blob = await invResizePhoto(file);
  const fullPath = 'inventory/' + path + '.jpg';
  const { error } = await window.supabase.storage.from('assets').upload(fullPath, blob, { upsert: true, contentType: 'image/jpeg' });
  if (error) throw error;
  return window.supabase.storage.from('assets').getPublicUrl(fullPath).data.publicUrl + '?v=' + Date.now();
}
