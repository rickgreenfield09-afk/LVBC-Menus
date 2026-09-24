// bingo.js
// Screen: #screen-bingo — Music Bingo. A game night is 3 rounds, each
// played from one 24-song playlist; every player gets one 8.5x11 sheet
// with a card per round (the round's 24 songs shuffled around a free
// center) plus an info quadrant (rules, this week's events, the 3 win
// patterns). A landscape slideshow for the taproom TV comes with it.
//
// "Used" means printed: create_bingo_game() (migration_025) stamps the
// playlists and their songs with today's date and bumps their counts.
// A playlist is back in rotation 90 days later; only admins can print
// one sooner (enforced in the RPC, the UI just greys it out). The RPC
// also snapshots everything and generates every card's shuffle, so
// card sheets/slideshows are always rendered from the saved game —
// a reprint from History is identical and never re-counts usage.
//
// Depends on: window.supabase, toast(), escHtml() (menu.js),
// openHtml()/FONT_LINK/PRINT_RESET/LOGO_URL (menu.js),
// toDateStr()/fmtTime()/logAudit() (schedule.js),
// refreshRecurringData()/computeRecurringOccurrences() (recurring.js)

const BINGO_COOLDOWN_DAYS = 90;
const BINGO_SONGS_PER_PLAYLIST = 24;
const BINGO_FREE_CELL = 12;
// how long a returned playlist stays in the dashboard's "Back in Rotation" list
const BINGO_BACK_WINDOW_DAYS = 14;
const BINGO_BREWERY = 'Lago Vista Brewing Company';

let bingoPlaylists = [];
let bingoPatterns = [];
let bingoEditPlaylistId = null;
let bingoEditSongs = [];
let bingoEditPatternId = null;
let bingoPatternCells = new Set();

function loadBingo() {
  setBingoTab('dashboard', document.getElementById('bingotab-btn-dashboard'));
}

function setBingoTab(tab, btn) {
  document.querySelectorAll('#screen-bingo > .sub-tabs .sub-tab').forEach((b) => b.classList.remove('active'));
  document.querySelectorAll('#screen-bingo > .sub-sec').forEach((s) => s.classList.remove('active'));
  if (btn) btn.classList.add('active');
  document.getElementById('bingotab-' + tab).classList.add('active');
  if (tab === 'dashboard') loadBingoDashboard();
  else if (tab === 'playlists') loadBingoPlaylistsTab();
  else if (tab === 'songs') loadBingoSongBank();
  else if (tab === 'patterns') loadBingoPatternsTab();
  else if (tab === 'newgame') loadBingoNewGameTab();
  else if (tab === 'history') loadBingoHistory();
}

// ── SHARED HELPERS ────────────────────────────────
function bingoToday() { return toDateStr(new Date()); }
function bingoAddDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return toDateStr(d);
}
function bingoFmtDate(dateStr, opts) {
  if (!dateStr) return '—';
  return new Date(dateStr + 'T00:00:00').toLocaleDateString('en-US', opts || { month: 'short', day: 'numeric', year: 'numeric' });
}
function bingoReadyOn(pl) { return pl.last_used_on ? bingoAddDays(pl.last_used_on, BINGO_COOLDOWN_DAYS) : null; }
function bingoIsCooling(pl) { const r = bingoReadyOn(pl); return !!r && r > bingoToday(); }
function bingoIsComplete(pl) { return pl.song_count === BINGO_SONGS_PER_PLAYLIST; }
function bingoIsAdmin() { return !!(window.currentStaff && window.currentStaff.role === 'admin'); }
function bingoCanDelete(row) { return bingoIsAdmin() || (window.currentStaff && row.created_by === window.currentStaff.id); }

function bingoAlert(id, msg, isError) {
  const el = document.getElementById(id);
  el.style.display = 'block';
  el.style.background = isError ? 'rgba(220,53,69,0.1)' : 'rgba(42,184,166,0.1)';
  el.style.color = isError ? 'var(--red)' : 'var(--teal)';
  el.textContent = msg;
}
function bingoClearAlert(id) {
  const el = document.getElementById(id);
  el.style.display = 'none';
  el.textContent = '';
}

// "1:05" / "65" → 65; blank → null; anything else → NaN
function bingoParseClip(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  const m = s.match(/^(\d+):([0-5]\d)$/);
  if (m) return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  return /^\d+$/.test(s) ? parseInt(s, 10) : NaN;
}
function bingoFmtClip(sec) {
  if (sec == null) return '';
  return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
}

function bingoStatusBadge(pl) {
  if (!bingoIsComplete(pl)) return '<span class="badge badge-muted">Building ' + pl.song_count + '/24</span>';
  if (bingoIsCooling(pl)) return '<span class="badge badge-amber">Ready ' + escHtml(bingoFmtDate(bingoReadyOn(pl), { month: 'short', day: 'numeric' })) + '</span>';
  return '<span class="badge badge-teal">Ready</span>';
}

function bingoMiniGrid(cells, px) {
  const on = new Set(cells || []);
  const size = px ? ' style="width:' + px + 'px;height:' + px + 'px;"' : '';
  let html = '<span class="bingo-mini"' + (px ? ' style="grid-template-columns:repeat(5,' + px + 'px);"' : '') + '>';
  for (let i = 0; i < 25; i++) html += '<span class="' + (i === BINGO_FREE_CELL ? 'free' : (on.has(i) ? 'on' : '')) + '"' + size + '></span>';
  return html + '</span>';
}

async function bingoLoadPlaylists() {
  const { data, error } = await window.supabase.from('bingo_playlists')
    .select('*, bingo_playlist_songs(count), staff_profiles(name)')
    .order('title');
  if (error) { toast('Error loading playlists: ' + error.message, true); return; }
  bingoPlaylists = (data || []).map((p) => Object.assign({}, p, {
    song_count: (p.bingo_playlist_songs && p.bingo_playlist_songs[0] && p.bingo_playlist_songs[0].count) || 0,
    creator_name: p.staff_profiles ? p.staff_profiles.name : '',
  }));
  bingoUpdateNavBadge();
}

async function bingoLoadPatterns() {
  const { data, error } = await window.supabase.from('bingo_patterns').select('*, staff_profiles(name)').order('name');
  if (error) { toast('Error loading patterns: ' + error.message, true); return; }
  bingoPatterns = data || [];
}

function bingoBackInRotation() {
  const today = bingoToday(), since = bingoAddDays(today, -BINGO_BACK_WINDOW_DAYS);
  return bingoPlaylists.filter((p) => {
    const r = bingoReadyOn(p);
    return bingoIsComplete(p) && r && r <= today && r >= since;
  }).sort((a, b) => bingoReadyOn(b).localeCompare(bingoReadyOn(a)));
}

function bingoUpdateNavBadge() {
  const el = document.getElementById('bingo-nav-ready');
  if (!el) return;
  const n = bingoBackInRotation().length;
  el.textContent = n;
  el.title = n + ' playlist' + (n === 1 ? '' : 's') + ' back in rotation';
  el.style.display = n ? '' : 'none';
}

// Called on login (app-core.js) so the nav badge shows before anyone
// opens the Bingo screen.
async function refreshBingoNavBadge() {
  bingoHandleSpotifyReturn();
  await bingoLoadPlaylists();
}

// ── DASHBOARD ─────────────────────────────────────
async function loadBingoDashboard() {
  const [, { count: songCount }, , { count: unlinkedCount }] = await Promise.all([
    bingoLoadPlaylists(),
    window.supabase.from('bingo_songs').select('id', { count: 'exact', head: true }),
    bingoLoadSpotifyStatus(),
    window.supabase.from('bingo_songs').select('id', { count: 'exact', head: true }).is('spotify_track_id', null),
  ]);
  renderBingoSpotifyCard(unlinkedCount || 0);

  const complete = bingoPlaylists.filter(bingoIsComplete);
  const ready = complete.filter((p) => !bingoIsCooling(p));
  const cooling = complete.filter(bingoIsCooling).sort((a, b) => bingoReadyOn(a).localeCompare(bingoReadyOn(b)));
  const building = bingoPlaylists.filter((p) => !bingoIsComplete(p));

  const card = (title, value, color, sub) => '<div class="card"><div class="card-title">' + title + '</div>'
    + '<div class="card-value" style="color:' + color + ';">' + value + '</div><div class="card-sub">' + sub + '</div></div>';
  document.getElementById('bingo-dash-cards').innerHTML =
    card('Ready to Play', ready.length, 'var(--teal)', 'complete playlists out of cooldown')
    + card('Cooling Down', cooling.length, 'var(--amber)', 'used in the last ' + BINGO_COOLDOWN_DAYS + ' days')
    + card('Still Building', building.length, 'var(--sub)', 'fewer than 24 songs')
    + card('Song Library', songCount || 0, 'var(--text)', 'unique songs across all playlists');

  const back = bingoBackInRotation();
  document.getElementById('bingo-dash-back').innerHTML = back.length
    ? '<div class="table-wrap"><table><thead><tr><th>Playlist</th><th>Last Used</th><th>Back Since</th><th>Times Used</th></tr></thead><tbody>'
      + back.map((p) => '<tr><td style="font-weight:500;">' + escHtml(p.title) + ' <span class="badge badge-teal" style="margin-left:6px;">Ready</span></td>'
        + '<td>' + bingoFmtDate(p.last_used_on) + '</td><td>' + bingoFmtDate(bingoReadyOn(p)) + '</td><td>' + p.times_used + '</td></tr>').join('')
      + '</tbody></table></div>'
    : '<div class="loading">No playlists have come back into rotation in the last ' + BINGO_BACK_WINDOW_DAYS + ' days.</div>';

  const today = new Date(bingoToday() + 'T00:00:00');
  document.getElementById('bingo-dash-cooling').innerHTML = cooling.length
    ? '<div class="table-wrap"><table><thead><tr><th>Playlist</th><th>Last Used</th><th>Ready On</th><th>Days Left</th></tr></thead><tbody>'
      + cooling.map((p) => {
        const days = Math.round((new Date(bingoReadyOn(p) + 'T00:00:00') - today) / 86400000);
        return '<tr><td style="font-weight:500;">' + escHtml(p.title) + '</td><td>' + bingoFmtDate(p.last_used_on) + '</td>'
          + '<td>' + bingoFmtDate(bingoReadyOn(p)) + '</td><td>' + days + '</td></tr>';
      }).join('')
      + '</tbody></table></div>'
    : '<div class="loading">Nothing is cooling down.</div>';
}

