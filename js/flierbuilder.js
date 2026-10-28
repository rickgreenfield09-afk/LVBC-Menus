// flierbuilder.js
// Marketing > Print Outs > Flip Cards: Component Library (borders,
// backgrounds, images) and the flier builder. A built flier is a layout spec
// stored in flip_designs.spec (migration_054) and rendered at print time, so
// data blocks such as upcoming releases are always current.
// Depends on: window.supabase, toast(), escHtml(), flipAsset() (js/menu.js),
// loadFlipDesigns() (js/printouts.js)

const FB_FONTS_LINK = 'https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Oswald:wght@500;700&family=Poppins:wght@400;600;700&family=Inter:wght@400;600;700&display=swap';
const FB_FONTS = { poppins: "'Poppins',sans-serif", oswald: "'Oswald',sans-serif", bebas: "'Bebas Neue',sans-serif", inter: "'Inter',sans-serif" };
const FB_TITLE_PX = { s: 26, m: 38, l: 54 }, FB_BODY_PX = { s: 12, m: 15, l: 19 }, FB_IMG_PCT = { s: 40, m: 65, l: 90 };
const FB_SOURCES = { none: 'No data block', releases: 'Upcoming beer releases (Events)', events: 'Upcoming events (incl. recurring)', new_beers: 'New releases on tap' };

const FLIER_BUILT_CSS = '.fl-card{position:relative;width:100%;height:100%;overflow:hidden;color:var(--tc);}.fl-bg,.fl-bd{position:absolute;inset:0;width:100%;height:100%;}.fl-bg{object-fit:cover;}'
  + '.fl-content{position:absolute;inset:var(--m);display:flex;flex-direction:column;align-items:center;text-align:center;overflow:hidden;}'
  + '.fl-logo{height:calc(64px*var(--u));width:auto;margin-bottom:calc(8px*var(--u));flex-shrink:0;}.fl-logo.bottom{margin:auto 0 0;}'
  + '.fl-title{font-weight:700;line-height:1.05;margin:0 0 calc(8px*var(--u));}.fl-sub{font-size:calc(17px*var(--u));font-weight:600;margin-bottom:calc(10px*var(--u));}'
  + '.fl-img{max-height:45%;object-fit:contain;margin-bottom:calc(10px*var(--u));flex-shrink:1;min-height:0;}'
  + '.fl-data-h{font-size:calc(15px*var(--u));font-weight:700;letter-spacing:0.12em;text-transform:uppercase;margin:calc(4px*var(--u)) 0 calc(6px*var(--u));}'
  + '.fl-item{margin-bottom:calc(8px*var(--u));line-height:1.2;}.fl-item b{display:block;font-size:calc(18px*var(--u));}.fl-item span{display:block;font-size:calc(13px*var(--u));opacity:0.85;}'
  + '.fl-body{line-height:1.4;margin-top:calc(6px*var(--u));}.fl-empty{font-size:calc(13px*var(--u));opacity:0.6;font-style:italic;}';

let flierComps = [], fb = null, fbId = null, fbData = {}, fbSaving = false;

function fbDefaults() {
  return {
    size: 'half', bg_id: null, bg_color: '#ffffff', border_id: null, border_fit: 'fill', margin: 0.7, logo: 'top',
    title: 'Upcoming Releases', title_font: 'bebas', title_size: 'm', text_color: '#1d1d1b',
    subtitle: '', image_id: null, image_size: 'm',
    data_source: 'none', data_heading: '', data_count: 5, body: '', body_size: 'm',
  };
}

// ---- Component library ----
async function fetchFlipComps() {
  const { data, error } = await window.supabase.from('flip_components').select('*').eq('archived', false).order('created_at', { ascending: false });
  if (!error) flierComps = data || [];
  return flierComps;
}

