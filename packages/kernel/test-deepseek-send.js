const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const context = browser.contexts()[0];
  const pages = context.pages();
  const deepseekPage = pages.find(p => p.url().includes('chat.deepseek.com'));
  
  console.log('Page URL:', deepseekPage.url());
  
  // Find input and send button
  const input = deepseekPage.locator('textarea').first();
  const count = await input.count();
  console.log('Input count:', count);
  
  if (count > 0) {
    await input.fill('Oi, responda pong');
    await deepseekPage.waitForTimeout(300);
    
    // Try pressing Enter
    await input.press('Enter');
    console.log('Pressed Enter');
    
    await deepseekPage.waitForTimeout(5000);
    
    // Check for response
    const messages = await deepseekPage.evaluate(() => {
      return Array.from(document.querySelectorAll('.ds-message')).map(el => ({
        text: el.innerText.slice(0, 200),
        html: el.outerHTML.slice(0, 200)
      }));
    });
    console.log('Messages:', JSON.stringify(messages, null, 2));
  }
  
  await browser.close();
})();
