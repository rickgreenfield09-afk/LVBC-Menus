// admin.js
// Screen: #screen-admin — add/edit staff and their role + scheduling
// access. Only rendered for window.currentStaff.role === 'admin' (nav
// button is hidden otherwise in app-core.js) and enforced server-side
// by the "admin manage roster" RLS policy on staff_profiles plus the
// admin check inside api/invite-staff.js.
// Depends on: window.supabase, toast(), escHtml() (js/menu.js)

let staffRoster = [], selStaff = null, staffEditMode = false;
// ids of roster rows backed by a real login (migration_030), or null
// if that lookup isn't available — then no "No login" badges show.
let staffLoginIds = null;

async function loadAdmin() {
  await loadStaffRoster();
}

async function loadStaffRoster() {
  const el = document.getElementById('staff-list');
  el.innerHTML = '<div class="loading">Loading...</div>';
  const [{ data, error }, logins] = await Promise.all([
    window.supabase.from('staff_profiles').select('*').order('name', { ascending: true }),
    window.supabase.rpc('staff_profiles_with_login'),
  ]);
  if (error) { el.innerHTML = '<div class="loading">Error: ' + escHtml(error.message) + '</div>'; return; }
  staffRoster = data || [];
  staffLoginIds = logins.error ? null : new Set((logins.data || []).map((x) => (typeof x === 'string' ? x : Object.values(x)[0])));
  renderStaffRoster();
}

function staffHasLogin(s) {
  return !staffLoginIds || staffLoginIds.has(s.id);
}

function renderStaffRoster() {
  const el = document.getElementById('staff-list');
  if (!staffRoster.length) { el.innerHTML = '<div class="loading">No staff yet</div>'; return; }
  const POSITION_LABELS = { bartender: 'Bartender', cellarman: 'Cellarman', manager: 'Manager' };
  const rows = staffRoster.map((s) => {
    const sel = s.id === selStaff;
    const roleBadge = s.role === 'admin' ? '<span class="badge badge-teal">Admin</span>' : '<span style="font-size:11px;color:var(--muted)">User</span>';
    return '<tr style="cursor:pointer' + (sel ? ';background:rgba(42,184,166,0.06)' : '') + '" onclick="pickStaff(\'' + s.id + '\')">'
      + '<td style="font-weight:500' + (sel ? ';color:var(--teal)' : '') + '">' + escHtml(s.name) + '</td>'
      + '<td style="font-size:12px;color:var(--sub)">' + escHtml(s.email || '')
      + (staffHasLogin(s) ? '' : (s.email ? ' ' : '') + '<span style="font-size:11px;color:var(--red)">No login</span>') + '</td>'
      + '<td style="font-size:12px;color:var(--sub)">' + (POSITION_LABELS[s.position] || '') + '</td>'
      + '<td>' + roleBadge + '</td>'
      + '<td style="font-size:12px;color:var(--sub)">' + (s.can_schedule ? 'Yes' : 'No') + '</td>'
      + '<td><button class="btn btn-sm btn-danger" onclick="event.stopPropagation();removeStaff(\'' + s.id + '\',\'' + escHtml(s.name).replace(/'/g, "\\'") + '\')">Remove</button></td></tr>';
  }).join('');
  el.innerHTML = '<div class="table-wrap"><table><thead><tr><th>Name</th><th>Email</th><th>Position</th><th>Role</th><th>Can Schedule</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div>';
}

function pickStaff(id) {
  selStaff = id;
  renderStaffRoster();
  const s = staffRoster.find((x) => x.id === id);
  if (s) loadStaffIntoForm(s);
}

function loadStaffIntoForm(s) {
  staffEditMode = true;
  selStaff = s.id;
  document.getElementById('staff-form-label').textContent = 'Edit Staff Member';
  document.getElementById('staff-cancel-edit').style.visibility = 'visible';
  document.getElementById('staff-name').value = s.name || '';
  document.getElementById('staff-email').value = s.email || '';
  document.getElementById('staff-role').value = s.role || 'user';
  document.getElementById('staff-position').value = s.position || 'bartender';
  document.getElementById('staff-can-schedule').checked = !!s.can_schedule;
  document.getElementById('btn-save-staff').textContent = 'Save Changes';
  document.getElementById('staff-form-hint').textContent = staffHasLogin(s)
    ? 'Changing the email changes the address they sign in with.'
    : "No login yet — enter their email and they'll get an invite. Their existing shifts and history stay attached.";
  clearStaffAlert();
}

function cancelStaffEdit() {
  staffEditMode = false;
  selStaff = null;
  document.getElementById('staff-form-label').textContent = 'Add Staff Member';
  document.getElementById('staff-cancel-edit').style.visibility = 'hidden';
  document.getElementById('staff-name').value = '';
  document.getElementById('staff-email').value = '';
  document.getElementById('staff-role').value = 'user';
  document.getElementById('staff-position').value = 'bartender';
  document.getElementById('staff-can-schedule').checked = false;
  document.getElementById('btn-save-staff').textContent = 'Send Invite';
  document.getElementById('staff-form-hint').textContent = "They'll get an email to set their own password and sign in.";
  clearStaffAlert();
  renderStaffRoster();
}

function clearStaffAlert() {
  const el = document.getElementById('staff-alert');
  el.style.display = 'none';
  el.textContent = '';
}

function staffAlert(msg, isError) {
  const el = document.getElementById('staff-alert');
  el.style.display = 'block';
  el.style.background = isError ? 'rgba(220,53,69,0.1)' : 'rgba(42,184,166,0.1)';
  el.style.color = isError ? 'var(--red)' : 'var(--teal)';
  el.textContent = msg;
}

async function saveStaff() {
  const name = document.getElementById('staff-name').value.trim();
  const email = document.getElementById('staff-email').value.trim();
  const role = document.getElementById('staff-role').value;
  const position = document.getElementById('staff-position').value;
  const canSchedule = document.getElementById('staff-can-schedule').checked;
  clearStaffAlert();

  if (!name) { staffAlert('Name is required.', true); return; }
  // Editing a placeholder profile without giving it an email is fine
  // (e.g. just fixing their position) — only new invites need one.
  if (!email && !staffEditMode) { staffAlert('Email is required.', true); return; }

  const btn = document.getElementById('btn-save-staff');
  btn.disabled = true;

  if (staffEditMode) {
    const { error } = await window.supabase.from('staff_profiles').update({ name, role, position, can_schedule: canSchedule }).eq('id', selStaff);
    if (error) { btn.disabled = false; staffAlert(error.message, true); return; }
    const s = staffRoster.find((x) => x.id === selStaff);
    const emailChanged = email && email.toLowerCase() !== ((s && s.email) || '').toLowerCase();
    const needsLink = email && s && !staffHasLogin(s);
    if (emailChanged || needsLink) {
      const msg = await updateStaffEmail(selStaff, email, false);
      btn.disabled = false;
      if (msg === null) return;
      toast(msg);
    } else {
      btn.disabled = false;
      toast('Staff member updated');
    }
    cancelStaffEdit();
    loadStaffRoster();
    return;
  }

  const { data: { session } } = await window.supabase.auth.getSession();
  if (!session) { btn.disabled = false; staffAlert('Your session expired — please sign in again.', true); return; }

  try {
    const res = await fetch('/api/invite-staff', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + session.access_token },
      body: JSON.stringify({ name, email, role, position, canSchedule, redirectTo: window.location.origin }),
    });
    const data = await res.json();
    btn.disabled = false;
    if (!res.ok) { staffAlert(data.error || 'Could not send the invite.', true); return; }
    toast('Invite sent to ' + email);
    cancelStaffEdit();
    loadStaffRoster();
  } catch (e) {
    btn.disabled = false;
    staffAlert('Network error sending the invite.', true);
  }
}

