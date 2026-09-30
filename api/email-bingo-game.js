// api/email-bingo-game.js
// Vercel serverless function (Node runtime). Any staff.
// Emails a printed game's materials as PDFs — card sheets, TV
// slideshow, host call sheet — to every staff member with
// receives_bingo_materials on (set on the Admin screen, migration_031).
// Called right after Print Game, and from History ("Email Again").
//
// The browser sends the three pages as HTML (the same renderers that
// open them for printing, so the PDFs match exactly); this renders each
// in headless Chromium at its own CSS page size. Recipients, the
// playlist summary and the subject line all come from the database,
// never from the request, so this can't be used to mail anyone else.
// While rendering, the page may only load fonts and the logo.
//
// Requires SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY,
// RESEND_API_KEY. Needs the npm deps in package.json and the longer
// maxDuration in vercel.json.

import chromium from '@sparticuz/chromium';
import puppeteer from 'puppeteer-core';
import { requireStaff, db } from './_lib/spotify.js';
import { CAMPAIGN_FROM } from './_lib/campaign-send.js';

const MAX_HTML_BYTES = 4 * 1024 * 1024;

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Plain dates ("2026-10-02") print as-is; full timestamps are shown in
// the brewery's own time zone, not UTC.
function fmtDate(dateStr, opts) {
  if (!dateStr) return '—';
  const s = String(dateStr);
  if (s.length > 10) return new Date(s).toLocaleDateString('en-US', Object.assign({ timeZone: 'America/Chicago' }, opts));
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', Object.assign({ timeZone: 'UTC' }, opts));
}

