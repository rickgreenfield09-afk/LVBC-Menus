// profile.js (member app)
// Page: #tab-profile — the member's own details: photo, name, phone,
// birthday, the beer styles they like, which emails they want, and
// their PIN.
//
// A member can't write the members table directly (they could give
// themselves points). Everything here goes through
// member_update_profile(), which only accepts the profile fields.
// The photo is shrunk in the browser, stored in the assets bucket
// under members/<their auth id>/, and its public URL saved on the
// row — the first app stored the whole image inside the row.
// The PIN is the Supabase Auth password; email can't be changed here.
// Depends on: window.supabase, window.currentMember, refreshMember(),
// toast(), escHtml(), avatarHtml() (core.js), PIN_RE (core.js)

const BEER_STYLES = ['IPA', 'Stout', 'Amber/Red', 'Wheat/Wit', 'Lager/Pilsner', 'Sour/Wild Ale', 'Belgian', 'Session (<5%)', 'High ABV (8%+)'];
const AVATAR_MAX = 400;   // px, longest side

function populateProfile() {
  const m = window.currentMember;
  document.getElementById('prof-name').value = m.name || '';
  document.getElementById('prof-email').value = m.email || '';
  document.getElementById('prof-phone').value = m.phone || '';
  document.getElementById('prof-birthday').value = m.birthday || '';
  document.getElementById('comms-opt-in').checked = m.comms_opt_in;
  document.getElementById('comms-events').checked = m.comms_events;
  document.getElementById('comms-releases').checked = m.comms_new_releases;
  document.getElementById('comms-promos').checked = m.comms_promotions;
  document.getElementById('profile-avatar-display').innerHTML = avatarHtml(m);
  const liked = m.taste_profile || [];
  document.getElementById('style-chips').innerHTML = BEER_STYLES.map((s) =>
    '<div class="style-chip' + (liked.includes(s) ? ' selected' : '') + '" onclick="this.classList.toggle(\'selected\')">' + escHtml(s) + '</div>').join('');
}

function profileAlert(msg, isError, id) {
  const el = document.getElementById(id || 'profile-alert');
  el.textContent = msg;
  el.className = 'alert visible ' + (isError ? 'alert-error' : 'alert-success');
  setTimeout(() => el.classList.remove('visible'), 4000);
}

async function updateProfile(patch) {
  const { error } = await window.supabase.rpc('member_update_profile', { p_patch: patch });
  if (error) { profileAlert(error.message, true); return false; }
  await refreshMember(true);
  return true;
}

async function saveProfile() {
  const name = document.getElementById('prof-name').value.trim();
  if (!name) { profileAlert('Name is required', true); return; }
  if (await updateProfile({
    name, phone: document.getElementById('prof-phone').value.trim(),
    birthday: document.getElementById('prof-birthday').value || '',
  })) profileAlert('✓ Profile updated');
}

async function saveStyles() {
  const liked = [...document.querySelectorAll('.style-chip.selected')].map((el) => el.textContent);
  if (await updateProfile({ taste_profile: liked })) toast('Taste preferences saved');
}

async function saveComms() {
  await updateProfile({
    comms_opt_in: document.getElementById('comms-opt-in').checked,
    comms_events: document.getElementById('comms-events').checked,
    comms_new_releases: document.getElementById('comms-releases').checked,
    comms_promotions: document.getElementById('comms-promos').checked,
  });
}

// Phone photos are several megabytes; a profile circle needs a few KB.
function shrinkImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, AVATAR_MAX / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(img.src);
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Could not read that image'))), 'image/jpeg', 0.85);
    };
    img.onerror = () => reject(new Error('Could not read that image'));
    img.src = URL.createObjectURL(file);
  });
}

async function uploadAvatar(input) {
  const file = input.files[0];
  input.value = '';
  if (!file) return;
  profileAlert('Uploading...');
  try {
    const blob = await shrinkImage(file);
    const { data: { user } } = await window.supabase.auth.getUser();
    const path = 'members/' + user.id + '/photo.jpg';
    const { error } = await window.supabase.storage.from('assets').upload(path, blob, { upsert: true, contentType: 'image/jpeg' });
    if (error) throw error;
    // the path never changes, so the timestamp is what makes browsers re-fetch it
    const url = window.supabase.storage.from('assets').getPublicUrl(path).data.publicUrl + '?v=' + Date.now();
    if (await updateProfile({ profile_photo_url: url })) {
      populateProfile();
      profileAlert('✓ Photo updated');
    }
  } catch (e) {
    profileAlert('Upload failed: ' + e.message, true);
  }
}

async function changePin() {
  const pin = document.getElementById('pin-new').value.trim();
  if (!PIN_RE.test(pin)) { profileAlert('Choose a PIN of exactly 6 digits', true, 'pin-alert'); return; }
  if (pin !== document.getElementById('pin-confirm').value.trim()) { profileAlert('The two PINs don\'t match', true, 'pin-alert'); return; }
  const { error } = await window.supabase.auth.updateUser({ password: pin });
  if (error) { profileAlert(error.message, true, 'pin-alert'); return; }
  document.getElementById('pin-new').value = '';
  document.getElementById('pin-confirm').value = '';
  profileAlert('✓ PIN updated', false, 'pin-alert');
}
