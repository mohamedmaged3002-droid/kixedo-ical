const axios = require('axios');
const { wrapper } = require('axios-cookiejar-support');
const { CookieJar } = require('tough-cookie');

const BASE_URL = 'https://cp.mynt.kixedo.com';
const DELAY_MS = 120;

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
        'User-Agent': 'Mozilla/5.0 (compatible; Kixedo-iCal/1.0)',
        'Accept': 'application/json, text/plain, */*',
        'X-Requested-With': 'XMLHttpRequest',
      },
    }));
  }

  async login(email, password) {
    const loginPage = await this.http.get('/login', {
      headers: { Accept: 'text/html,*/*' },
    });
    const csrfMatch = loginPage.data.match(/name="csrf-token" content="([^"]+)"/);
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
        'Accept': 'text/html,*/*',
      },
    });

    // Verify we're logged in by checking the response URL or content
    const isLoggedIn = res.request?.res?.responseUrl?.includes('/login') === false
      || !String(res.data).includes('Sign In');
    if (!isLoggedIn) throw new Error('Login failed — check credentials');
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

    for (let i = 0; i < 13; i++) {
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
        if (Array.isArray(res.data)) allBookings.push(...res.data);
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