async function renderPdfs(files) {
  const allowedHosts = new Set(['fonts.googleapis.com', 'fonts.gstatic.com', new URL(process.env.SUPABASE_URL).host]);
  const browser = await puppeteer.launch({
    args: await puppeteer.defaultArgs({ args: chromium.args, headless: 'shell' }),
    defaultViewport: { width: 1280, height: 1600, deviceScaleFactor: 1 },
    executablePath: await chromium.executablePath(),
    headless: 'shell',
  });
  try {
    const out = [];
    for (const f of files) {
      const page = await browser.newPage();
      await page.setRequestInterception(true);
      page.on('request', (r) => {
        const url = r.url();
        if (url.startsWith('data:') || url === 'about:blank') return r.continue();
        try { return allowedHosts.has(new URL(url).host) ? r.continue() : r.abort(); } catch (e) { return r.abort(); }
      });
      await page.setContent(f.html, { waitUntil: 'networkidle0', timeout: 45000 });
      await page.evaluate(() => document.fonts.ready);
      const pdf = await page.pdf({ preferCSSPageSize: true, printBackground: true });
      out.push({ filename: f.filename, content: Buffer.from(pdf).toString('base64'), bytes: pdf.length });
      await page.close();
    }
    return out;
  } finally {
    await browser.close();
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, RESEND_API_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) return res.status(500).json({ error: 'Missing Supabase env vars.' });
  if (!RESEND_API_KEY) return res.status(500).json({ error: 'Email is not configured (missing RESEND_API_KEY).' });
  if (!(await requireStaff(req, res))) return;

  const body = req.body || {};
  const gameId = String(body.game_id || '');
  if (!/^[0-9a-f-]{36}$/i.test(gameId)) return res.status(400).json({ error: 'Missing game_id' });
  const files = body.files || {};
  for (const k of ['cards', 'slideshow', 'callsheet']) {
    if (typeof files[k] !== 'string' || !files[k].startsWith('<!DOCTYPE html>')) return res.status(400).json({ error: 'Missing ' + k + ' page' });
    if (Buffer.byteLength(files[k]) > MAX_HTML_BYTES) return res.status(413).json({ error: 'The ' + k + ' page is too large to email.' });
  }

  const recordResult = (patch) => db('bingo_games?id=eq.' + gameId, { method: 'PATCH', body: patch }).catch(() => {});

  try {
    const games = await db('bingo_games?select=id,event_date,printed_on,sheet_count,staff_profiles(name),bingo_game_rounds(round_no,playlist_id,playlist_title,pattern_name)&id=eq.' + gameId);
    if (!games || !games.length) return res.status(404).json({ error: 'Game not found' });
    const game = games[0];
    const rounds = (game.bingo_game_rounds || []).sort((a, b) => a.round_no - b.round_no);

    const recipients = (await db('staff_profiles?select=name,email&receives_bingo_materials=eq.true&email=not.is.null'))
      .filter((r) => r.email && r.email.includes('@'));
    if (!recipients.length) {
      await recordResult({ materials_email_error: 'No one is set to receive Music Bingo materials (Admin screen).' });
      return res.status(200).json({ skipped: true, reason: 'No one is set to receive Music Bingo materials — turn it on for staff on the Admin screen.' });
    }

    const plIds = rounds.map((r) => r.playlist_id).filter(Boolean);
    const playlists = plIds.length
      ? await db('bingo_playlists?select=id,created_at,staff_profiles!bingo_playlists_created_by_fkey(name)&id=in.(' + plIds.join(',') + ')')
      : [];
    const plById = Object.fromEntries(playlists.map((p) => [p.id, p]));

    const night = fmtDate(game.event_date, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
    const stamp = String(game.event_date).slice(0, 10);
    const pdfs = await renderPdfs([
      { filename: 'Music Bingo Cards ' + stamp + '.pdf', html: files.cards },
      { filename: 'Music Bingo TV Slideshow ' + stamp + '.pdf', html: files.slideshow },
      { filename: 'Music Bingo Call Sheet ' + stamp + '.pdf', html: files.callsheet },
    ]);

    const rows = rounds.map((r) => {
      const pl = plById[r.playlist_id];
      return '<tr><td style="padding:6px 10px;border-bottom:1px solid #ddd;">Round ' + r.round_no + '</td>'
        + '<td style="padding:6px 10px;border-bottom:1px solid #ddd;font-weight:600;">' + esc(r.playlist_title) + '</td>'
        + '<td style="padding:6px 10px;border-bottom:1px solid #ddd;">' + esc(pl && pl.staff_profiles ? pl.staff_profiles.name : '—') + '</td>'
        + '<td style="padding:6px 10px;border-bottom:1px solid #ddd;">' + (pl ? fmtDate(pl.created_at, { month: 'short', day: 'numeric', year: 'numeric' }) : '—') + '</td>'
        + '<td style="padding:6px 10px;border-bottom:1px solid #ddd;">' + esc(r.pattern_name) + '</td></tr>';
    }).join('');
    const html = '<div style="font-family:Arial,Helvetica,sans-serif;color:#1a1410;font-size:14px;">'
      + '<h2 style="margin:0 0 4px;">Music Bingo — ' + esc(night) + '</h2>'
      + '<p style="margin:0 0 16px;color:#555;">' + game.sheet_count + ' sheets · printed ' + fmtDate(game.printed_on, { month: 'short', day: 'numeric', year: 'numeric' })
      + (game.staff_profiles ? ' by ' + esc(game.staff_profiles.name) : '') + '</p>'
      + '<table style="border-collapse:collapse;font-size:13px;"><thead><tr style="text-align:left;background:#f4efe6;">'
      + '<th style="padding:6px 10px;">Round</th><th style="padding:6px 10px;">Playlist</th><th style="padding:6px 10px;">Created by</th><th style="padding:6px 10px;">Created on</th><th style="padding:6px 10px;">Win pattern</th>'
      + '</tr></thead><tbody>' + rows + '</tbody></table>'
      + '<p style="margin:16px 0 0;">Attached: the card sheets (print single-sided, Letter, no margins), the TV slideshow, and the host call sheet.</p>'
      + '<p style="margin:16px 0 0;font-size:11px;color:#999;">Sent automatically by the LVBC staff app when the game was printed.</p></div>';

    const sendRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: CAMPAIGN_FROM,
        to: recipients.map((r) => r.email),
        subject: 'Music bingo material for ' + night,
        html,
        attachments: pdfs.map((p) => ({ filename: p.filename, content: p.content })),
      }),
    });
    if (!sendRes.ok) {
      const err = await sendRes.text();
      await recordResult({ materials_email_error: 'Resend error: ' + err.slice(0, 500) });
      return res.status(502).json({ error: 'Resend error: ' + err });
    }

    const sentTo = recipients.map((r) => r.email);
    await recordResult({ materials_emailed_at: new Date().toISOString(), materials_emailed_to: sentTo, materials_email_error: null });
    return res.status(200).json({ sent_to: recipients.map((r) => r.name + ' <' + r.email + '>'), attachments: pdfs.map((p) => ({ filename: p.filename, bytes: p.bytes })) });
  } catch (e) {
    await recordResult({ materials_email_error: String(e.message || e).slice(0, 500) });
    return res.status(500).json({ error: e.message || String(e) });
  }
}
