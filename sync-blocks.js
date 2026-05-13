// sync-blocks.js
// Reads WP manual blocks via /wp-json/mynt/v1/wp-blocked and patches them
// into the existing .ics files. No Kixedo login needed — runs in seconds.

require('dotenv').config();
const fs   = require('fs');
const path = require('path');

const WP_URL  = (process.env.WP_URL || 'https://bluekeys.co').replace(/\/$/, '');
const WP_USER = process.env.WP_USERNAME;
const WP_PASS = (process.env.WP_APP_PASSWORD || '').replace(/\s+/g, '');
const MAPPING = JSON.parse(fs.readFileSync(path.join(__dirname, 'wp-ical-mapping.json'), 'utf8'));
const PUBLIC  = path.join(__dirname, 'docs');

function fmtDate(d) { return d.replace(/-/g, ''); }
function esc(t) { return String(t||'').replace(/[\\;,]/g, c=>'\\'+c).replace(/\n/g,'\\n'); }

// Strip previous manual blocks (UID starts with "manual-")
function stripManualBlocks(ics) {
  return ics.replace(/BEGIN:VEVENT[\s\S]*?UID:manual-[\s\S]*?END:VEVENT\r?\n/g, '');
}

// Build VEVENT block for a manual entry
function makeVEvent(b) {
  return [
    'BEGIN:VEVENT',
    `UID:manual-${b.start}-${b.end}-${b.wp_post_id}@mynt.bluekeys.co`,
    `DTSTART;VALUE=DATE:${fmtDate(b.start)}`,
    `DTEND;VALUE=DATE:${fmtDate(b.end)}`,
    `SUMMARY:${esc(b.summary || 'BLOCKED')}`,
    'STATUS:CONFIRMED',
    'TRANSP:OPAQUE',
    'END:VEVENT',
  ].join('\r\n') + '\r\n';
}

async function main() {
  // Fetch all WP manual blocks (any booking status except trash)
  let allBlocks = [];
  try {
    const headers = {};
    if (WP_USER && WP_PASS) {
      headers['Authorization'] = 'Basic ' + Buffer.from(`${WP_USER}:${WP_PASS}`).toString('base64');
    }
    const res = await fetch(`${WP_URL}/wp-json/mynt/v1/wp-blocked`, { headers });
    if (res.ok) {
      allBlocks = await res.json();
      console.log(`WP blocks: ${allBlocks.length}`);
    } else {
      console.error('wp-blocked endpoint returned', res.status);
    }
  } catch (e) {
    console.error('Could not reach WP endpoint:', e.message);
  }

  // Group blocks by WP post ID
  const byWpId = {};
  for (const b of allBlocks) {
    if (!byWpId[b.wp_post_id]) byWpId[b.wp_post_id] = [];
    byWpId[b.wp_post_id].push(b);
  }

  let patched = 0;
  for (const entry of MAPPING) {
    const icsPath = path.join(PUBLIC, `${entry.kixedo_id}.ics`);
    if (!fs.existsSync(icsPath)) continue;

    const blocks = byWpId[entry.wp_post_id] || [];
    const existing = fs.readFileSync(icsPath, 'utf8');
    let updated = stripManualBlocks(existing);

    if (blocks.length) {
      const vevents = blocks.map(makeVEvent).join('');
      updated = updated.replace('END:VCALENDAR', vevents + 'END:VCALENDAR');
    }

    if (updated !== existing) {
      fs.writeFileSync(icsPath, updated, 'utf8');
      console.log(`[${entry.kixedo_id}] ${entry.kixedo_title} — ${blocks.length} blocks patched`);
      patched++;
    }
  }

  console.log(`\nDone: ${patched} files updated`);
}

main().catch(e => { console.error(e); process.exit(1); });
