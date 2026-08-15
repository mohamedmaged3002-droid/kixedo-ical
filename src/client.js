const axios = require('axios');
const { wrapper } = require('axios-cookiejar-support');
const { CookieJar } = require('tough-cookie');

const BASE_URL = 'https://cp.mynt.kixedo.com';
const DELAY_MS = 60;

// Kixedo intermittently drops connections from GitHub runner IPs (seen 2026-08-15:
// truncated login HTML and mid-stream aborts). One blip used to be enough to either
// kill the run at login or — far worse — silently produce an empty feed. Retry every
// request, and make the callers treat a request that never succeeded as UNKNOWN
// rather than as "no bookings". See L-1xx / the fail-closed guard in sync.js.
const RETRIES = 3;
const RETRY_BACKOFF_MS = [1000, 3000, 8000];

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Runs fn up to RETRIES times. Throws the last error if every attempt fails.
async function withRetry(label, fn) {
  let lastErr;
  for (let attempt = 0; attempt < RETRIES; attempt++) {
    if (attempt > 0) await sleep(RETRY_BACKOFF_MS[attempt - 1]);
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const status = err.response?.status ? ` HTTP ${err.response.status}` : '';
      process.stderr.write(
        `  [retry] ${label} attempt ${attempt + 1}/${RETRIES} failed${status}: ${err.message}\n`
      );
    }
  }
  throw lastErr;
}

class KixedoClient {
  constructor() {
    const jar = new CookieJar();
    this.http = wrapper(axios.create({
      baseURL: BASE_URL,
      jar,
      withCredentials: true,
      maxRedirects: 5,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'X-Requested-With': 'XMLHttpRequest',
      },
    }));
  }

  async login(email, password) {
    const csrf = await withRetry('GET /login', async () => {
      const loginPage = await this.http.get('/login', {
        headers: { Accept: 'text/html,application/xhtml+xml,*/*' },
      });
      const html = String(loginPage.data);
      const csrfMatch = html.match(/name="csrf-token" content="([^"]+)"/)
        || html.match(/content="([^"]+)" name="csrf-token"/);
      if (!csrfMatch) {
        // Log enough to tell a WAF/rate-limit page apart from a truncated response.
        throw new Error(
          `CSRF token not found on login page (HTTP ${loginPage.status}, `
          + `${html.length} bytes, content-type ${loginPage.headers?.['content-type'] || '?'}): `
          + html.slice(0, 200).replace(/\s+/g, ' ')
        );
      }
      return csrfMatch[1];
    });

    const body = new URLSearchParams();
    body.append('_token', csrf);
    body.append('username', email);
    body.append('password', password);

    const res = await this.http.post('/login', body.toString(), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-CSRF-TOKEN': csrf,
        'Referer': `${BASE_URL}/login`,
        'Accept': 'text/html,application/xhtml+xml,*/*',
      },
    });

    const finalUrl = res.request?.res?.responseUrl || res.request?.responseURL || '';
    const html = String(res.data);
    const isLoggedIn = (finalUrl && !finalUrl.includes('/login')) || !html.includes('Sign In');
    if (!isLoggedIn) throw new Error('Login failed — check credentials');

    // Verify session works by hitting the dashboard
    await sleep(300);
    const verify = await this.http.get('/dashboard', {
      headers: { Accept: 'text/html,*/*' },
      maxRedirects: 0,
      validateStatus: s => s < 400,
    }).catch(() => null);

    const verifyUrl = verify?.request?.res?.responseUrl || verify?.request?.responseURL || '';
    if (verifyUrl.includes('/login')) {
      throw new Error('Session not persisting after login — cookie jar issue');
    }

    console.log('Session verified OK');
  }

  // Throws if the roster can't be fetched. An empty roster is NOT a valid result to
  // carry on with: it is indistinguishable from a failed request, and treating it as
  // "this compound has no units" silently drops every feed under it.
  async getProperties(compoundId) {
    return withRetry(`GET /properties/dropdown (compound ${compoundId})`, async () => {
      await sleep(DELAY_MS);
      const res = await this.http.get('/properties/dropdown', {
        params: { project_id: compoundId },
      });
      if (!Array.isArray(res.data)) {
        throw new Error(`expected an array, got ${typeof res.data}`);
      }
      return res.data;
    });
  }

  // Returns { bookings, failedMonths }. A month we could not fetch is UNKNOWN, not
  // empty — the caller must refuse to publish a feed with failedMonths > 0, because
  // the .ics only lists BLOCKED dates, so a dropped month silently reads to an OTA as
  // "these nights are free" and invites a double booking.
  async getBookings12Months(compoundId, propertyId) {
    const now = new Date();
    const allBookings = [];
    let failedMonths = 0;

    for (let i = 0; i < 7; i++) {  // 7 months (current + 6 ahead) — enough for OTAs
      const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
      const year = d.getFullYear();
      const month = d.getMonth() + 1;
      const start = d.toISOString();
      const end = new Date(year, month, 1).toISOString();

      try {
        const data = await withRetry(`bookings ${propertyId} ${year}-${month}`, async () => {
          await sleep(DELAY_MS);
          const res = await this.http.get('/bookings/monthly-calendar', {
            params: { project_id: compoundId, property_id: propertyId, year, month, start, end },
          });
          if (!Array.isArray(res.data)) {
            // An object here means the API answered with something we can't read
            // (error envelope, login redirect). Unknown — never "no bookings".
            throw new Error(
              `expected an array, got ${JSON.stringify(res.data).substring(0, 100)}`
            );
          }
          return res.data;
        });
        allBookings.push(...data);
      } catch {
        failedMonths++;
      }
    }

    // Deduplicate by booking id
    const seen = new Set();
    const bookings = allBookings.filter(b => {
      if (seen.has(b.id)) return false;
      seen.add(b.id);
      return true;
    });
    return { bookings, failedMonths };
  }
}

module.exports = { KixedoClient };