// ── PLAYLISTS ─────────────────────────────────────
// Songs only come from Spotify (migration_028): the search box, or a
// pasted list matched on Spotify and confirmed line by line. A song
// that's already in the bank is reused as-is — whoever added it first
// chose the version (and spelling) everyone uses.
async function loadBingoPlaylistsTab() {
  await Promise.all([bingoLoadPlaylists(), bingoLoadSpotifyStatus(), bingoLoadSongLibrary()]);
  renderBingoSpotifyRequired();
  renderBingoPlaylistList();
  renderBingoEditSongs();
}

let bingoSongLibrary = [];
async function bingoLoadSongLibrary() {
  const { data } = await window.supabase.from('bingo_songs').select('id,title,artist,clip_start_seconds,clip_end_seconds,spotify_track_id');
  bingoSongLibrary = data || [];
}

function bingoSongKey(title, artist) { return (String(title).trim() + '|' + String(artist).trim()).toLowerCase(); }

// Without a Spotify connection nothing can be added or saved.
function renderBingoSpotifyRequired() {
  const ok = bingoSpotify.connected;
  const warn = document.getElementById('bingo-spotify-required');
  warn.style.display = ok ? 'none' : '';
  warn.innerHTML = ok ? '' : '&#9888; Spotify isn\'t connected, so songs can\'t be added and playlists can\'t be saved. '
    + (bingoIsAdmin() ? 'Connect it from the Bingo Dashboard.' : 'Ask an admin to connect it from the Bingo Dashboard.');
  document.getElementById('bingo-spotify-add').style.display = ok ? '' : 'none';
  document.getElementById('bingo-pl-save-btn').disabled = !ok;
}

function renderBingoPlaylistList() {
  const el = document.getElementById('bingo-pl-list');
  if (!bingoPlaylists.length) { el.innerHTML = '<div class="loading">No playlists yet — build one on the left.</div>'; return; }
  const sp = bingoSpotify.connected;
  el.innerHTML = (sp ? '<div style="display:flex;justify-content:flex-end;margin-bottom:8px;"><button class="btn btn-secondary btn-sm" id="bingo-sync-all-btn" onclick="syncAllBingoPlaylists()">Sync All to Spotify</button></div>' : '')
    + '<div class="table-wrap"><table><thead><tr><th>Playlist</th><th>Status</th><th>Last Used</th><th>Used</th><th>Created</th><th>Spotify</th><th></th></tr></thead><tbody>'
    + bingoPlaylists.map((p) => '<tr>'
      + '<td style="font-weight:500;">' + escHtml(p.title) + (p.notes ? '<div style="font-size:11px;color:var(--sub);font-weight:400;">' + escHtml(p.notes) + '</div>' : '') + '</td>'
      + '<td>' + bingoStatusBadge(p) + '</td>'
      + '<td style="font-size:12px;">' + bingoFmtDate(p.last_used_on) + '</td>'
      + '<td>' + p.times_used + '</td>'
      + '<td style="font-size:11px;color:var(--sub);">' + escHtml(p.creator_name || '—') + '<br>' + bingoFmtDate(toDateStr(new Date(p.created_at))) + '</td>'
      + '<td style="white-space:nowrap;font-size:12px;">' + bingoSpotifyCell(p) + '</td>'
      + '<td style="white-space:nowrap;"><button class="btn btn-secondary btn-sm" onclick="editBingoPlaylist(\'' + p.id + '\')">Edit</button>'
      + (bingoCanDelete(p) ? ' <button class="btn btn-danger btn-sm" onclick="deleteBingoPlaylist(\'' + p.id + '\')">Delete</button>' : '')
      + '</td></tr>').join('')
    + '</tbody></table></div>';
}

// spotify_dirty is set by every save/link and cleared by a sync, so it
// says exactly whether the Spotify copy matches.
function bingoSpotifyCell(p) {
  const btn = bingoSpotify.connected
    ? ' <button class="btn btn-secondary btn-sm" id="bingo-sync-' + p.id + '" onclick="syncBingoPlaylist(\'' + p.id + '\')">Sync</button>' : '';
  const open = p.spotify_playlist_id
    ? '<a href="https://open.spotify.com/playlist/' + encodeURIComponent(p.spotify_playlist_id) + '" target="_blank" rel="noopener" style="color:#1DB954;">Open &#8599;</a>' : '';
  const note = !p.spotify_playlist_id ? '<div style="font-size:10px;color:var(--amber);margin-top:2px;">not on Spotify yet</div>'
    : (p.spotify_dirty ? '<div style="font-size:10px;color:var(--amber);margin-top:2px;">needs sync</div>' : '');
  return open + btn + note;
}

function renderBingoEditSongs() {
  document.getElementById('bingo-pl-count').textContent = bingoEditSongs.length + ' / ' + BINGO_SONGS_PER_PLAYLIST;
  document.getElementById('bingo-pl-count').className = 'badge ' + (bingoEditSongs.length === BINGO_SONGS_PER_PLAYLIST ? 'badge-teal' : 'badge-muted');
  const el = document.getElementById('bingo-pl-songs');
  if (!bingoEditSongs.length) { el.innerHTML = '<div style="font-size:12px;color:var(--muted);">No songs yet.</div>'; return; }
  el.innerHTML = '<div class="bingo-song-row" style="font-size:10px;color:var(--muted);font-family:\'DM Mono\',monospace;text-transform:uppercase;"><span></span><span>Song</span><span>Start</span><span>Stop</span><span></span></div>'
    + bingoEditSongs.map((s, i) => '<div class="bingo-song-row">'
      + '<span class="bingo-song-num">' + (i + 1) + '</span>'
      + '<div><div>' + escHtml(s.title) + '</div><div class="bingo-song-artist">' + escHtml(s.artist) + '</div>'
      + (s.spotify_track_id ? '' : '<div style="font-size:10px;color:var(--red);">Not linked to Spotify — link it in the Song Bank</div>') + '</div>'
      + '<input class="form-input" placeholder="m:ss" value="' + bingoFmtClip(s.clip_start_seconds) + '" onchange="setBingoSongClip(' + i + ', \'clip_start_seconds\', this)">'
      + '<input class="form-input" placeholder="m:ss" value="' + bingoFmtClip(s.clip_end_seconds) + '" onchange="setBingoSongClip(' + i + ', \'clip_end_seconds\', this)">'
      + '<button class="bingo-song-remove" title="Remove" onclick="removeBingoSong(' + i + ')">&#10005;</button>'
      + '</div>').join('')
    + '<div style="font-size:11px;color:var(--muted);margin-top:6px;">Clip start / stop (m:ss) are optional and belong to the song everywhere it\'s used.</div>';
}

function setBingoSongClip(i, field, input) {
  const sec = bingoParseClip(input.value);
  if (Number.isNaN(sec)) { toast('Use m:ss, e.g. 1:05', true); input.value = bingoFmtClip(bingoEditSongs[i][field]); return; }
  bingoEditSongs[i][field] = sec;
  input.value = bingoFmtClip(sec);
}

function removeBingoSong(i) {
  bingoEditSongs.splice(i, 1);
  renderBingoEditSongs();
}

// Adds a Spotify search result to the playlist being edited. If the
// bank already has this song — same track, or another version with the
// same cleaned title + artist — the bank's version is used instead.
// Returns { error } or { reused } (true when a different version won).
function bingoAddSpotifyTrack(t) {
  if (bingoEditSongs.length >= BINGO_SONGS_PER_PLAYLIST) return { error: 'Playlist already has 24 songs' };
  const title = bingoCleanSpotifyTitle(t.title), artist = t.artist;
  const bank = bingoSongLibrary.find((s) => s.spotify_track_id === t.id)
    || bingoSongLibrary.find((s) => bingoSongKey(s.title, s.artist) === bingoSongKey(title, artist));
  const useBank = bank && bank.spotify_track_id;
  const song = {
    title: useBank ? bank.title : title,
    artist: useBank ? bank.artist : artist,
    spotify_track_id: useBank ? bank.spotify_track_id : t.id,
    clip_start_seconds: bank ? bank.clip_start_seconds : null,
    clip_end_seconds: bank ? bank.clip_end_seconds : null,
  };
  const dup = bingoEditSongs.some((s) => s.spotify_track_id === song.spotify_track_id || bingoSongKey(s.title, s.artist) === bingoSongKey(song.title, song.artist));
  if (dup) return { error: '"' + song.title + '" is already on this playlist' };
  bingoEditSongs.push(song);
  return { reused: !!useBank && bank.spotify_track_id !== t.id };
}

async function editBingoPlaylist(id) {
  const pl = bingoPlaylists.find((p) => p.id === id);
  if (!pl) return;
  const { data, error } = await window.supabase.from('bingo_playlist_songs')
    .select('position, bingo_songs(title, artist, clip_start_seconds, clip_end_seconds, spotify_track_id)')
    .eq('playlist_id', id).order('position');
  if (error) { toast(error.message, true); return; }
  bingoEditPlaylistId = id;
  bingoEditSongs = (data || []).map((r) => Object.assign({}, r.bingo_songs));
  document.getElementById('bingo-pl-title').value = pl.title;
  document.getElementById('bingo-pl-notes').value = pl.notes || '';
  document.getElementById('bingo-pl-form-label').textContent = 'Edit Playlist';
  document.getElementById('bingo-pl-cancel').style.visibility = 'visible';
  bingoClearAlert('bingo-pl-alert');
  renderBingoEditSongs();
}

function resetBingoPlaylistForm() {
  bingoEditPlaylistId = null;
  bingoEditSongs = [];
  bingoPasteMatches = [];
  document.getElementById('bingo-pl-title').value = '';
  document.getElementById('bingo-pl-notes').value = '';
  document.getElementById('bingo-paste').value = '';
  document.getElementById('bingo-paste-review').innerHTML = '';
  document.getElementById('bingo-pl-form-label').textContent = 'New Playlist';
  document.getElementById('bingo-pl-cancel').style.visibility = 'hidden';
  bingoClearAlert('bingo-pl-alert');
  renderBingoEditSongs();
}