async function openFlierLibrary() {
  document.getElementById('flib-modal').style.display = 'flex';
  await fetchFlipComps();
  renderFlierLibrary();
}
function closeFlierLibrary() {
  document.getElementById('flib-modal').style.display = 'none';
  if (fb) fbRender();
}
function renderFlierLibrary() {
  const kinds = { border: 'Borders', background: 'Backgrounds', image: 'Images' };
  document.getElementById('flib-grid').innerHTML = Object.keys(kinds).map((k) => {
    const items = flierComps.filter((c) => c.kind === k);
    return '<div class="section-label">' + kinds[k] + '</div><div style="display:flex;gap:10px;flex-wrap:wrap;">'
      + (items.length ? items.map((c) => '<div style="width:110px;font-size:11px;"><div style="height:110px;border:1px solid var(--border);background:repeating-conic-gradient(#ccc 0 25%,#fff 0 50%) 0 0/14px 14px;display:flex;align-items:center;justify-content:center;"><img src="' + escHtml(c.url) + '" style="max-width:100%;max-height:100%;"></div>'
        + '<div style="margin-top:3px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;">' + escHtml(c.name) + '</div>'
        + '<a href="#" onclick="archiveFlierComp(\'' + c.id + '\');return false;" style="color:var(--muted);">Remove</a></div>').join('') : '<div style="font-size:12px;color:var(--muted);">None yet.</div>')
      + '</div>';
  }).join('');
}
async function uploadFlierComp() {
  const file = document.getElementById('flib-file').files[0];
  const kind = document.getElementById('flib-kind').value;
  const name = document.getElementById('flib-name').value.trim() || (file && file.name.replace(/\.[^.]+$/, ''));
  if (!file) { toast('Choose an image first.', true); return; }
  if (file.size > 10 * 1024 * 1024) { toast('Images must be under 10 MB.', true); return; }
  const id = crypto.randomUUID();
  const ext = file.type === 'image/png' ? 'png' : file.type === 'image/svg+xml' ? 'svg' : 'jpg';
  const path = 'flip/components/' + id + '.' + ext;
  const bucket = window.supabase.storage.from('assets');
  const up = await bucket.upload(path, file, { contentType: file.type });
  if (up.error) { toast('Upload failed: ' + up.error.message, true); return; }
  const url = bucket.getPublicUrl(path).data.publicUrl;
  const { error } = await window.supabase.from('flip_components').insert({ id, kind, name, url, path });
  if (error) { await bucket.remove([path]); toast('Save failed: ' + error.message, true); return; }
  document.getElementById('flib-file').value = '';
  document.getElementById('flib-name').value = '';
  toast('Added to the library.');
  await fetchFlipComps();
  renderFlierLibrary();
}
async function archiveFlierComp(id) {
  const { error } = await window.supabase.from('flip_components').update({ archived: true }).eq('id', id);
  if (error) { toast('Remove failed: ' + error.message, true); return; }
  await fetchFlipComps();
  renderFlierLibrary();
}

// ---- Rendering (shared by the builder preview, the saved list and printing) ----
function fbFmtDate(d) {
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'America/Chicago' });
}
async function fetchFlierData(source, count) {
  const n = Math.max(1, Math.min(10, Number(count) || 5));
  if (source === 'releases') {
    const since = new Date(Date.now() - 12 * 3600e3).toISOString();
    const { data } = await window.supabase.from('events').select('event_name,event_date,notes').eq('is_beer_release', true).gte('event_date', since).order('event_date').limit(n);
    return (data || []).map((e) => ({ name: e.event_name, line: fbFmtDate(new Date(e.event_date)), note: (e.notes || '').split('\n')[0].slice(0, 90) }));
  }
  if (source === 'events') {
    const { data } = await window.supabase.rpc('member_upcoming_events', { p_days: 60 });
    return (data || []).sort((a, b) => (a.event_date + (a.start_time || '')).localeCompare(b.event_date + (b.start_time || ''))).slice(0, n)
      .map((e) => { const [y, m, d] = e.event_date.split('-').map(Number); return { name: e.name, line: fbFmtDate(new Date(y, m - 1, d, 12)), note: '' }; });
  }
  if (source === 'new_beers') {
    const { data } = await window.supabase.from('beers').select('name,style,abv').eq('status', 'active').contains('badges', ['new_release']).order('name').limit(n);
    return (data || []).map((b) => ({ name: b.name, line: [b.style, b.abv ? b.abv + '% ABV' : ''].filter(Boolean).join(' · '), note: '' }));
  }
  return [];
}

