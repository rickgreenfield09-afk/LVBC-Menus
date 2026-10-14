// trivia.js
// Games > Trivia. Prints team answer sheets: one 8.5x11 sheet per team,
// laid out like the Music Bingo sheet — TL/BL/BR are the Round 1/2/3
// answer cards (10 numbered lines, each with a checkbox for marking it
// correct, plus a tiebreaker line) and TR is the info quadrant (rules,
// this week's events, team name, scoring summary). Nothing is saved;
// it's just a printable page.
//
// Depends on: bingo.js (BINGO_SHEET_CSS, BINGO_BREWERY, bingoFetchEvents(),
// bingoFmtDate(), bingoAddDays(), bingoToday(), bingoAlert(), bingoClearAlert()),
// menu.js (openHtml(), FONT_LINK, LOGO_URL, escHtml())

const TRIVIA_QUESTIONS_PER_ROUND = 10;
const TRIVIA_DEFAULT_SHEETS = 20;
const TRIVIA_MAX_SHEETS = 200;

function loadTrivia() {
  const dateEl = document.getElementById('trivia-date');
  if (!dateEl.value) dateEl.value = bingoToday();
}

// Reuses the bingo sheet styles; these add the answer lines and score box.
const TRIVIA_SHEET_CSS = BINGO_SHEET_CSS
  + '.ans{display:flex;flex-direction:column;justify-content:space-between;flex:1;padding-top:2px;}'
  + '.q{display:flex;align-items:flex-end;gap:5px;height:0.33in;}'
  + '.q .n{font-family:Oswald,sans-serif;font-size:13px;font-weight:700;min-width:0.24in;text-align:right;line-height:1;padding-bottom:2px;}'
  + '.q .box{width:0.17in;height:0.17in;border:1.5px solid #1a1410;flex:none;margin-bottom:2px;}'
  + '.q .line{flex:1;border-bottom:1px solid #1a1410;height:0.24in;}'
  + '.q.tb{margin-top:0.08in;}.q.tb .n{min-width:0;text-align:left;font-size:11px;letter-spacing:0.1em;text-transform:uppercase;white-space:nowrap;padding-right:2px;}'
  + '.tb-note{font-size:7px;color:#555;margin-left:0.29in;}'
  + '.team{margin:7px 0 2px;}.team .lbl{font-family:Oswald,sans-serif;font-size:10px;font-weight:700;letter-spacing:0.18em;text-transform:uppercase;}'
  + '.team .tline{border-bottom:1.5px solid #1a1410;height:0.3in;}'
  + '.score{margin-top:auto;border:2px solid #1a1410;}'
  + '.score .st{font-family:Oswald,sans-serif;font-size:10px;font-weight:700;letter-spacing:0.18em;text-transform:uppercase;text-align:center;background:#1a1410;color:#fff;padding:2px 0;}'
  + '.score .sr{display:flex;align-items:center;border-top:1px solid #1a1410;height:0.27in;padding:0 6px;font-family:Oswald,sans-serif;font-size:11px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;}'
  + '.score .sr:first-of-type{border-top:none;}.score .sr span{flex:1;}.score .sr i{width:0.7in;height:0.19in;border-bottom:1px solid #1a1410;font-style:normal;}'
  + '.score .sr.tot{border-top:2px solid #1a1410;height:0.32in;font-size:12px;font-weight:700;}'
  + '.score .sr i b{font-size:8px;color:#555;font-weight:500;}';

function triviaAnswerQuadrant(round, sheetLabel) {
  let lines = '';
  for (let i = 1; i <= TRIVIA_QUESTIONS_PER_ROUND; i++) {
    lines += '<div class="q"><span class="n">' + i + '.</span><span class="box"></span><span class="line"></span></div>';
  }
  return '<div class="quad"><div class="card-head"><span class="round">Round ' + round + '</span><span class="win">Check = correct</span></div>'
    + '<div class="playlist">Answers</div>'
    + '<div class="ans">' + lines
    + '<div class="q tb"><span class="n">Tiebreaker</span><span class="line"></span></div>'
    + '<div class="tb-note">Closest answer breaks a tie.</div></div>'
    + '<div class="card-foot">SHEET ' + sheetLabel + ' · R' + round + '</div></div>';
}

