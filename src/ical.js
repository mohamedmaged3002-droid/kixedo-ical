function fmtDate(dateStr) {
  // "2026-05-28" → "20260528"
  return dateStr.replace(/-/g, '');
}

function esc(text) {
  return String(text || '').replace(/[\\;,]/g, c => '\\' + c).replace(/\n/g, '\\n');
}

function generateIcal(property, bookings) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Mynt Kixedo iCal Bridge//EN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${esc(property.title)}`,
    'CALSCALE:GREGORIAN',
  ];

  for (const b of bookings) {
    lines.push(
      'BEGIN:VEVENT',
      `UID:kixedo-${b.id}@mynt.kixedo.com`,
      `DTSTART;VALUE=DATE:${fmtDate(b.start)}`,
      `DTEND;VALUE=DATE:${fmtDate(b.end)}`,
      `SUMMARY:${esc(b.type === 'booking' ? 'BLOCKED' : b.title)}`,
      'STATUS:CONFIRMED',
      'TRANSP:OPAQUE',
      'END:VEVENT',
    );
  }

  lines.push('END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}

module.exports = { generateIcal };