async function saveBingoPlaylist() {
  if (!bingoSpotify.connected) { bingoAlert('bingo-pl-alert', 'Spotify isn\'t connected — playlists can\'t be saved until it is.', true); return; }
  const title = document.getElementById('bingo-pl-title').value.trim();
  if (!title) { bingoAlert('bingo-pl-alert', 'Give the playlist a title.', true); return; }
  const unlinked = bingoEditSongs.filter((s) => !s.spotify_track_id);
  if (unlinked.length) {
    bingoAlert('bingo-pl-alert', 'Link these songs in the Song Bank first (or remove them): ' + unlinked.map((s) => s.title).join(', '), true);
    return;
  }
  const bad = bingoEditSongs.find((s) => s.clip_start_seconds != null && s.clip_end_seconds != null && s.clip_end_seconds <= s.clip_start_seconds);
  if (bad) { bingoAlert('bingo-pl-alert', 'Clip stop must be after start for "' + bad.title + '".', true); return; }

  const { data: id, error } = await window.supabase.rpc('save_bingo_playlist', {
    p_id: bingoEditPlaylistId,
    p_title: title,
    p_notes: document.getElementById('bingo-pl-notes').value,
    p_songs: bingoEditSongs,
  });
  if (error) { bingoAlert('bingo-pl-alert', error.message, true); return; }

  const n = bingoEditSongs.length;
  toast(n === BINGO_SONGS_PER_PLAYLIST ? 'Playlist saved — ready to play' : 'Saved — ' + (BINGO_SONGS_PER_PLAYLIST - n) + ' more song' + (BINGO_SONGS_PER_PLAYLIST - n === 1 ? '' : 's') + ' needed before it can be played');
  logAudit(bingoEditPlaylistId ? 'update_bingo_playlist' : 'create_bingo_playlist', 'bingo_playlists', id, { title, songs: n });
  resetBingoPlaylistForm();
  await loadBingoPlaylistsTab();
  // Keep the Spotify copy in step with every save.
  if (n) await syncBingoPlaylist(id);
}

async function deleteBingoPlaylist(id) {
  const pl = bingoPlaylists.find((p) => p.id === id);
  if (!pl || !confirm('Delete the playlist "' + pl.title + '"? Past games that used it keep their copy of its songs. Its Spotify copy stays in the Spotify account.')) return;
  const { error } = await window.supabase.from('bingo_playlists').delete().eq('id', id);
  if (error) { toast(error.message, true); return; }
  logAudit('delete_bingo_playlist', 'bingo_playlists', id, { title: pl.title });
  toast('Playlist deleted');
  if (bingoEditPlaylistId === id) resetBingoPlaylistForm();
  await loadBingoPlaylistsTab();
}

// ── SPOTIFY ───────────────────────────────────────
// One brewery Spotify account, connected once by an admin (OAuth via
// api/spotify-connect + api/spotify-callback). Tokens never reach the
// browser — search and playlist sync go through api/spotify-*.
let bingoSpotify = { connected: false };

async function bingoLoadSpotifyStatus() {
  const { data, error } = await window.supabase.rpc('spotify_connection_status');
  bingoSpotify = !error && data && data[0] ? data[0] : { connected: false };
}

async function bingoApi(path, body) {
  const { data: { session } } = await window.supabase.auth.getSession();
  const res = await fetch('/api/' + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (session ? session.access_token : '') },
    body: JSON.stringify(body || {}),
  });
  let json = {};
  try { json = await res.json(); } catch (e) { /* non-JSON error page */ }
  if (!res.ok) throw new Error(json.error || 'Request failed (' + res.status + ')');
  return json;
}

function renderBingoSpotifyCard(unlinkedCount) {
  const el = document.getElementById('bingo-spotify-card');
  const admin = bingoIsAdmin();
  const unlinkedNote = unlinkedCount
    ? '<div class="bingo-warning">&#9888; ' + unlinkedCount + ' song' + (unlinkedCount === 1 ? '' : 's') + ' in the Song Bank still need a Spotify link. Playlists with unlinked songs can\'t be synced or printed. '
      + '<a href="#" onclick="setBingoTab(\'songs\', document.getElementById(\'bingotab-btn-songs\'));return false;" style="color:inherit;text-decoration:underline;">Open the Song Bank</a></div>'
    : '';
  if (bingoSpotify.connected) {
    el.innerHTML = '<div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;">'
      + '<div><span class="badge badge-teal">Connected</span> <strong style="margin-left:6px;">' + escHtml(bingoSpotify.display_name || bingoSpotify.spotify_user_id) + '</strong>'
      + '<div style="font-size:12px;color:var(--sub);margin-top:6px;">Every bingo playlist is copied to this account as a private "LVBC Bingo · …" playlist and updated whenever it\'s saved.'
      + ' Connected ' + escHtml(bingoFmtDate(toDateStr(new Date(bingoSpotify.connected_at)))) + (bingoSpotify.connected_by_name ? ' by ' + escHtml(bingoSpotify.connected_by_name) : '') + '.</div></div>'
      + (admin ? '<button class="btn btn-danger btn-sm" onclick="disconnectSpotify()">Disconnect</button>' : '')
      + '</div>' + unlinkedNote;
  } else {
    el.innerHTML = '<div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;">'
      + '<div><span class="badge badge-red">Not connected</span>'
      + '<div style="font-size:12px;color:var(--sub);margin-top:6px;">Bingo needs the brewery\'s Spotify account: songs are added by searching Spotify, and every playlist is kept in sync there. Until it\'s connected, playlists can\'t be created or edited.'
      + (admin ? '' : ' Ask an admin to connect it.') + '</div></div>'
      + (admin ? '<button class="btn btn-primary btn-sm" onclick="connectSpotify()">Connect Spotify</button>' : '')
      + '</div>' + unlinkedNote;
  }
}

async function connectSpotify() {
  try {
    const { url } = await bingoApi('spotify-connect');
    window.location.href = url;
  } catch (e) { toast(e.message, true); }
}

async function disconnectSpotify() {
  if (!confirm('Disconnect Spotify? Playlists can\'t be created or edited until it\'s connected again. Existing Spotify playlists stay in the account.')) return;
  const { error } = await window.supabase.rpc('disconnect_spotify');
  if (error) { toast(error.message, true); return; }
  toast('Spotify disconnected');
  await loadBingoDashboard();
}

// api/spotify-callback sends the admin back to /?spotify=connected (or
// =error&reason=...). Called once on login.
function bingoHandleSpotifyReturn() {
  const params = new URLSearchParams(window.location.search);
  const result = params.get('spotify');
  if (!result) return;
  history.replaceState(null, '', window.location.pathname);
  if (result === 'connected') toast('Spotify connected');
  else toast('Spotify connection failed: ' + (params.get('reason') || 'unknown error'), true);
  const navBtn = Array.from(document.querySelectorAll('.nav-btn')).find((b) => b.textContent.trim().startsWith('Bingo'));
  if (navBtn) { showScreen('bingo', navBtn); loadBingo(); }
}

// Spotify titles often carry release noise ("- Remastered 2011",
// "(2008 Remaster)") that just crowds a bingo square.
function bingoCleanSpotifyTitle(title) {
  return title
    .replace(/\s+-\s+[^-]*\b(remaster(ed)?|mono|stereo|single version|radio edit|album version)\b.*$/i, '')
    .replace(/\s*[([][^)\]]*\b(remaster(ed)?|mono|stereo|single version|radio edit|album version)\b[^)\]]*[)\]]/ig, '')
    .trim() || title;
}

function bingoSpotifyHitHtml(t, onclick, extra) {
  return '<div class="bingo-spotify-hit" onclick="' + onclick + '">'
    + (t.image ? '<img src="' + escHtml(t.image) + '" alt="">' : '<span class="noart"></span>')
    + '<div class="meta"><div>' + escHtml(t.title) + '</div><div class="sub">' + escHtml(t.artist) + ' · ' + escHtml(t.album) + '</div></div>'
    + (extra || '<span class="sub" style="font-size:11px;color:var(--muted);">' + bingoFmtClip(Math.round(t.duration_ms / 1000)) + '</span>')
    + '</div>';
}

// Search-as-you-type in the playlist editor. A sequence number drops
// responses that come back after a newer search started.
let bingoSpotifySearchTimer = null;
let bingoSpotifySearchSeq = 0;
let bingoSpotifyHits = [];

function onBingoSpotifySearchInput() {
  clearTimeout(bingoSpotifySearchTimer);
  bingoSpotifySearchTimer = setTimeout(runBingoSpotifySearch, 350);
}

async function runBingoSpotifySearch() {
  const q = document.getElementById('bingo-spotify-q').value.trim();
  const box = document.getElementById('bingo-spotify-results');
  if (q.length < 2) { box.style.display = 'none'; return; }
  const seq = ++bingoSpotifySearchSeq;
  box.style.display = '';
  box.innerHTML = '<div class="loading" style="padding:12px;">Searching…</div>';
  try {
    const { tracks } = await bingoApi('spotify-search', { q });
    if (seq !== bingoSpotifySearchSeq) return;
    bingoSpotifyHits = tracks;
    box.innerHTML = tracks.length
      ? tracks.map((t, i) => bingoSpotifyHitHtml(t, 'pickBingoSpotifyTrack(' + i + ')')).join('')
      : '<div class="loading" style="padding:12px;">No matches on Spotify.</div>';
  } catch (e) {
    if (seq === bingoSpotifySearchSeq) box.innerHTML = '<div style="padding:12px;color:var(--red);font-size:12px;">' + escHtml(e.message) + '</div>';
  }
}

function pickBingoSpotifyTrack(i) {
  const t = bingoSpotifyHits[i];
  if (!t) return;
  const r = bingoAddSpotifyTrack(t);
  if (r.error) { toast(r.error, true); return; }
  if (r.reused) toast('That song is already in the Song Bank — using the version picked first');
  const input = document.getElementById('bingo-spotify-q');
  input.value = '';
  document.getElementById('bingo-spotify-results').style.display = 'none';
  renderBingoEditSongs();
  input.focus();
}

document.addEventListener('click', (e) => {
  const wrap = document.getElementById('bingo-spotify-search-wrap');
  const box = document.getElementById('bingo-spotify-results');
  if (wrap && box && !wrap.contains(e.target)) box.style.display = 'none';
});