function triviaInfoQuadrant(eventDate, events, sheetLabel) {
  const shown = events.slice(0, 5);
  const evHtml = shown.length
    ? shown.map((e) => '<div class="ev"><b>' + escHtml(bingoFmtDate(e.date, { weekday: 'short', month: 'numeric', day: 'numeric' })) + '</b><span>' + escHtml(e.name) + (e.time ? ' · ' + escHtml(e.time) : '') + '</span></div>').join('')
      + (events.length > shown.length ? '<div class="ev"><span>+ ' + (events.length - shown.length) + ' more — ask your bartender!</span></div>' : '')
    : '<div class="ev"><span>Ask your bartender what\'s coming up!</span></div>';
  const row = (label) => '<div class="sr"><span>' + label + '</span><i></i></div>';
  return '<div class="quad info">'
    + '<div class="brand"><img src="' + LOGO_URL + '"><div><div class="brand-name">' + BINGO_BREWERY + '</div><div class="title">Trivia<br>Night</div></div></div>'
    + '<div class="date">' + escHtml(bingoFmtDate(eventDate, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })) + ' · Sheet ' + sheetLabel + '</div>'
    + '<div class="h">How to Play</div>'
    + '<div class="keep">One sheet per team — all 3 rounds!</div>'
    + '<ul class="rules">'
    + '<li>Work together — write your team\'s answer on the line for each question.</li>'
    + '<li>Each round has ' + TRIVIA_QUESTIONS_PER_ROUND + ' questions plus a tiebreaker. Only one sheet per team.</li>'
    + '<li>Hand your sheet to the host after each round to be scored, then check the box for each correct answer.</li>'
    + '<li>Highest total score wins. Closest tiebreaker answer settles a tie.</li></ul>'
    + '<div class="h">This Week at LVBC</div>' + evHtml
    + '<div class="team"><div class="lbl">Team Name</div><div class="tline"></div></div>'
    + '<div class="score"><div class="st">Scoring Summary</div>'
    + row('Round 1') + row('Round 2') + row('Round 3')
    + '<div class="sr tot"><span>Total Score</span><i></i></div></div>'
    + '</div>';
}

function triviaSheetsHtml(eventDate, events, sheets) {
  const pages = [];
  for (let s = 1; s <= sheets; s++) {
    const label = String(s).padStart(2, '0');
    pages.push('<div class="page">' + triviaAnswerQuadrant(1, label) + triviaInfoQuadrant(eventDate, events, label)
      + triviaAnswerQuadrant(2, label) + triviaAnswerQuadrant(3, label) + '</div>');
  }
  return '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Trivia Answer Sheets — ' + escHtml(bingoFmtDate(eventDate)) + '</title>'
    + FONT_LINK + '<style>' + TRIVIA_SHEET_CSS + '</style></head><body>'
    + '<div class="toolbar"><span>' + sheets + ' sheets · print single-sided, Letter, no margins</span><button onclick="window.print()">Print / Save PDF</button></div>'
    + pages.join('') + '</body></html>';
}

async function printTriviaSheets() {
  bingoClearAlert('trivia-alert');
  const eventDate = document.getElementById('trivia-date').value;
  const sheets = parseInt(document.getElementById('trivia-sheets').value, 10);
  if (!eventDate) { bingoAlert('trivia-alert', 'Pick the trivia night date.', true); return; }
  if (!(sheets >= 1 && sheets <= TRIVIA_MAX_SHEETS)) { bingoAlert('trivia-alert', 'Sheets must be between 1 and ' + TRIVIA_MAX_SHEETS + '.', true); return; }

  const btn = document.getElementById('trivia-print-btn');
  btn.disabled = true; btn.textContent = 'Building…';
  try {
    const events = await bingoFetchEvents(eventDate, bingoAddDays(eventDate, 6));
    openHtml(triviaSheetsHtml(eventDate, events, sheets));
  } catch (e) {
    bingoAlert('trivia-alert', 'Could not build the sheets: ' + e.message, true);
  } finally {
    btn.disabled = false; btn.textContent = 'Create & Print Sheets';
  }
}
