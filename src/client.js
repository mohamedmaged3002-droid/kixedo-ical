const axios = require('axios');
const { wrapper } = require('axios-cookiejar-support');
const { CookieJar } = require('tough-cookie');

const BASE_URL = 'https://cp.mynt.kixedo.com';
const DELAY_MS = 60;

const sleep = ms => new Promise(r => setTimeout(r, ms));

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
    const loginPage = await this.http.get('/login', {
      headers: { Accept: 'text/html,application/xhtml+xml,*/*' },
    });
    const csrfMatch = loginPage.data.match(/name="csrf-token" content="([^"]+)"/)
      || loginPage.data.match(/content="([^"]+)" name="csrf-token"/);
    if (!csrfMatch) throw new Error('CSRF token not found on login page');
    const csrf = csrfMatch[1];

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

  async getProperties(compoundId) {
    await sleep(DELAY_MS);
    try {
      const res = await this.http.get('/properties/dropdown', {
        params: { project_id: compoundId },
      });
      return Array.isArray(res.data) ? res.data : [];
    } catch {
      return [];
    }
  }

  async getBookings12Months(compoundId, propertyId) {
    const now = new Date();
    const allBookings = [];

    for (let i = 0; i < 7; i++) {  // 7 months (current + 6 ahead) — enough for OTAs
      const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
      const year = d.getFullYear();
      const month = d.getMonth() + 1;
      const start = d.toISOString();
      const end = new Date(year, month, 1).toISOString();

      await sleep(DELAY_MS);
      try {
        const res = await this.http.get('/bookings/monthly-calendar', {
          params: { project_id: compoundId, property_id: propertyId, year, month, start, end },
        });
        if (Array.isArray(res.data)) {
          allBookings.push(...res.data);
        } else if (res.data && typeof res.data === 'object' && !Array.isArray(res.data)) {
          // Kixedo returned an object instead of array — log once for debugging
          if (i === 0) process.stderr.write(`  [warn] booking API returned object: ${JSON.stringify(res.data).substring(0, 100)}\n`);
        }
      } catch {
        // skip month on error
      }
    }

    // Deduplicate by booking id
    const seen = new Set();
    return allBookings.filter(b => {
      if (seen.has(b.id)) return false;
      seen.add(b.id);
      return true;
    });
  }
}

module.exports = { KixedoClient };
