function fmtDate(dateStr) {
  return dateStr.replace(/-/g, '');
}

function esc(text) {
  return String(text || '').replace(/[\\;,]/g, c => '\\' + c).replace(/\n/g, '\\n');
}

// iCal UTC timestamp, e.g. 20260609T201824Z
function icalStamp(d = new Date()) {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function generateIcal(property, bookings, manualBlocks = []) {
  const stamp = icalStamp();
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Mynt Kixedo iCal Bridge//EN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${esc(property.title)}`,
    'CALSCALE:GREGORIAN',
  ];

  for (const b of bookings) {
    const start = fmtDate(b.start);
    const end = fmtDate(b.end);
    lines.push(
      'BEGIN:VEVENT',
      // Include start+end in the UID so a changed/extended booking becomes a NEW
      // event for incremental OTA importers. kixedo b.id alone stays constant when
      // the dates change, which left the old dates stuck until a manual re-add.
      `UID:kixedo-${b.id}-${start}-${end}@mynt.kixedo.com`,
      // DTSTAMP is required by RFC 5545 and (with LAST-MODIFIED) is how importers
      // detect that an event changed.
      `DTSTAMP:${stamp}`,
      `LAST-MODIFIED:${stamp}`,
      `DTSTART;VALUE=DATE:${start}`,
      `DTEND;VALUE=DATE:${end}`,
      `SUMMARY:${esc(b.type === 'booking' ? 'BLOCKED' : b.title)}`,
      'STATUS:CONFIRMED',
      'TRANSP:OPAQUE',
      'END:VEVENT',
    );
  }

  for (const b of manualBlocks) {
    lines.push(
      'BEGIN:VEVENT',
      `UID:manual-${b.start}-${b.end}@mynt.bluekeys.co`,
      `DTSTAMP:${stamp}`,
      `LAST-MODIFIED:${stamp}`,
      `DTSTART;VALUE=DATE:${fmtDate(b.start)}`,
      `DTEND;VALUE=DATE:${fmtDate(b.end)}`,
      `SUMMARY:${esc(b.summary || 'BLOCKED')}`,
      'STATUS:CONFIRMED',
      'TRANSP:OPAQUE',
      'END:VEVENT',
    );
  }

  lines.push('END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}

module.exports = { generateIcal };
