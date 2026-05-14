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

  for (const compound of COMPOUNDS) {
    const props = await client.getProperties(compound.id);
    if (!props.length) {
      console.log(`  ${compound.name}: 0 properties — skipping`);
      continue;
    }
    console.log(`${compound.name} (${compound.id}): ${props.length} properties`);

    for (const prop of props) {
      if (seenPropIds.has(prop.id)) continue; // skip duplicates
      seenPropIds.add(prop.id);

      process.stdout.write(`  [${prop.id}] ${prop.title} ... `);
      const bookings = await client.getBookings12Months(compound.id, prop.id);
      const manualBlocks = manualBlocksById[prop.id] || [];
      const ics = generateIcal(prop, bookings, manualBlocks);
      fs.writeFileSync(path.join(outDir, `${prop.id}.ics`), ics, 'utf8');
      const manualNote = manualBlocks.length ? ` (+${manualBlocks.length} manual)` : '';
      console.log(`${bookings.length} events${manualNote}`);
      totalEvents += bookings.length;
      index.push({ id: prop.id, title: prop.title, number: prop.number, compound: compound.name, compoundId: compound.id });
    }
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