// Sets/changes the email via /api/update-staff-email — for a profile
// with no login that also invites them and relinks the profile onto
// the new login (migration_030). Returns a toast message on success,
// or null after showing the error in the form.
async function updateStaffEmail(staffId, email, merge) {
  const { data: { session } } = await window.supabase.auth.getSession();
  if (!session) { staffAlert('Your session expired — please sign in again.', true); return null; }
  try {
    const res = await fetch('/api/update-staff-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + session.access_token },
      body: JSON.stringify({ staffId, email, merge, redirectTo: window.location.origin }),
    });
    const data = await res.json();
    if (res.status === 409 && data.needsMerge) {
      if (!confirm(email + ' already belongs to ' + data.otherName + "'s profile. Merge these into one profile? Shifts and history from both are kept.")) {
        staffAlert('Details saved, but the email was not changed.', true);
        loadStaffRoster();
        return null;
      }
      return updateStaffEmail(staffId, email, true);
    }
    if (!res.ok) { staffAlert((data.error || 'Could not update the email.') + ' Other details were saved.', true); loadStaffRoster(); return null; }
    if (data.action === 'invited') return 'Saved — invite sent to ' + email;
    if (data.action === 'linked') return 'Saved — linked to the existing login for ' + email;
    return 'Saved — email changed to ' + email;
  } catch (e) {
    staffAlert('Network error updating the email. Other details were saved.', true);
    return null;
  }
}

async function removeStaff(id, name) {
  if (!confirm('Remove ' + name + ' from the staff roster? This does not delete their login, only their access.')) return;
  const { error } = await window.supabase.from('staff_profiles').delete().eq('id', id);
  if (error) { toast(error.message, true); return; }
  if (selStaff === id) cancelStaffEdit();
  toast('Removed ' + name);
  loadStaffRoster();
}
