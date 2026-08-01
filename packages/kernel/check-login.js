const { chromium } = require("playwright");
(async () => {
  const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
  const ctx = browser.contexts()[0];
  const pages = ctx.pages().filter(p => p.url().includes("kimi.com") && !p.url().startsWith("blob:"));
  const page = pages[0] || await ctx.newPage();
  console.log("URL:", page.url());
  const r = await page.evaluate(() => {
    const loginSels = "form[action*=\"login\"], form[action*=\"auth\"], input[type=\"password\"], .phone-login-action, .login-modal, .login-modal-mask".split(",").map(s=>s.trim());
    const appSels = ".chat-input-editor, .chat-editor, .markdown-container, .segment-assistant-actions, .chat-input, .user-avatar-container".split(",").map(s=>s.trim());
    const found = {};
    for (const s of loginSels) {
      const el = document.querySelector(s);
      if (el) found["login:"+s] = { visible: !!(el.offsetParent || el.getClientRects().length), tag: el.tagName, cls: el.className?.toString?.().slice(0,80) };
    }
    for (const s of appSels) {
      const el = document.querySelector(s);
      if (el) found["app:"+s] = { visible: !!(el.offsetParent || el.getClientRects().length), tag: el.tagName };
    }
    const kimiAuth = document.cookie.includes("kimi-auth") || document.cookie.includes("auth");
    return { found, cookieLen: document.cookie.length, bodySnippet: document.body?.innerText?.slice(0,150) };
  });
  console.log(JSON.stringify(r, null, 2));
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
