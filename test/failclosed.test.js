// Regression test for the 2026-08-15 feed wipe: a network flap made 41 feeds publish
// with ZERO blocked events for 2h34m, telling every subscribed OTA those nights were
// free. Asserts the two fail-closed behaviours that prevent a repeat.
const assert = require('assert');
const { KixedoClient } = require('../src/client');

function stub(client, handler) {
  client.http = { get: handler };
}

(async () => {
  // 1. A month that never succeeds is UNKNOWN, not "no bookings".
  {
    const c = new KixedoClient();
    stub(c, async () => { throw new Error('stream has been aborted'); });
    const { bookings, failedMonths } = await c.getBookings12Months(3, 105);
    assert.strictEqual(bookings.length, 0);
    assert.strictEqual(failedMonths, 7, 'every month should be reported failed');
    console.log('ok  total outage -> failedMonths=7 (feed will be skipped)');
  }

  // 2. A partial flap still marks the property unpublishable.
  {
    const c = new KixedoClient();
    let id = 0;
    const deadMonth = new Date().getMonth() + 3;  // one month is down for the whole run
    stub(c, async (_url, cfg) => {
      if (cfg.params.month === ((deadMonth - 1) % 12) + 1) throw new Error('socket hang up');
      return { data: [{ id: ++id, date_from: '2026-09-01', date_to: '2026-09-03' }] };
    });
    const { bookings, failedMonths } = await c.getBookings12Months(3, 105);
    assert.strictEqual(failedMonths, 1, 'a persistently dropped month must be surfaced');
    assert.ok(bookings.length > 0, 'the readable months should still come back');
    console.log(`ok  partial flap -> failedMonths=${failedMonths} (feed will be skipped)`);
  }

  // 3. A transient error that later succeeds is retried, not counted as failed.
  {
    const c = new KixedoClient();
    let calls = 0;
    stub(c, async () => {
      calls++;
      if (calls <= 2) throw new Error('ECONNRESET');
      return { data: [] };
    });
    const { failedMonths } = await c.getBookings12Months(3, 105);
    assert.strictEqual(failedMonths, 0, 'retry should absorb a transient blip');
    console.log('ok  transient blip absorbed by retry');
  }

  // 4. An unreadable roster throws instead of silently yielding an empty compound.
  {
    const c = new KixedoClient();
    stub(c, async () => ({ data: { error: 'Too Many Attempts.' } }));
    await assert.rejects(() => c.getProperties(4), /expected an array/);
    console.log('ok  non-array roster rejects (compound is not treated as empty)');
  }

  console.log('\nAll fail-closed tests passed.');
})().catch(err => { console.error('FAILED:', err.message); process.exit(1); });
