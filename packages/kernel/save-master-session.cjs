const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');

const COOKIES_DIR = path.join(__dirname, 'cookies');
const MASTER_COOKIES = path.join(COOKIES_DIR, 'kimi-master-cookies.json');
const MASTER_LOCALSTORAGE = path.join(COOKIES_DIR, 'kimi-master-localstorage.json');

(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const ctx = browser.contexts()[0];
  const page = ctx.pages().find(p => p.url().includes('kimi.com'));
  
  if (!page) {
    console.log('No Kimi page found');
    process.exit(1);
  }
  
  // Save cookies
  const cookies = await ctx.cookies();
  fs.mkdirSync(COOKIES_DIR, { recursive: true });
  fs.writeFileSync(MASTER_COOKIES, JSON.stringify({ savedAt: new Date().toISOString(), cookies }, null, 2));
  console.log('Saved', cookies.length, 'cookies');
  
  // Save localStorage
  const localStorage = await page.evaluate(() => {
    const items = {};
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      items[key] = localStorage.getItem(key);
    }
    return items;
  });
  fs.writeFileSync(MASTER_LOCALSTORAGE, JSON.stringify({ savedAt: new Date().toISOString(), data: localStorage }, null, 2));
  console.log('Saved', Object.keys(localStorage).length, 'localStorage items');
  
  // Show critical auth items
  const critical = ['access_token', 'refresh_token', 'anonymous_access_token', 'anonymous_refresh_token', 'msh_user_id', 'kimi-auth'];
  console.log('\nCritical auth items:');
  for (const key of critical) {
    const val = localStorage[key] || cookies.find(c => c.name === key)?.value;
    if (val) {
      console.log('  ✅', key, ':', val.substring(0, 50) + (val.length > 50 ? '...' : ''));
    } else {
      console.log('  ❌', key, ': NOT FOUND');
    }
  }
  
  process.exit(0);
})();
