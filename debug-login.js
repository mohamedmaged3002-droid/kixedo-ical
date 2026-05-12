require('dotenv').config();
const axios = require('axios');
const { wrapper } = require('axios-cookiejar-support');
const { CookieJar } = require('tough-cookie');

const BASE = 'https://cp.mynt.kixedo.com';

async function main() {
  const jar = new CookieJar();
  const http = wrapper(axios.create({ baseURL: BASE, jar, withCredentials: true, maxRedirects: 5 }));

  // Step 1: get login page and extract CSRF
  const page = await http.get('/login', { headers: { Accept: 'text/html,*/*' } });
  const m1 = page.data.match(/name="csrf-token" content="([^"]+)"/);
  const m2 = page.data.match(/content="([^"]+)" name="csrf-token"/);
  const csrf = (m1 || m2)?.[1];
  console.log('CSRF found:', !!csrf, csrf?.substring(0, 20) + '...');

  // Step 2: check what input fields the form has
  const fields = [...page.data.matchAll(/name="([^"]+)"/g)].map(m => m[1]);
  console.log('Form fields on login page:', fields);

  // Step 3: attempt login
  const body = new URLSearchParams();
  body.append('_token', csrf);
  body.append('email', process.env.KIXEDO_EMAIL);
  body.append('password', process.env.KIXEDO_PASSWORD);
  console.log('Posting with email:', process.env.KIXEDO_EMAIL);
  console.log('Password length:', process.env.KIXEDO_PASSWORD?.length);

  try {
    const res = await http.post('/login', body.toString(), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': `${BASE}/login`,
        'Accept': 'text/html,*/*',
      },
    });
    console.log('Login response status:', res.status);
    console.log('Final URL:', res.request?.res?.responseUrl);
    console.log('Response contains "Sign In":', res.data.includes('Sign In'));
    console.log('Response contains "Dashboard":', res.data.includes('Dashboard'));
  } catch (err) {
    console.error('Login failed:', err.response?.status, err.response?.statusText);
    if (err.response?.data) {
      const d = err.response.data;
      console.error('Response body:', typeof d === 'string' ? d.substring(0, 500) : JSON.stringify(d).substring(0, 500));
    }
  }
}

main().catch(console.error);