function flierRenderBuilt(spec, comps, items) {
  const byId = (id) => comps.find((c) => c.id === id);
  const u = spec.size === 'full' ? 1.5 : 1;
  const bg = byId(spec.bg_id), bd = byId(spec.border_id), im = byId(spec.image_id);
  const style = '--u:' + u + ';--m:' + spec.margin + 'in;--tc:' + escHtml(spec.text_color) + ';font-family:' + FB_FONTS.poppins + ';background:' + escHtml(spec.bg_color);
  const logo = '<img class="fl-logo' + (spec.logo === 'bottom' ? ' bottom' : '') + '" src="' + flipAsset('lvbc-arch-logo.png') + '">';
  let h = '<div class="fl-card" style="' + style + '">';
  if (bg) h += '<img class="fl-bg" src="' + escHtml(bg.url) + '">';
  if (bd) h += '<img class="fl-bd" style="object-fit:' + (spec.border_fit === 'cover' ? 'cover' : 'fill') + ';" src="' + escHtml(bd.url) + '">';
  h += '<div class="fl-content">';
  if (spec.logo === 'top') h += logo;
  if (spec.title) h += '<div class="fl-title" style="font-family:' + FB_FONTS[spec.title_font] + ';font-size:calc(' + FB_TITLE_PX[spec.title_size] + 'px*var(--u));">' + escHtml(spec.title) + '</div>';
  if (spec.subtitle) h += '<div class="fl-sub">' + escHtml(spec.subtitle) + '</div>';
  if (im) h += '<img class="fl-img" style="width:' + FB_IMG_PCT[spec.image_size] + '%;" src="' + escHtml(im.url) + '">';
  if (spec.data_source !== 'none') {
    if (spec.data_heading) h += '<div class="fl-data-h">' + escHtml(spec.data_heading) + '</div>';
    h += items && items.length
      ? items.map((i) => '<div class="fl-item"><b>' + escHtml(i.name) + '</b><span>' + escHtml(i.line) + '</span>' + (i.note ? '<span>' + escHtml(i.note) + '</span>' : '') + '</div>').join('')
      : '<div class="fl-empty">Nothing scheduled right now.</div>';
  }
  if (spec.body) h += '<div class="fl-body" style="font-size:calc(' + FB_BODY_PX[spec.body_size] + 'px*var(--u));">' + escHtml(spec.body).replace(/\n/g, '<br>') + '</div>';
  if (spec.logo === 'bottom') h += logo;
  return h + '</div></div>';
}

// ---- Builder ----
function fbEnsureAssets() {
  if (!document.getElementById('fb-css')) {
    const s = document.createElement('style');
    s.id = 'fb-css'; s.textContent = FLIER_BUILT_CSS;
    document.head.appendChild(s);
    const l = document.createElement('link');
    l.rel = 'stylesheet'; l.href = FB_FONTS_LINK;
    document.head.appendChild(l);
  }
}

async function openFlierBuilder(fromId, asCopy) {
  fbEnsureAssets();
  await fetchFlipComps();
  const src = fromId && flierList.find((d) => d.id === fromId);
  fb = Object.assign(fbDefaults(), src && src.spec ? src.spec : {});
  fbId = src && !asCopy ? src.id : null;
  document.getElementById('fb-name').value = src ? src.name + (asCopy ? ' (copy)' : '') : '';
  document.getElementById('fb-modal-title').textContent = fbId ? 'Edit Flier' : asCopy ? 'New Flier from Copy' : 'Build a Flier';
  const sel = document.getElementById('fb-source');
  sel.innerHTML = Object.keys(FB_SOURCES).map((k) => '<option value="' + k + '">' + FB_SOURCES[k] + '</option>').join('');
  document.getElementById('fb-modal').style.display = 'flex';
  fbSyncControls();
  fbRender();
}
function closeFlierBuilder() { document.getElementById('fb-modal').style.display = 'none'; fb = null; }

