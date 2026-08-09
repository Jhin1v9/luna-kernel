const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const context = browser.contexts()[0];
  
  // Find DeepSeek page
  const pages = context.pages();
  const deepseekPage = pages.find(p => p.url().includes('chat.deepseek.com') || p.url().includes('deepseek.com'));
  
  if (!deepseekPage) {
    console.error('DeepSeek page not found');
    await browser.close();
    process.exit(1);
  }
  
  console.log('Found DeepSeek page:', deepseekPage.url());
  
  // Get cookies for deepseek domains
  const allCookies = await context.cookies();
  const deepseekCookies = allCookies.filter(c => 
    c.domain.includes('deepseek.com')
  );
  
  // Get localStorage
  const localStorageData = await deepseekPage.evaluate(() => {
    const data = {};
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      data[key] = localStorage.getItem(key);
    }
    return data;
  });
  
  // Save files in the format expected by kimi-bridge.cjs:
  // { cookies: [...] } for master cookies
  // { localStorage: [...] } or plain object for localStorage
  const cookiesDir = path.join(__dirname, 'cookies');
  if (!fs.existsSync(cookiesDir)) fs.mkdirSync(cookiesDir, { recursive: true });
  
  fs.writeFileSync(
    path.join(cookiesDir, 'deepseek-master-cookies.json'),
    JSON.stringify({ cookies: deepseekCookies }, null, 2)
  );
  
  // The bridge expects localStorage as an array of {key, value} or a plain object
  const localStorageArray = Object.entries(localStorageData).map(([key, value]) => ({ key, value }));
  fs.writeFileSync(
    path.join(cookiesDir, 'deepseek-master-localstorage.json'),
    JSON.stringify(localStorageData, null, 2)
  );
  
  console.log(`Saved ${deepseekCookies.length} cookies`);
  console.log(`Saved ${Object.keys(localStorageData).length} localStorage items`);
  console.log('Files:');
  console.log('  - cookies/deepseek-master-cookies.json');
  console.log('  - cookies/deepseek-master-localstorage.json');
  
  await browser.close();
})();