// Pasted list: each line is searched on Spotify, the top hit is
// preselected, and nothing is added until staff review and confirm.
// One song per line: "Title<TAB>Artist" (spreadsheet paste) or
// "Title - Artist" (split on the LAST " - "); anything else is
// searched as typed.
let bingoPasteMatches = [];

async function matchBingoPasteOnSpotify() {
  const lines = document.getElementById('bingo-paste').value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return;
  const btn = document.getElementById('bingo-paste-btn');
  btn.disabled = true;
  bingoPasteMatches = lines.map((line) => {
    let q = line;
    if (line.includes('\t')) q = line.split('\t').join(' ');
    else { const at = line.lastIndexOf(' - '); if (at > 0) q = line.slice(0, at) + ' ' + line.slice(at + 3); }
    return { line, q, hits: [], choice: -1, error: null };
  });
  for (let i = 0; i < bingoPasteMatches.length; i += 4) {
    btn.textContent = 'Searching ' + Math.min(i + 4, bingoPasteMatches.length) + ' / ' + bingoPasteMatches.length + '…';
    await Promise.all(bingoPasteMatches.slice(i, i + 4).map(async (m) => {
      try {
        m.hits = (await bingoApi('spotify-search', { q: m.q, limit: 3 })).tracks;
        m.choice = m.hits.length ? 0 : -1;
      } catch (e) { m.error = e.message; }
    }));
  }
  btn.disabled = false;
  btn.textContent = 'Find on Spotify';
  renderBingoPasteReview();
}

function renderBingoPasteReview() {
  const el = document.getElementById('bingo-paste-review');
  if (!bingoPasteMatches.length) { el.innerHTML = ''; return; }
  const chosen = bingoPasteMatches.filter((m) => m.choice >= 0).length;
  el.innerHTML = '<div style="font-size:12px;color:var(--sub);margin-bottom:8px;">Check each match — click the right version, or Skip. Nothing is added until you click Add.</div>'
    + bingoPasteMatches.map((m, i) => '<div class="bingo-paste-item">'
      + '<div class="bingo-paste-line">' + (i + 1) + '. ' + escHtml(m.line) + '</div>'
      + (m.error ? '<div style="color:var(--red);font-size:12px;">' + escHtml(m.error) + '</div>'
        : (m.hits.length ? '' : '<div style="color:var(--amber);font-size:12px;">No match on Spotify — try the search box with different wording.</div>')
          + m.hits.map((t, h) => bingoSpotifyHitHtml(t, 'setBingoPasteChoice(' + i + ',' + h + ')',
            '<span class="bingo-radio' + (m.choice === h ? ' on' : '') + '"></span>')).join('')
          + (m.hits.length ? '<div class="bingo-paste-skip' + (m.choice === -1 ? ' on' : '') + '" onclick="setBingoPasteChoice(' + i + ',-1)"><span class="bingo-radio' + (m.choice === -1 ? ' on' : '') + '"></span> Skip this line</div>' : ''))
      + '</div>').join('')
    + '<button class="btn btn-primary btn-sm" style="margin-top:8px;" onclick="addBingoPasteSelections()"' + (chosen ? '' : ' disabled') + '>Add ' + chosen + ' Selected Song' + (chosen === 1 ? '' : 's') + '</button>';
}

function setBingoPasteChoice(i, h) {
  bingoPasteMatches[i].choice = h;
  renderBingoPasteReview();
}

function addBingoPasteSelections() {
  let added = 0, reused = 0;
  const problems = [];
  bingoPasteMatches.forEach((m) => {
    if (m.choice < 0) return;
    const r = bingoAddSpotifyTrack(m.hits[m.choice]);
    if (r.error) problems.push(m.line + ' (' + r.error + ')');
    else { added++; if (r.reused) reused++; }
  });
  bingoPasteMatches = [];
  document.getElementById('bingo-paste').value = '';
  renderBingoPasteReview();
  renderBingoEditSongs();
  toast('Added ' + added + ' song' + (added === 1 ? '' : 's')
    + (reused ? ' (' + reused + ' already in the Song Bank — kept the version picked first)' : '')
    + (problems.length ? '. Skipped: ' + problems.join('; ') : ''), problems.length > 0);
}

// Returns the api result, or { error } (and alerts unless quiet).
async function syncBingoPlaylist(id, quiet) {
  const pl = bingoPlaylists.find((p) => p.id === id);
  const title = pl ? pl.title : 'playlist';
  const btn = document.getElementById('bingo-sync-' + id);
  if (btn) { btn.disabled = true; btn.textContent = 'Syncing…'; }
  let result;
  try {
    result = await bingoApi('spotify-sync-playlist', { playlist_id: id });
    if (!quiet) bingoShowSyncReport([{ title, result }]);
  } catch (e) {
    result = { error: e.message };
    if (!quiet) bingoShowSyncReport([{ title, result }]);
  }
  await bingoLoadPlaylists();
  renderBingoPlaylistList();
  return result;
}

async function syncAllBingoPlaylists() {
  const targets = bingoPlaylists.filter((p) => p.song_count > 0).map((p) => ({ id: p.id, title: p.title }));
  if (!targets.length) return;
  const reports = [];
  for (let i = 0; i < targets.length; i++) {
    const b = document.getElementById('bingo-sync-all-btn');
    if (b) { b.disabled = true; b.textContent = 'Syncing ' + (i + 1) + ' / ' + targets.length + '…'; }
    reports.push({ title: targets[i].title, result: await syncBingoPlaylist(targets[i].id, true) });
  }
  bingoShowSyncReport(reports);
}

