require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { KixedoClient } = require('./src/client');
const { generateIcal } = require('./src/ical');

// Load manual blocks grouped by kixedo_id
const MANUAL_BLOCKS_FILE = path.join(__dirname, 'manual-blocks.json');
const allManualBlocks = JSON.parse(fs.readFileSync(MANUAL_BLOCKS_FILE, 'utf8'))
  .filter(b => b.kixedo_id > 0); // skip the example entry
const manualBlocksById = {};
for (const b of allManualBlocks) {
  if (!manualBlocksById[b.kixedo_id]) manualBlocksById[b.kixedo_id] = [];
  manualBlocksById[b.kixedo_id].push(b);
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

  const outDir = path.join(__dirname, 'public');
  fs.mkdirSync(outDir, { recursive: true });

  const client = new KixedoClient();
  console.log('Logging in to Kixedo...');
  await client.login(email, password);
  console.log('Logged in.\n');

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
