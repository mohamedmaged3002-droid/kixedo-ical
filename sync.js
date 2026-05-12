require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { KixedoClient } = require('./src/client');
const { generateIcal } = require('./src/ical');

// All 24 Kixedo compounds (from the property-availability filter dropdown)
const COMPOUNDS = [
  { id: 3,  name: 'Marassi' },
  { id: 4,  name: 'Fouka Bay' },
  { id: 5,  name: 'Il Monte Galala' },
  { id: 6,  name: 'Playa' },
  { id: 7,  name: 'Mynt Stay North 90' },
  { id: 9,  name: 'Cairo Festival City' },
  { id: 10, name: 'Lake View Residence' },
  { id: 11, name: '90 Avenue' },
  { id: 12, name: 'ZED WEST' },
  { id: 13, name: 'KAI' },
  { id: 14, name: 'Four Season Garden City' },
  { id: 15, name: 'District 5' },
  { id: 16, name: 'Sodic Villette' },
  { id: 17, name: 'Hyde Park' },
  { id: 18, name: "Regent's Park" },
  { id: 19, name: 'The Village' },
  { id: 20, name: 'Eastown' },
  { id: 21, name: 'Mirage' },
  { id: 22, name: 'Yassmin' },
  { id: 23, name: 'Mivida' },
  { id: 24, name: 'South Academy' },
  { id: 25, name: 'Zamalek' },
  { id: 26, name: 'EL Hayat' },
  { id: 27, name: 'Vilory Boutique' },
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

  for (const compound of COMPOUNDS) {
    const props = await client.getProperties(compound.id);
    if (!props.length) {
      console.log(`  ${compound.name}: 0 properties — skipping`);
      continue;
    }
    console.log(`${compound.name} (${compound.id}): ${props.length} properties`);

    for (const prop of props) {
      process.stdout.write(`  [${prop.id}] ${prop.title} ... `);
      const bookings = await client.getBookings12Months(compound.id, prop.id);
      const ics = generateIcal(prop, bookings);
      fs.writeFileSync(path.join(outDir, `${prop.id}.ics`), ics, 'utf8');
      console.log(`${bookings.length} events`);
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
