// set-ical-feeds.js
// Wires https://icalmynt.netlify.app/{kixedo_id}.ics into every bluekeys.co property
// so the WP Rentals booking calendar shows Kixedo bookings as blocked.
//
// Usage:
//   node set-ical-feeds.js            # dry-run: show what would be set
//   node set-ical-feeds.js --apply    # apply to all 68 properties
//   node set-ical-feeds.js --check    # read current feeds back from WP (no changes)

require('dotenv').config({ path: require('path').join(__dirname, '../stayatmynt-wp-publisher/.env') });

const fs   = require('fs');
const path = require('path');

const WP_URL  = (process.env.WP_URL || 'https://bluekeys.co').replace(/\/$/, '');
const WP_USER = process.env.WP_USERNAME;
const WP_PASS = (process.env.WP_APP_PASSWORD || '').replace(/\s+/g, '');
const auth    = 'Basic ' + Buffer.from(`${WP_USER}:${WP_PASS}`).toString('base64');

const MAPPING = JSON.parse(fs.readFileSync(path.join(__dirname, 'wp-ical-mapping.json'), 'utf8'));
const GITHUB_PAGES = 'https://mohamedmaged3002-droid.github.io/kixedo-ical';

const apply = process.argv.includes('--apply');
const check = process.argv.includes('--check');

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function setFeed(postId, url) {
  const res = await fetch(`${WP_URL}/wp-json/mynt/v1/property/${postId}/ical-feed`, {
    method: 'POST',
    headers: { Authorization: auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`${res.status}: ${txt.substring(0, 200)}`);
  }
  return res.json();
}

async function getFeed(postId) {
  const res = await fetch(`${WP_URL}/wp-json/mynt/v1/property/${postId}/ical-feed`, {
    headers: { Authorization: auth },
  });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

async function main() {
  if (!WP_USER || !WP_PASS) {
    console.error('Set WP_USERNAME and WP_APP_PASSWORD in stayatmynt-wp-publisher/.env');
    process.exit(1);
  }

  const mode = check ? 'CHECK' : apply ? 'APPLY' : 'DRY-RUN';
  console.log(`Mode: ${mode} — ${MAPPING.length} properties\n`);

  let ok = 0, fail = 0;

  for (const entry of MAPPING) {
    const { wp_post_id, kixedo_id, kixedo_title, compound } = entry;
    const icalUrl = `${GITHUB_PAGES}/${kixedo_id}.ics`;

    if (check) {
      try {
        const data = await getFeed(wp_post_id);
        const current = data.feeds?.[0]?.feed || '(none)';
        const match = current === icalUrl ? '✓' : current === '(none)' ? '✗ empty' : '⚠ mismatch';
        console.log(`[${wp_post_id}] ${compound} / ${kixedo_title} → ${match}`);
      } catch (err) {
        console.log(`[${wp_post_id}] ${kixedo_title} → ERROR: ${err.message}`);
      }
      await sleep(100);
      continue;
    }

    process.stdout.write(`[${wp_post_id}] ${compound} / ${kixedo_title} → ${icalUrl} ... `);

    if (!apply) { console.log('(dry-run)'); continue; }

    try {
      await setFeed(wp_post_id, icalUrl);
      console.log('✓ set');
      ok++;
    } catch (err) {
      console.error(`FAILED: ${err.message}`);
      fail++;
    }

    await sleep(200);
  }

  if (!check) {
    console.log(`\nDone: ${ok} set, ${fail} failed`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
