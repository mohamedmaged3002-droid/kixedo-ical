// sync-blocks.js
// Reads WP manually blocked dates and patches them into existing .ics files.
// Does NOT touch Kixedo — runs in seconds.

require('dotenv').config();
const fs   = require('fs');
const path = require('path');

const WP_URL   = (process.env.WP_URL || 'https://bluekeys.co').replace(/\/$/, '');
const MAPPING  = JSON.parse(fs.readFileSync(path.join(__dirname, 'wp-ical-mapping.json'), 'utf8'));
const PUBLIC   = path.join(__dirname, 'docs');

function fmtDate(d) { return d.replace(/-/g, ''); }
function esc(t) { return String(t||'').replace(/[\\;,]/g, c=>'\\'+c).replace(/\n/g,'\\n'); }

// Parse existing .ics and strip previous manual blocks (UID starts with "manual-")
function stripManualBlocks(ics) {
  return ics.replace(/BEGIN:VEVENT[\s\S]*?UID:manual-[\s\S]*?END:VEVENT\r?\n/g, '');
}

// Build VEVENT block for a manual entry
function makeVEvent(b) {
  return [
    'BEGIN:VEVENT',
    `UID:manual-${b.start}-${b.end}-${b.kixedo_id}@mynt.bluekeys.co`,
    `DTSTART;VALUE=DATE:${fmtDate(b.start)}`,
    `DTEND;VALUE=DATE:${fmtDate(b.end)}`,
    `SUMMARY:${esc(b.summary || 'BLOCKED')}`,
    'STATUS:CONFIRMED',
    'TRANSP:OPAQUE',
    'END:VEVENT',
  ].join('\r\n') + '\r\n';
}

async function main() {
  // Fetch WP blocked dates
  let wpBlocks = [];
  try {
    const res = await fetch(`${WP_URL}/wp-json/mynt/v1/blocked`);
    if (res.ok) wpBlocks = await res.json();
  } catch (e) {
    console.error('Could not reach WP endpoint:', e.message);
  }

  // Also load manual-blocks.json as fallback
  const jsonBlocks = JSON.parse(fs.readFileSync(path.join(__dirname, 'manual-blocks.json'), 'utf8'))
    .filter(b => b.kixedo_id > 0);

  const allBlocks = [...wpBlocks, ...jsonBlocks];
  console.log(`WP blocks: ${wpBlocks.length}, JSON blocks: ${jsonBlocks.length}`);

  // Group by kixedo_id
  const byId = {};
  for (const b of allBlocks) {
    if (!byId[b.kixedo_id]) byId[b.kixedo_id] = [];
    byId[b.kixedo_id].push(b);
  }

  let patched = 0;
  for (const entry of MAPPING) {
    const icsPath = path.join(PUBLIC, `${entry.kixedo_id}.ics`);
    if (!fs.existsSync(icsPath)) continue;

    const blocks = byId[entry.kixedo_id] || [];
    const existing = fs.readFileSync(icsPath, 'utf8');
    let updated = stripManualBlocks(existing);

    // Inject new manual blocks before END:VCALENDAR
    const vevents = blocks.map(makeVEvent).join('');
    updated = updated.replace('END:VCALENDAR', vevents + 'END:VCALENDAR');

    if (updated !== existing) {
      fs.writeFileSync(icsPath, updated, 'utf8');
      console.log(`[${entry.kixedo_id}] ${entry.kixedo_title} — ${blocks.length} blocks patched`);
      patched++;
    }
  }

  console.log(`\nDone: ${patched} files updated`);
}

main().catch(e => { console.error(e); process.exit(1); });
