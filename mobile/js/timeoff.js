// timeoff.js (mobile)
// Screen: #screen-timeoff — placeholder. PTO requests have no backing
// table yet: the closest thing today is blackout_dates (migration_009),
// which is a soft "don't schedule me" flag with no request/approve
// step. This screen gets built once that migration exists.
// Depends on: nothing yet

function loadTimeOff() {
  document.getElementById('m-timeoff').innerHTML = '<div class="loading">Time-off requests are coming soon.</div>';
}
