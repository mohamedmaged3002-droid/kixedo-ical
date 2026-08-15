require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { KixedoClient } = require('./src/client');
const { generateIcal } = require('./src/ical');

// Load manual blocks from WP REST endpoint (wp-blocked uses correct meta keys + auth)
// Returns blocks with kixedo_id attached (translated via wp-ical-mapping.json)
async function loadManualBlocks() {
  const WP_URL  = (process.env.WP_URL  || 'https://bluekeys.co').replace(/\/$/, '');
  const WP_USER = process.env.WP_USERNAME;
  const WP_PASS = (process.env.WP_APP_PASSWORD || '').replace(/\s+/g, '');

  // Build wp_post_id → kixedo_id lookup from mapping file
  const mapping = JSON.parse(fs.readFileSync(path.join(__dirname, 'wp-ical-mapping.json'), 'utf8'));
  const wpToKixedo = {};
  for (const e of mapping) wpToKixedo[e.wp_post_id] = e.kixedo_id;

  try {
    const headers = {};
    if (WP_USER && WP_PASS) {
      headers['Authorization'] = 'Basic ' + Buffer.from(`${WP_USER}:${WP_PASS}`).toString('base64');
    }
    const res = await fetch(`${WP_URL}/wp-json/mynt/v1/wp-blocked`, { headers });
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data) && data.length > 0) {
        // Attach kixedo_id so sync.js can group by it
        const withKixedo = data
          .map(b => ({ ...b, kixedo_id: wpToKixedo[b.wp_post_id] }))
          .filter(b => b.kixedo_id);
        console.log(`Loaded ${withKixedo.length} WP blocks (of ${data.length} total)`);
        return withKixedo;
      }
    }
  } catch {}
  return [];
}

// Total VEVENTs currently published for the given property ids — the baseline the
// collapse gate compares a fresh run against.
function countEventsOnDisk(outDir, ids) {
  let total = 0;
  for (const id of ids) {
    try {
      const ics = fs.readFileSync(path.join(outDir, `${id}.ics`), 'utf8');
      total += (ics.match(/BEGIN:VEVENT/g) || []).length;
    } catch {
      // No previous feed for this property (new unit) — contributes nothing.
    }
  }
  return total;
}

// Only the 3 compounds whose units are on bluekeys.co (Mynt North Coast)
const COMPOUNDS = [
  { id: 3, name: 'Marassi' },
  { id: 4, name: 'Fouka Bay' },
  { id: 6, name: 'Playa' },
];

async function main() {
  const email = process.env.KIXEDO_EMAIL;
  const password = process.env.KIXEDO_PASSWORD;
  if (!email || !password) {
    console.error('Set KIXEDO_EMAIL and KIXEDO_PASSWORD in .env');
    process.exit(1);
  }

  const outDir = path.join(__dirname, 'docs');
  fs.mkdirSync(outDir, { recursive: true });

  const client = new KixedoClient();
  console.log('Logging in to Kixedo...');
  await client.login(email, password);
  console.log('Logged in.\n');

  const allManualBlocks = await loadManualBlocks();
  const manualBlocksById = {};
  for (const b of allManualBlocks) {
    const key = b.kixedo_id;
    if (!manualBlocksById[key]) manualBlocksById[key] = [];
    manualBlocksById[key].push(b);
  }

  // property index: { id, title, compound, compoundId }
  const index = [];
  let totalEvents = 0;
  const seenPropIds = new Set(); // deduplicate across compounds

  // Collect all unique properties across compounds first. getProperties throws
  // rather than returning [] — a compound we cannot read is a hard failure, not an
  // empty compound, so we abort and leave every last-good feed in place.
  const allProps = [];
  for (const compound of COMPOUNDS) {
    let props;
    try {
      props = await client.getProperties(compound.id);
    } catch (err) {
      throw new Error(`${compound.name} (${compound.id}) roster fetch failed: ${err.message}`);
    }
    if (!props.length) {
      throw new Error(`${compound.name} (${compound.id}) returned 0 properties — refusing to publish`);
    }
    console.log(`${compound.name} (${compound.id}): ${props.length} properties`);
    for (const prop of props) {
      if (seenPropIds.has(prop.id)) continue;
      seenPropIds.add(prop.id);
      allProps.push({ prop, compound });
    }
  }

  // Fetch bookings in parallel — 5 properties at a time to avoid rate limiting.
  // Nothing is written to disk in this phase: we stage every feed in memory so the
  // collapse gate below can veto the whole run atomically.
  const staged = [];  // { id, ics, events }
  const skipped = []; // properties left at their last-good feed
  const CONCURRENCY = 5;
  for (let i = 0; i < allProps.length; i += CONCURRENCY) {
    const batch = allProps.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async ({ prop, compound }) => {
      const { bookings, failedMonths } = await client.getBookings12Months(compound.id, prop.id);
      // Stays in index.json either way: index membership is the liveness signal that
      // detects a delisting (L-064), so a transient fetch error must not read as
      // "this property is gone".
      index.push({ id: prop.id, title: prop.title, number: prop.number, compound: compound.name, compoundId: compound.id });

      if (failedMonths > 0) {
        skipped.push(prop.id);
        console.log(`  [${prop.id}] ${prop.title} — SKIPPED: ${failedMonths}/7 months unreadable, keeping last-good feed`);
        return;
      }

      const manualBlocks = manualBlocksById[prop.id] || [];
      const ics = generateIcal(prop, bookings, manualBlocks);
      const manualNote = manualBlocks.length ? ` (+${manualBlocks.length} manual)` : '';
      console.log(`  [${prop.id}] ${prop.title} — ${bookings.length} events${manualNote}`);
      totalEvents += bookings.length;
      staged.push({ id: prop.id, ics, events: bookings.length + manualBlocks.length });
    }));
  }

  // Collapse gate. Per-property skipping already stops a dropped month from emptying
  // a feed, but a 200-with-empty-array would slip past it. Compare what we are about
  // to publish against the last-good feeds on disk and refuse a mass de-blocking.
  // Compare like with like: the on-disk baseline counts every VEVENT, so the staged
  // side must include manual blocks too, not just bookings.
  const stagedEvents = staged.reduce((n, s) => n + s.events, 0);
  const prevEvents = countEventsOnDisk(outDir, staged.map(s => s.id));
  if (prevEvents > 0 && stagedEvents < prevEvents * 0.5) {
    throw new Error(
      `collapse gate: about to publish ${stagedEvents} events where the last-good feeds `
      + `hold ${prevEvents} for the same ${staged.length} properties — refusing to write. `
      + `Re-run; if this persists the drop is real and the gate needs a manual override.`
    );
  }

  for (const { id, ics } of staged) {
    fs.writeFileSync(path.join(outDir, `${id}.ics`), ics, 'utf8');
  }
  if (skipped.length) {
    console.log(`\n${skipped.length} feed(s) left at last-good: ${skipped.join(', ')}`);
  }

  // Write index.json — useful for building the WP post → Kixedo ID mapping
  fs.writeFileSync(
    path.join(outDir, 'index.json'),
    JSON.stringify({ updatedAt: new Date().toISOString(), properties: index }, null, 2),
    'utf8'
  );

  console.log(`\nDone: ${index.length} properties, ${totalEvents} events total`);
  console.log(`Output: ${outDir}`);
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