const FB_FIELDS = { 'fb-size': 'size', 'fb-bg-color': 'bg_color', 'fb-border-fit': 'border_fit', 'fb-margin': 'margin', 'fb-logo': 'logo', 'fb-title': 'title', 'fb-title-font': 'title_font', 'fb-title-size': 'title_size',
  'fb-text-color': 'text_color', 'fb-subtitle': 'subtitle', 'fb-image-size': 'image_size', 'fb-source': 'data_source', 'fb-heading': 'data_heading', 'fb-count': 'data_count', 'fb-body': 'body', 'fb-body-size': 'body_size' };
function fbSyncControls() {
  Object.keys(FB_FIELDS).forEach((id) => { document.getElementById(id).value = fb[FB_FIELDS[id]]; });
}
function fbOnInput(el) {
  const key = FB_FIELDS[el.id];
  fb[key] = key === 'margin' ? Number(el.value) : key === 'data_count' ? Math.max(1, Math.min(10, Number(el.value) || 5)) : el.value;
  fbRender();
}
function fbPick(kind, id) {
  const key = { border: 'border_id', background: 'bg_id', image: 'image_id' }[kind];
  fb[key] = id || null;
  fbRender();
}

function fbPickerHtml(kind, selected) {
  const cell = (id, inner, on) => '<div onclick="fbPick(\'' + kind + '\',' + (id ? '\'' + id + '\'' : 'null') + ')" style="width:56px;height:56px;border:2px solid ' + (on ? 'var(--teal)' : 'var(--border)') + ';border-radius:6px;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:10px;background:#fff;color:#555;overflow:hidden;">' + inner + '</div>';
  return cell(null, 'None', !selected) + flierComps.filter((c) => c.kind === kind).map((c) => cell(c.id, '<img src="' + escHtml(c.url) + '" style="max-width:100%;max-height:100%;" title="' + escHtml(c.name) + '">', c.id === selected)).join('');
}

async function fbRender() {
  if (!fb) return;
  document.getElementById('fb-pick-border').innerHTML = fbPickerHtml('border', fb.border_id);
  document.getElementById('fb-pick-background').innerHTML = fbPickerHtml('background', fb.bg_id);
  document.getElementById('fb-pick-image').innerHTML = fbPickerHtml('image', fb.image_id);
  const key = fb.data_source + ':' + fb.data_count;
  if (fb.data_source !== 'none' && !fbData[key]) { fbData[key] = await fetchFlierData(fb.data_source, fb.data_count); if (!fb) return; }
  const w = fb.size === 'full' ? 816 : 528, h = fb.size === 'full' ? 1056 : 816, k = Math.min(1, 430 / h);
  document.getElementById('fb-preview').innerHTML = '<div style="width:' + w * k + 'px;height:' + h * k + 'px;box-shadow:0 2px 12px rgba(0,0,0,0.4);background:#fff;"><div style="width:' + w + 'px;height:' + h + 'px;transform:scale(' + k + ');transform-origin:0 0;">'
    + flierRenderBuilt(fb, flierComps, fbData[key]) + '</div></div>';
}

async function saveBuiltFlier() {
  if (fbSaving || !fb) return;
  const name = document.getElementById('fb-name').value.trim();
  if (!name) { toast('Give the flier a name.', true); return; }
  fbSaving = true;
  const row = { name, size: fb.size, kind: 'built', spec: fb, pages: [] };
  const q = fbId ? window.supabase.from('flip_designs').update(row).eq('id', fbId) : window.supabase.from('flip_designs').insert(row);
  const { error } = await q;
  fbSaving = false;
  if (error) { toast('Save failed: ' + error.message, true); return; }
  closeFlierBuilder();
  toast('Flier saved.');
  loadFlipDesigns();
}