function bingoShowSyncReport(reports) {
  const failed = reports.filter((r) => r.result.error);
  const lines = reports.map(({ title, result }) => result.error
    ? '✗ "' + title + '": ' + result.error
    : '✓ "' + title + '" synced to Spotify (' + result.synced + ' songs).');
  bingoAlert('bingo-pl-alert', lines.join('\n'), failed.length > 0);
  const el = document.getElementById('bingo-pl-alert');
  el.style.whiteSpace = 'pre-line';
  el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ── SONG BANK ─────────────────────────────────────
// Every song ever added, with usage. Songs typed in before Spotify was
// required (migration_028) are listed first and linked one by one:
// each shows its top Spotify matches, and picking one replaces the
// typed spelling with Spotify's — or merges it into the bank's song if
// that song is already there (link_bingo_song).
let bingoSongBank = [];
const bingoLinkHits = {};  // song id → Spotify search results (or { error })

async function loadBingoSongBank() {
  const [{ data, error }] = await Promise.all([
    window.supabase.from('bingo_songs')
      .select('id,title,artist,times_used,last_used_on,spotify_track_id,bingo_playlist_songs(count)')
      .order('title'),
    bingoLoadSpotifyStatus(),
  ]);
  if (error) { document.getElementById('bingo-songs-list').innerHTML = '<div class="loading">Error: ' + escHtml(error.message) + '</div>'; return; }
  bingoSongBank = (data || []).map((s) => Object.assign({}, s, {
    playlist_count: (s.bingo_playlist_songs && s.bingo_playlist_songs[0] && s.bingo_playlist_songs[0].count) || 0,
  }));
  document.getElementById('bingo-songs-spotify-note').innerHTML = bingoSpotify.connected ? ''
    : '<div class="bingo-warning" style="margin-bottom:12px;">&#9888; Spotify isn\'t connected, so songs can\'t be linked right now.</div>';
  renderBingoUnlinkedSongs();
  renderBingoSongBankList();
  if (bingoSpotify.connected) bingoAutoSearchUnlinked();
}

function renderBingoUnlinkedSongs() {
  const el = document.getElementById('bingo-songs-unlinked');
  const unlinked = bingoSongBank.filter((s) => !s.spotify_track_id);
  if (!unlinked.length) { el.innerHTML = ''; return; }
  el.innerHTML = '<div class="section-label" style="margin-top:0;">Needs a Spotify Link (' + unlinked.length + ')</div>'
    + '<div style="font-size:12px;color:var(--sub);margin-bottom:12px;">These were typed in before songs had to come from Spotify. Pick the right version for each — its Spotify title and artist replace what was typed. Afterwards, sync the affected playlists from the Playlists tab.</div>'
    + '<div class="bingo-link-grid">' + unlinked.map((s) => {
      const hits = bingoLinkHits[s.id];
      const results = !bingoSpotify.connected ? ''
        : !hits ? '<div class="loading" style="padding:8px;">Finding matches…</div>'
        : hits.error ? '<div style="color:var(--red);font-size:12px;padding:6px 0;">' + escHtml(hits.error) + '</div>'
        : !hits.length ? '<div style="color:var(--amber);font-size:12px;padding:6px 0;">No matches — try different wording.</div>'
        : hits.map((t, h) => bingoSpotifyHitHtml(t, 'linkBingoSongTo(\'' + s.id + '\',' + h + ')', '<span class="btn btn-secondary btn-sm">Use</span>')).join('');
      return '<div class="card" style="padding:12px;">'
        + '<div style="font-weight:500;">' + escHtml(s.title) + '</div><div style="font-size:12px;color:var(--sub);margin-bottom:8px;">' + escHtml(s.artist)
        + ' · on ' + s.playlist_count + ' playlist' + (s.playlist_count === 1 ? '' : 's') + ' · used ' + s.times_used + 'x</div>'
        + (bingoSpotify.connected ? '<div style="display:flex;gap:6px;margin-bottom:6px;"><input class="form-input" style="flex:1;padding:5px 8px;font-size:12px;" id="bingo-link-q-' + s.id + '" value="' + escHtml(s.title + ' ' + s.artist) + '" onkeydown="if(event.key===\'Enter\')searchBingoLink(\'' + s.id + '\')">'
          + '<button class="btn btn-secondary btn-sm" onclick="searchBingoLink(\'' + s.id + '\')">Search</button></div>' : '')
        + '<div id="bingo-link-results-' + s.id + '">' + results + '</div></div>';
    }).join('') + '</div>';
}

// Loads matches for every unlinked song, two at a time, so they're
// ready to pick from without clicking Search on each.
async function bingoAutoSearchUnlinked() {
  const queue = bingoSongBank.filter((s) => !s.spotify_track_id && !bingoLinkHits[s.id]);
  const worker = async () => {
    while (queue.length) {
      const s = queue.shift();
      await searchBingoLink(s.id, s.title + ' ' + s.artist);
    }
  };
  await Promise.all([worker(), worker()]);
}

async function searchBingoLink(songId, query) {
  const input = document.getElementById('bingo-link-q-' + songId);
  const q = (query || (input ? input.value : '')).trim();
  if (!q) return;
  const box = document.getElementById('bingo-link-results-' + songId);
  if (box && !query) box.innerHTML = '<div class="loading" style="padding:8px;">Searching…</div>';
  try {
    bingoLinkHits[songId] = (await bingoApi('spotify-search', { q, limit: 5 })).tracks;
  } catch (e) {
    bingoLinkHits[songId] = { error: e.message };
  }
  // Only this card's results change — don't rebuild the whole grid
  // (that would wipe what someone is typing in another card).
  const song = bingoSongBank.find((s) => s.id === songId);
  if (box && song) {
    const hits = bingoLinkHits[songId];
    box.innerHTML = hits.error ? '<div style="color:var(--red);font-size:12px;padding:6px 0;">' + escHtml(hits.error) + '</div>'
      : !hits.length ? '<div style="color:var(--amber);font-size:12px;padding:6px 0;">No matches — try different wording.</div>'
      : hits.map((t, h) => bingoSpotifyHitHtml(t, 'linkBingoSongTo(\'' + songId + '\',' + h + ')', '<span class="btn btn-secondary btn-sm">Use</span>')).join('');
  }
}

async function linkBingoSongTo(songId, h) {
  const t = (bingoLinkHits[songId] || [])[h];
  const song = bingoSongBank.find((s) => s.id === songId);
  if (!t || !song) return;
  const { data: keptId, error } = await window.supabase.rpc('link_bingo_song', {
    p_song_id: songId, p_track_id: t.id, p_title: bingoCleanSpotifyTitle(t.title), p_artist: t.artist,
  });
  if (error) { toast(error.message, true); return; }
  logAudit('link_bingo_song', 'bingo_songs', keptId, { from: song.title + ' – ' + song.artist, spotify_track_id: t.id });
  toast(keptId === songId
    ? 'Linked: ' + bingoCleanSpotifyTitle(t.title) + ' – ' + t.artist
    : '"' + song.title + '" was already in the Song Bank — merged into it');
  delete bingoLinkHits[songId];
  const { data } = await window.supabase.from('bingo_songs')
    .select('id,title,artist,times_used,last_used_on,spotify_track_id,bingo_playlist_songs(count)').order('title');
  bingoSongBank = (data || []).map((s) => Object.assign({}, s, {
    playlist_count: (s.bingo_playlist_songs && s.bingo_playlist_songs[0] && s.bingo_playlist_songs[0].count) || 0,
  }));
  // Drop just this card rather than re-rendering the grid.
  const card = document.getElementById('bingo-link-results-' + songId);
  if (card && card.closest('.card')) card.closest('.card').remove();
  const left = bingoSongBank.filter((s) => !s.spotify_track_id).length;
  const label = document.querySelector('#bingo-songs-unlinked .section-label');
  if (!left) renderBingoUnlinkedSongs();
  else if (label) label.textContent = 'Needs a Spotify Link (' + left + ')';
  renderBingoSongBankList();
}

function renderBingoSongBankList() {
  const el = document.getElementById('bingo-songs-list');
  const f = document.getElementById('bingo-songs-filter').value.trim().toLowerCase();
  const rows = bingoSongBank.filter((s) => !f || (s.title + ' ' + s.artist).toLowerCase().includes(f));
  if (!rows.length) { el.innerHTML = '<div class="loading">' + (bingoSongBank.length ? 'No songs match.' : 'No songs yet.') + '</div>'; return; }
  el.innerHTML = '<div class="table-wrap"><table><thead><tr><th>Song</th><th>Playlists</th><th>Times Used</th><th>Last Used</th><th>Spotify</th></tr></thead><tbody>'
    + rows.map((s) => '<tr><td><div style="font-weight:500;">' + escHtml(s.title) + '</div><div style="font-size:11px;color:var(--sub);">' + escHtml(s.artist) + '</div></td>'
      + '<td>' + s.playlist_count + '</td><td>' + s.times_used + '</td><td style="font-size:12px;">' + bingoFmtDate(s.last_used_on) + '</td>'
      + '<td style="font-size:12px;">' + (s.spotify_track_id
        ? '<a href="https://open.spotify.com/track/' + encodeURIComponent(s.spotify_track_id) + '" target="_blank" rel="noopener" style="color:#1DB954;">Open &#8599;</a>'
        : '<span class="badge badge-red">Not linked</span>') + '</td></tr>').join('')
    + '</tbody></table></div>';
}

// ── WIN PATTERNS ──────────────────────────────────
async function loadBingoPatternsTab() {
  await bingoLoadPatterns();
  renderBingoPatternEditor();
  renderBingoPatternList();
}

function renderBingoPatternEditor() {
  let html = '';
  for (let i = 0; i < 25; i++) {
    if (i === BINGO_FREE_CELL) html += '<button class="free" disabled>FREE</button>';
    else html += '<button class="' + (bingoPatternCells.has(i) ? 'on' : '') + '" onclick="toggleBingoPatternCell(' + i + ')"></button>';
  }
  document.getElementById('bingo-pat-grid').innerHTML = html;
}

function toggleBingoPatternCell(i) {
  if (bingoPatternCells.has(i)) bingoPatternCells.delete(i); else bingoPatternCells.add(i);
  renderBingoPatternEditor();
}

function renderBingoPatternList() {
  const el = document.getElementById('bingo-pat-list');
  if (!bingoPatterns.length) { el.innerHTML = '<div class="loading">No patterns saved yet.</div>'; return; }
  el.innerHTML = bingoPatterns.map((p) => '<div class="card" style="padding:14px;">'
    + '<div style="display:flex;justify-content:center;margin-bottom:10px;">' + bingoMiniGrid(p.cells, 16) + '</div>'
    + '<div style="font-weight:500;text-align:center;margin-bottom:2px;">' + escHtml(p.name) + '</div>'
    + '<div style="font-size:11px;color:var(--sub);text-align:center;margin-bottom:10px;">' + escHtml(p.staff_profiles ? p.staff_profiles.name : 'Built in') + '</div>'
    + '<div style="display:flex;gap:6px;justify-content:center;"><button class="btn btn-secondary btn-sm" onclick="editBingoPattern(\'' + p.id + '\')">Edit</button>'
    + (bingoCanDelete(p) ? '<button class="btn btn-danger btn-sm" onclick="deleteBingoPattern(\'' + p.id + '\')">Delete</button>' : '')
    + '</div></div>').join('');
}

function editBingoPattern(id) {
  const p = bingoPatterns.find((x) => x.id === id);
  if (!p) return;
  bingoEditPatternId = id;
  bingoPatternCells = new Set(p.cells);
  document.getElementById('bingo-pat-name').value = p.name;
  document.getElementById('bingo-pat-form-label').textContent = 'Edit Win Pattern';
  document.getElementById('bingo-pat-cancel').style.visibility = 'visible';
  bingoClearAlert('bingo-pat-alert');
  renderBingoPatternEditor();
}

function resetBingoPatternForm() {
  bingoEditPatternId = null;
  bingoPatternCells = new Set();
  document.getElementById('bingo-pat-name').value = '';
  document.getElementById('bingo-pat-form-label').textContent = 'New Win Pattern';
  document.getElementById('bingo-pat-cancel').style.visibility = 'hidden';
  bingoClearAlert('bingo-pat-alert');
  renderBingoPatternEditor();
}

async function saveBingoPattern() {
  const name = document.getElementById('bingo-pat-name').value.trim();
  if (!name) { bingoAlert('bingo-pat-alert', 'Give the pattern a name.', true); return; }
  if (!bingoPatternCells.size) { bingoAlert('bingo-pat-alert', 'Mark at least one square.', true); return; }
  const cells = Array.from(bingoPatternCells).sort((a, b) => a - b);
  const q = bingoEditPatternId
    ? window.supabase.from('bingo_patterns').update({ name, cells }).eq('id', bingoEditPatternId)
    : window.supabase.from('bingo_patterns').insert({ name, cells, created_by: window.currentStaff.id });
  const { error } = await q;
  if (error) {
    bingoAlert('bingo-pat-alert', error.code === '23505' ? 'A pattern named "' + name + '" already exists.' : error.message, true);
    return;
  }
  toast('Pattern saved');
  resetBingoPatternForm();
  await loadBingoPatternsTab();
}

async function deleteBingoPattern(id) {
  const p = bingoPatterns.find((x) => x.id === id);
  if (!p || !confirm('Delete the pattern "' + p.name + '"? Past games keep their copy of it.')) return;
  const { error } = await window.supabase.from('bingo_patterns').delete().eq('id', id);
  if (error) { toast(error.message, true); return; }
  toast('Pattern deleted');
  if (bingoEditPatternId === id) resetBingoPatternForm();
  await loadBingoPatternsTab();
}

// ── NEW GAME ──────────────────────────────────────
async function loadBingoNewGameTab() {
  await Promise.all([bingoLoadPlaylists(), bingoLoadPatterns()]);
  const dateEl = document.getElementById('bingo-game-date');
  if (!dateEl.value) dateEl.value = bingoToday();
  renderBingoRounds();
}

function renderBingoRounds() {
  // keep selections across re-renders
  const prev = [1, 2, 3].map((r) => ({
    pl: (document.getElementById('bingo-r' + r + '-playlist') || {}).value || '',
    pat: (document.getElementById('bingo-r' + r + '-pattern') || {}).value || '',
  }));
  const complete = bingoPlaylists.filter(bingoIsComplete);
  const admin = bingoIsAdmin();

  const playlistOptions = (selected) => '<option value="">Choose a playlist…</option>' + complete.map((p) => {
    const cooling = bingoIsCooling(p);
    const label = p.title + (cooling ? ' — used ' + bingoFmtDate(p.last_used_on, { month: 'short', day: 'numeric' }) + ', ready ' + bingoFmtDate(bingoReadyOn(p), { month: 'short', day: 'numeric' }) : '');
    return '<option value="' + p.id + '"' + (p.id === selected ? ' selected' : '')
      + (cooling ? (admin ? ' style="color:#777;"' : ' disabled') : '') + '>' + escHtml(label) + '</option>';
  }).join('');
  const patternOptions = (selected) => '<option value="">Choose a win pattern…</option>'
    + bingoPatterns.map((p) => '<option value="' + p.id + '"' + (p.id === selected ? ' selected' : '') + '>' + escHtml(p.name) + '</option>').join('');

  document.getElementById('bingo-game-rounds').innerHTML = [1, 2, 3].map((r) => '<div class="bingo-round">'
    + '<div class="bingo-round-title">Round ' + r + '</div>'
    + '<div class="form-group" style="margin-bottom:10px;"><label class="form-label">Playlist</label>'
    + '<select class="form-select" style="width:100%;" id="bingo-r' + r + '-playlist" onchange="renderBingoRoundNotes()">' + playlistOptions(prev[r - 1].pl) + '</select></div>'
    + (r === 1
      ? '<div style="font-size:12px;color:var(--sub);">Win: <strong style="color:var(--text);">5 in a Row</strong> — any row, column, or diagonal</div>'
      : '<div class="form-group"><label class="form-label">Win Pattern</label><div style="display:flex;gap:10px;align-items:center;">'
        + '<select class="form-select" style="flex:1;" id="bingo-r' + r + '-pattern" onchange="renderBingoRoundNotes()">' + patternOptions(prev[r - 1].pat) + '</select>'
        + '<span id="bingo-r' + r + '-pattern-preview"></span></div></div>')
    + '<div id="bingo-r' + r + '-note"></div>'
    + '</div>').join('')
    + (complete.length ? '' : '<div class="loading">No playlists have 24 songs yet.</div>')
    + (bingoPatterns.length ? '' : '<div class="loading">Save a win pattern first (Win Patterns tab).</div>');
  renderBingoRoundNotes();
}

function renderBingoRoundNotes() {
  [1, 2, 3].forEach((r) => {
    const plId = document.getElementById('bingo-r' + r + '-playlist').value;
    const pl = bingoPlaylists.find((p) => p.id === plId);
    const note = document.getElementById('bingo-r' + r + '-note');
    note.innerHTML = (pl && bingoIsCooling(pl)
      ? '<div class="bingo-warning">&#9888; "' + escHtml(pl.title) + '" was used on ' + bingoFmtDate(pl.last_used_on)
        + ' — inside the ' + BINGO_COOLDOWN_DAYS + '-day window (ready ' + bingoFmtDate(bingoReadyOn(pl)) + '). Printing will use your admin override.</div>'
      : '')
      + (pl && (!pl.spotify_playlist_id || pl.spotify_dirty)
        ? '<div class="bingo-warning">&#9888; "' + escHtml(pl.title) + '" isn\'t synced to Spotify, so it can\'t be printed yet — sync it on the Playlists tab (link any unlinked songs in the Song Bank first).</div>'
        : '');
    if (r > 1) {
      const pat = bingoPatterns.find((p) => p.id === document.getElementById('bingo-r' + r + '-pattern').value);
      document.getElementById('bingo-r' + r + '-pattern-preview').innerHTML = pat ? bingoMiniGrid(pat.cells) : '';
    }
  });
}

// One-off events + expanded recurring events in [startStr, endStr],
// as [{date, time, name}] sorted by date then time.
async function bingoFetchEvents(startStr, endStr) {
  const endExclusive = bingoAddDays(endStr, 1);
  const [{ data: oneOff }] = await Promise.all([
    window.supabase.from('events').select('event_name,event_date').gte('event_date', startStr + 'T00:00:00').lt('event_date', endExclusive + 'T00:00:00'),
    refreshRecurringData(),
  ]);
  const list = (oneOff || []).map((e) => {
    const d = new Date(e.event_date);
    return { date: toDateStr(d), time: fmtTime(String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')), name: e.event_name };
  });
  computeRecurringOccurrences(new Date(startStr + 'T00:00:00'), new Date(endStr + 'T00:00:00')).forEach((o) => {
    list.push({ date: o.date, time: o.start_time ? fmtTime(o.start_time) : '', name: o.name });
  });
  const minutes = (t) => { const m = /^(\d+)(?::(\d+))?(am|pm)$/.exec(t || ''); return m ? ((+m[1] % 12) + (m[3] === 'pm' ? 12 : 0)) * 60 + (+m[2] || 0) : -1; };
  return list.sort((a, b) => a.date.localeCompare(b.date) || minutes(a.time) - minutes(b.time));
}

// Validated New Game form, or null (with the alert shown).
function bingoReadGameForm() {
  bingoClearAlert('bingo-game-alert');
  const eventDate = document.getElementById('bingo-game-date').value;
  const sheets = parseInt(document.getElementById('bingo-game-sheets').value, 10);
  const fail = (msg) => { bingoAlert('bingo-game-alert', msg, true); return null; };
  if (!eventDate) return fail('Pick the game night date.');
  if (!(sheets >= 1 && sheets <= 200)) return fail('Sheets must be between 1 and 200.');

  const rounds = [1, 2, 3].map((r) => ({
    round_no: r,
    playlist_id: document.getElementById('bingo-r' + r + '-playlist').value,
    pattern_id: r === 1 ? null : document.getElementById('bingo-r' + r + '-pattern').value,
  }));
  if (rounds.some((r) => !r.playlist_id)) return fail('Choose a playlist for every round.');
  if (new Set(rounds.map((r) => r.playlist_id)).size < 3) return fail('Each round needs a different playlist.');
  if (rounds.some((r) => r.round_no > 1 && !r.pattern_id)) return fail('Choose a win pattern for rounds 2 and 3.');
  return { eventDate, sheets, rounds, pls: rounds.map((r) => bingoPlaylists.find((p) => p.id === r.playlist_id)) };
}

function bingoFetchGameEvents(eventDate) {
  return Promise.all([
    bingoFetchEvents(eventDate, bingoAddDays(eventDate, 6)),
    bingoFetchEvents(bingoAddDays(eventDate, 1), bingoAddDays(eventDate, 14)),
  ]);
}

// Builds an unsaved game in the same shape bingoLoadGame() returns —
// a few sample sheets with random shuffles — so the real renderers can
// show exactly what will print, without marking anything used.
const BINGO_PREVIEW_SHEETS = 3;
async function bingoBuildPreviewGame() {
  const form = bingoReadGameForm();
  if (!form) return null;
  const [songLists, [sheetEvents, slideEvents]] = await Promise.all([
    Promise.all(form.rounds.map((r) => window.supabase.from('bingo_playlist_songs')
      .select('position, bingo_songs(id, title, artist)').eq('playlist_id', r.playlist_id).order('position'))),
    bingoFetchGameEvents(form.eventDate),
  ]);
  const failed = songLists.find((res) => res.error);
  if (failed) { bingoAlert('bingo-game-alert', failed.error.message, true); return null; }

  const rounds = form.rounds.map((r, i) => {
    const pat = bingoPatterns.find((p) => p.id === r.pattern_id);
    return {
      round_no: r.round_no,
      playlist_title: form.pls[i].title,
      songs: songLists[i].data.map((row) => row.bingo_songs),
      pattern_name: pat ? pat.name : '5 in a Row',
      pattern_cells: pat ? pat.cells : null,
    };
  });
  const shuffle = () => {
    const a = Array.from({ length: 24 }, (_, i) => i);
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  };
  const cards = [];
  for (let s = 1; s <= BINGO_PREVIEW_SHEETS; s++) [1, 2, 3].forEach((r) => cards.push({ sheet_no: s, round_no: r, song_order: shuffle() }));
  return {
    game: { event_date: form.eventDate, sheet_count: form.sheets, sheet_events: sheetEvents, slide_events: slideEvents },
    rounds, cards, preview: true,
  };
}

async function previewBingoCards() {
  const g = await bingoBuildPreviewGame();
  if (g) openHtml(bingoCardSheetsHtml(g));
}

async function previewBingoSlideshow() {
  const g = await bingoBuildPreviewGame();
  if (g) openHtml(bingoSlideshowHtml(g));
}

async function printBingoGame() {
  const form = bingoReadGameForm();
  if (!form) return;
  const { eventDate, sheets, rounds, pls } = form;
  const overrides = pls.filter(bingoIsCooling);
  const readyAgain = bingoFmtDate(bingoAddDays(bingoToday(), BINGO_COOLDOWN_DAYS));
  if (!confirm('Print ' + sheets + ' sheets for ' + bingoFmtDate(eventDate) + '?\n\n'
    + pls.map((p, i) => 'Round ' + (i + 1) + ': ' + p.title).join('\n')
    + '\n\nThese 3 playlists will be marked as used today and return to rotation on ' + readyAgain + '.'
    + (overrides.length ? '\n\n⚠ Admin override: ' + overrides.map((p) => p.title).join(', ') + ' is still inside its 90 days.' : ''))) return;

  const btn = document.getElementById('bingo-print-btn');
  btn.disabled = true; btn.textContent = 'Printing…';
  try {
    const [sheetEvents, slideEvents] = await bingoFetchGameEvents(eventDate);
    const { data: gameId, error } = await window.supabase.rpc('create_bingo_game', {
      p_event_date: eventDate,
      p_sheet_count: sheets,
      p_rounds: rounds,
      p_sheet_events: sheetEvents,
      p_slide_events: slideEvents,
    });
    if (error) { bingoAlert('bingo-game-alert', error.message, true); return; }
    logAudit('print_bingo_game', 'bingo_games', gameId, { event_date: eventDate, sheets, playlists: pls.map((p) => p.title), override: overrides.length > 0 });
    toast('Game saved — open the card sheets and slideshow on the right');
    document.getElementById('bingo-game-output').innerHTML = '<div style="font-weight:500;margin-bottom:4px;">Game for ' + escHtml(bingoFmtDate(eventDate)) + ' is ready.</div>'
      + '<div style="font-size:12px;color:var(--sub);margin-bottom:14px;">' + sheets + ' sheets · ' + pls.map((p) => escHtml(p.title)).join(' · ') + '</div>'
      + bingoOutputButtons(gameId);
    await bingoLoadPlaylists();
    document.getElementById('bingo-game-rounds').innerHTML = '';
    renderBingoRounds();
  } finally {
    btn.disabled = false; btn.textContent = 'Print Game';
  }
}

function bingoOutputButtons(gameId) {
  return '<div style="display:flex;gap:8px;flex-wrap:wrap;">'
    + '<button class="btn btn-primary btn-sm" onclick="openBingoCardSheets(\'' + gameId + '\')">Card Sheets</button>'
    + '<button class="btn btn-secondary btn-sm" onclick="openBingoSlideshow(\'' + gameId + '\')">TV Slideshow</button></div>';
}

// ── HISTORY ───────────────────────────────────────
async function loadBingoHistory() {
  const el = document.getElementById('bingo-history-list');
  const { data, error } = await window.supabase.from('bingo_games')
    .select('id, event_date, printed_on, sheet_count, cooldown_overridden, staff_profiles(name), bingo_game_rounds(round_no, playlist_title, pattern_name)')
    .order('printed_at', { ascending: false }).limit(100);
  if (error) { el.innerHTML = '<div class="loading">Error: ' + escHtml(error.message) + '</div>'; return; }
  if (!data || !data.length) { el.innerHTML = '<div class="loading">No games printed yet.</div>'; return; }
  el.innerHTML = '<div class="table-wrap"><table><thead><tr><th>Game Night</th><th>Round 1</th><th>Round 2</th><th>Round 3</th><th>Sheets</th><th>Printed</th><th></th></tr></thead><tbody>'
    + data.map((g) => {
      const rounds = (g.bingo_game_rounds || []).sort((a, b) => a.round_no - b.round_no);
      return '<tr><td style="font-weight:500;">' + bingoFmtDate(g.event_date)
        + (g.cooldown_overridden ? '<br><span class="badge badge-amber">90-day override</span>' : '') + '</td>'
        + rounds.map((r) => '<td>' + escHtml(r.playlist_title) + '<div style="font-size:11px;color:var(--sub);">' + escHtml(r.pattern_name) + '</div></td>').join('')
        + '<td>' + g.sheet_count + '</td>'
        + '<td style="font-size:12px;">' + bingoFmtDate(g.printed_on) + '<div style="font-size:11px;color:var(--sub);">' + escHtml(g.staff_profiles ? g.staff_profiles.name : '') + '</div></td>'
        + '<td>' + bingoOutputButtons(g.id)
        + (bingoIsAdmin() ? '<button class="btn btn-danger btn-sm" style="margin-top:6px;" onclick="deleteBingoGame(\'' + g.id + '\', \'' + g.event_date + '\')">Delete</button>' : '')
        + '</td></tr>';
    }).join('')
    + '</tbody></table></div>'
    + '<div style="font-size:11px;color:var(--muted);margin-top:8px;">Reopening a past game reprints the exact same cards and doesn\'t count as another use.'
    + (bingoIsAdmin() ? ' Deleting a game undoes its use: counts go back down and its playlists return to their previous last-used date.' : '') + '</div>';
}

async function deleteBingoGame(gameId, eventDate) {
  if (!confirm('Delete the game for ' + bingoFmtDate(eventDate) + '?\n\nIts cards can no longer be reprinted, and its playlists and songs are un-marked as used (counts go back down).')) return;
  const { error } = await window.supabase.rpc('delete_bingo_game', { p_game_id: gameId });
  if (error) { toast(error.message, true); return; }
  logAudit('delete_bingo_game', 'bingo_games', gameId, { event_date: eventDate });
  toast('Game deleted');
  await loadBingoHistory();
}

// ── OUTPUT: shared ────────────────────────────────
async function bingoLoadGame(gameId) {
  const [{ data: game, error: gErr }, { data: rounds, error: rErr }, { data: cards, error: cErr }] = await Promise.all([
    window.supabase.from('bingo_games').select('*').eq('id', gameId).single(),
    window.supabase.from('bingo_game_rounds').select('*').eq('game_id', gameId).order('round_no'),
    window.supabase.from('bingo_game_cards').select('round_no, sheet_no, song_order').eq('game_id', gameId).order('sheet_no').order('round_no').limit(1000),
  ]);
  const err = gErr || rErr || cErr;
  if (err) { toast('Could not load game: ' + err.message, true); return null; }
  return { game, rounds, cards };
}

// Win-pattern grid as inline HTML for the print pages. cells = null
// draws round 1's "5 in a row" as its three example shapes.
function bingoPrintPattern(cells, cellSize) {
  const grid = (on) => {
    let h = '<div class="pat" style="grid-template-columns:repeat(5,' + cellSize + ');grid-auto-rows:' + cellSize + ';">';
    for (let i = 0; i < 25; i++) h += '<span class="' + (i === BINGO_FREE_CELL ? 'free' : (on.has(i) ? 'on' : '')) + '"></span>';
    return h + '</div>';
  };
  if (cells) return grid(new Set(cells));
  return '<div class="pat-row">' + grid(new Set([10, 11, 13, 14])) + grid(new Set([2, 7, 17, 22])) + grid(new Set([0, 6, 18, 24])) + '</div>';
}

const BINGO_PAT_CSS = '.pat{display:grid;gap:2px;}.pat span{border:1px solid #1a1410;background:#fff;}.pat span.on{background:#1a1410;}.pat span.free{background:#c4c4c4;border-color:#c4c4c4;}.pat-row{display:flex;gap:8px;justify-content:center;}';
const BINGO_TOOLBAR_CSS = '.toolbar{position:fixed;top:12px;right:12px;z-index:10;display:flex;gap:8px;font-family:Inter,sans-serif;}.toolbar button{padding:8px 16px;border:none;border-radius:6px;background:#8b3a1a;color:#fff;font-weight:600;cursor:pointer;}.toolbar span{background:rgba(0,0,0,0.6);color:#fff;padding:8px 12px;border-radius:6px;font-size:12px;}@media print{.toolbar{display:none;}}';

// ── OUTPUT: card sheets (8.5x11 portrait) ─────────
// Quadrants: TL = round 1, TR = info (rules, events, patterns),
// BL = round 2, BR = round 3. Black and white only — the logo is the
// one color element. The page's padding keeps everything clear of
// the printer's unprintable edge.
const BINGO_SHEET_CSS = PRINT_RESET + '*{box-sizing:border-box;margin:0;padding:0;}body{background:#777;font-family:Inter,sans-serif;color:#1a1410;}'
  + '.page{width:8.5in;height:11in;padding:0.12in;background:#fff;margin:0 auto 0.3in;display:grid;grid-template-columns:1fr 1fr;grid-template-rows:1fr 1fr;page-break-after:always;overflow:hidden;}'
  + '@media print{.page{margin:0;}}'
  + '.quad{padding:0.16in;display:flex;flex-direction:column;overflow:hidden;}'
  + '.quad:nth-child(1){border-right:1px dashed #bbb;border-bottom:1px dashed #bbb;}.quad:nth-child(2){border-bottom:1px dashed #bbb;}.quad:nth-child(3){border-right:1px dashed #bbb;}'
  + '.card-head{display:flex;justify-content:space-between;align-items:baseline;border-bottom:2px solid #1a1410;padding-bottom:3px;margin-bottom:2px;}'
  + '.round{font-family:Oswald,sans-serif;font-size:20px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;line-height:1;}'
  + '.win{font-family:Oswald,sans-serif;font-size:10px;font-weight:600;letter-spacing:0.12em;text-transform:uppercase;}'
  + '.playlist{font-family:Oswald,sans-serif;font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;margin-bottom:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}'
  + '.grid{display:grid;grid-template-columns:repeat(5,1fr);grid-template-rows:repeat(5,0.82in);border:2px solid #1a1410;}'
  + '.cell{border:0.75px solid #1a1410;padding:3px;display:flex;flex-direction:column;justify-content:center;align-items:center;text-align:center;overflow:hidden;}'
  + '.t{font-weight:700;line-height:1.1;overflow-wrap:anywhere;}.a{font-style:italic;font-weight:500;color:#222;line-height:1.1;margin-top:2px;overflow-wrap:anywhere;}'
  + '.free img{width:0.44in;height:0.44in;object-fit:contain;}.free b{font-family:Oswald,sans-serif;font-size:11px;letter-spacing:0.15em;}'
  + '.card-foot{margin-top:auto;padding-top:4px;font-size:8px;color:#555;text-align:right;font-family:Oswald,sans-serif;letter-spacing:0.1em;}'
  + '.brand{display:flex;align-items:center;gap:8px;}.brand img{width:0.58in;height:0.58in;object-fit:contain;}'
  + '.brand-name{font-family:Oswald,sans-serif;font-size:9px;font-weight:600;letter-spacing:0.18em;text-transform:uppercase;}'
  + '.title{font-family:Oswald,sans-serif;font-size:30px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;line-height:0.95;}'
  + '.date{font-size:9px;color:#444;margin:4px 0 6px;}'
  + '.h{font-family:Oswald,sans-serif;font-size:10px;font-weight:700;letter-spacing:0.18em;text-transform:uppercase;border-bottom:1.5px solid #1a1410;margin:6px 0 3px;}'
  + '.keep{background:#1a1410;color:#fff;font-family:Oswald,sans-serif;font-size:12.5px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;text-align:center;padding:5px 6px;line-height:1.2;margin:3px 0 4px;}'
  + '.rules{font-size:8.5px;line-height:1.35;padding-left:12px;}.ev{font-size:8.5px;line-height:1.4;display:flex;gap:6px;}.ev b{min-width:0.62in;}'
  + '.pats-block{margin-top:auto;text-align:center;}'
  + '.pats .lbl{font-family:Oswald,sans-serif;font-size:9px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;margin-bottom:3px;}'
  + '.pats .nm{font-size:7.5px;color:#333;margin-top:3px;}.pats .pat{justify-content:center;}'
  + '.pats-r1{margin-bottom:5px;}.pats-r23{display:grid;grid-template-columns:1fr 1fr;gap:6px;}'
  + BINGO_PAT_CSS + BINGO_TOOLBAR_CSS;

function bingoCellHtml(song) {
  const len = song.title.length;
  const tSize = len > 40 ? 6.5 : len > 26 ? 7.5 : len > 16 ? 8.5 : 9.5;
  const aSize = song.artist.length > 28 ? 7 : 8;
  return '<div class="cell"><div class="t" style="font-size:' + tSize + 'px;">' + escHtml(song.title) + '</div>'
    + '<div class="a" style="font-size:' + aSize + 'px;">' + escHtml(song.artist) + '</div></div>';
}

function bingoCardQuadrant(round, card, sheetLabel) {
  let cells = '', k = 0;
  for (let i = 0; i < 25; i++) {
    if (i === BINGO_FREE_CELL) cells += '<div class="cell free"><img src="' + LOGO_URL + '"><b>FREE</b></div>';
    else cells += bingoCellHtml(round.songs[card.song_order[k++]]);
  }
  return '<div class="quad"><div class="card-head"><span class="round">Round ' + round.round_no + '</span><span class="win">' + escHtml(round.pattern_name) + '</span></div>'
    + '<div class="playlist">' + escHtml(round.playlist_title) + '</div>'
    + '<div class="grid">' + cells + '</div>'
    + '<div class="card-foot">SHEET ' + sheetLabel + ' · R' + round.round_no + '</div></div>';
}

function bingoPatternBlock(r, cellSize) {
  return '<div><div class="lbl">Round ' + r.round_no + (r.pattern_cells ? '' : ' · 5 in a Row') + '</div>'
    + bingoPrintPattern(r.pattern_cells, cellSize)
    + '<div class="nm">' + escHtml(r.pattern_cells ? r.pattern_name : 'Any full row, column, or diagonal') + '</div></div>';
}

function bingoInfoQuadrant(g, sheetLabel) {
  const events = (g.game.sheet_events || []);
  const shown = events.slice(0, 5);
  const evHtml = shown.length
    ? shown.map((e) => '<div class="ev"><b>' + escHtml(bingoFmtDate(e.date, { weekday: 'short', month: 'numeric', day: 'numeric' })) + '</b><span>' + escHtml(e.name) + (e.time ? ' · ' + escHtml(e.time) : '') + '</span></div>').join('')
      + (events.length > shown.length ? '<div class="ev"><span>+ ' + (events.length - shown.length) + ' more — ask your bartender!</span></div>' : '')
    : '<div class="ev"><span>Ask your bartender what\'s coming up!</span></div>';
  const round = (n) => g.rounds.find((r) => r.round_no === n);
  return '<div class="quad info">'
    + '<div class="brand"><img src="' + LOGO_URL + '"><div><div class="brand-name">' + BINGO_BREWERY + '</div><div class="title">Music<br>Bingo</div></div></div>'
    + '<div class="date">' + escHtml(bingoFmtDate(g.game.event_date, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })) + ' · Sheet ' + sheetLabel + '</div>'
    + '<div class="h">How to Play</div>'
    + '<div class="keep">Your card for all 3 rounds — hang on to it!</div>'
    + '<ul class="rules">'
    + '<li>Listen for the songs — mark the square when you hear one on your card.</li>'
    + '<li><b>The first person to yell BINGO will have their card reviewed first — yell it loud!</b></li>'
    + '<li>Each round has its own card and winning pattern (below). The center is free.</li>'
    + '<li>Complete the pattern? Shout <b>BINGO!</b> and bring your sheet to the host to be checked.</li></ul>'
    + '<div class="h">This Week at LVBC</div>' + evHtml
    + '<div class="pats-block pats"><div class="h">Winning Patterns</div>'
    + '<div class="pats-r1">' + bingoPatternBlock(round(1), '0.09in') + '</div>'
    + '<div class="pats-r23">' + bingoPatternBlock(round(2), '0.14in') + bingoPatternBlock(round(3), '0.14in') + '</div></div>'
    + '</div>';
}

// g = bingoLoadGame() result, or bingoBuildPreviewGame() (g.preview).
function bingoCardSheetsHtml(g) {
  const bySheet = {};
  g.cards.forEach((c) => { (bySheet[c.sheet_no] = bySheet[c.sheet_no] || {})[c.round_no] = c; });
  const round = (n) => g.rounds.find((r) => r.round_no === n);
  const pages = Object.keys(bySheet).map(Number).sort((a, b) => a - b).map((s) => {
    const label = g.preview ? 'PREVIEW' : String(s).padStart(2, '0');
    return '<div class="page">'
      + bingoCardQuadrant(round(1), bySheet[s][1], label)
      + bingoInfoQuadrant(g, label)
      + bingoCardQuadrant(round(2), bySheet[s][2], label)
      + bingoCardQuadrant(round(3), bySheet[s][3], label)
      + '</div>';
  }).join('');
  const note = g.preview
    ? 'PREVIEW — ' + BINGO_PREVIEW_SHEETS + ' sample sheets, nothing saved. The real print has ' + g.game.sheet_count + ' sheets with fresh shuffles.'
    : g.game.sheet_count + ' sheets · print single-sided, Letter, no margins';
  return '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>' + (g.preview ? 'PREVIEW — ' : '') + 'Music Bingo Cards — ' + escHtml(bingoFmtDate(g.game.event_date)) + '</title>'
    + FONT_LINK + '<style>' + BINGO_SHEET_CSS + '</style></head><body>'
    + '<div class="toolbar"><span>' + note + '</span>' + (g.preview ? '' : '<button onclick="window.print()">Print / Save PDF</button>') + '</div>'
    + pages + '</body></html>';
}

async function openBingoCardSheets(gameId) {
  const g = await bingoLoadGame(gameId);
  if (g) openHtml(bingoCardSheetsHtml(g));
}

// ── OUTPUT: TV slideshow (16:9 pages → PDF) ───────
// Title → Round 1 → Round 2 → upcoming events (2 weeks) → Round 3.
const BINGO_SLIDE_CSS = '@media print{*{-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important;}@page{size:13.333in 7.5in;margin:0;}body{margin:0;background:none;}.slide{margin:0!important;}}'
  + '*{box-sizing:border-box;margin:0;padding:0;}body{background:#333;font-family:Inter,sans-serif;}'
  + '.slide{width:13.333in;height:7.5in;margin:0 auto 0.3in;background:#1a1410;color:#f4efe6;page-break-after:always;overflow:hidden;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:0.5in 0.8in;position:relative;}'
  + '.slide .logo{position:absolute;top:0.35in;left:0.45in;width:0.9in;height:0.9in;object-fit:contain;}'
  + '.kicker{font-family:Oswald,sans-serif;font-size:28px;font-weight:600;letter-spacing:0.3em;color:#c8a882;text-transform:uppercase;}'
  + '.big{font-family:Oswald,sans-serif;font-size:120px;font-weight:700;letter-spacing:0.05em;text-transform:uppercase;line-height:1;}'
  + '.pl{font-family:Oswald,sans-serif;font-size:64px;font-weight:700;text-transform:uppercase;text-align:center;line-height:1.05;margin:10px 0 28px;}'
  + '.sub{font-size:28px;color:#c8a882;margin-top:18px;}'
  + '.round-body{display:flex;align-items:center;gap:0.7in;}'
  + '.win-name{font-family:Oswald,sans-serif;font-size:44px;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;}'
  + '.win-desc{font-size:22px;color:#c8a882;margin-top:6px;max-width:4.5in;}'
  + '.slide .pat span{border-color:#f4efe6;background:transparent;}.slide .pat span.on{background:#c8663a;border-color:#c8663a;}.slide .pat span.free{background:#c8a882;border-color:#c8a882;}'
  + '.events{columns:2;column-gap:0.6in;width:100%;margin-top:26px;}.event{break-inside:avoid;font-size:24px;padding:8px 0;border-bottom:1px solid rgba(244,239,230,0.15);display:flex;gap:18px;}.event b{font-family:Oswald,sans-serif;min-width:1.6in;color:#c8a882;font-weight:600;}'
  + BINGO_PAT_CSS.replace(/#fff/g, 'transparent') + BINGO_TOOLBAR_CSS;

function bingoRoundSlide(r) {
  const isLine = !r.pattern_cells;
  return '<div class="slide"><img class="logo" src="' + LOGO_URL + '">'
    + '<div class="kicker">Round ' + r.round_no + '</div>'
    + '<div class="pl">' + escHtml(r.playlist_title) + '</div>'
    + '<div class="round-body">' + bingoPrintPattern(r.pattern_cells, isLine ? '0.42in' : '0.6in')
    + '<div><div class="kicker" style="font-size:20px;">To Win</div><div class="win-name">' + escHtml(r.pattern_name) + '</div>'
    + '<div class="win-desc">' + (isLine ? 'Any full row, column, or diagonal.' : 'Mark every highlighted square. The center is free.') + '</div></div></div></div>';
}

async function openBingoSlideshow(gameId) {
  const g = await bingoLoadGame(gameId);
  if (g) openHtml(bingoSlideshowHtml(g));
}

function bingoSlideshowHtml(g) {
  const round = (n) => g.rounds.find((r) => r.round_no === n);
  const events = g.game.slide_events || [];
  const eventsSlide = '<div class="slide"><img class="logo" src="' + LOGO_URL + '">'
    + '<div class="kicker">Coming Up at LVBC</div><div class="big" style="font-size:72px;">The Next Two Weeks</div>'
    + (events.length
      ? '<div class="events">' + events.slice(0, 16).map((e) => '<div class="event"><b>' + escHtml(bingoFmtDate(e.date, { weekday: 'short', month: 'short', day: 'numeric' })) + '</b><span>' + escHtml(e.name) + (e.time ? ' · ' + escHtml(e.time) : '') + '</span></div>').join('') + '</div>'
      : '<div class="sub">Follow us for upcoming events!</div>')
    + '</div>';
  const slides = '<div class="slide"><img class="logo" src="' + LOGO_URL + '">'
      + '<div class="kicker">' + BINGO_BREWERY + '</div><div class="big">Music Bingo</div>'
      + '<div class="sub">' + escHtml(bingoFmtDate(g.game.event_date, { weekday: 'long', month: 'long', day: 'numeric' })) + '</div></div>'
    + bingoRoundSlide(round(1)) + bingoRoundSlide(round(2)) + eventsSlide + bingoRoundSlide(round(3));
  return '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>' + (g.preview ? 'PREVIEW — ' : '') + 'Music Bingo Slideshow — ' + escHtml(bingoFmtDate(g.game.event_date)) + '</title>'
    + FONT_LINK + '<style>' + BINGO_SLIDE_CSS + '</style></head><body>'
    + '<div class="toolbar">' + (g.preview
      ? '<span>PREVIEW — nothing saved</span>'
      : '<span>Save as PDF, then present full-screen</span><button onclick="window.print()">Print / Save PDF</button>') + '</div>'
    + slides + '</body></html>';
}
