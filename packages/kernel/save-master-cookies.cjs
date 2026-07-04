#!/usr/bin/env node
/**
 * Save Kimi cookies permanently after manual login.
 * Run this after logging into Kimi Web manually.
 * Usage: node save-master-cookies.cjs
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const SAVE_DIR = path.join(__dirname, 'cookies');
const SAVE_FILE = path.join(SAVE_DIR, 'kimi-master-cookies.json');

(async () => {
  try {
    console.log('Connecting to Chrome...');
    const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
    const context = browser.contexts()[0];
    
    const allCookies = await context.cookies();
    const kimiCookies = allCookies.filter(c => 
      c.domain.includes('kimi') || c.domain.includes('moonshot')
    );
    
    if (kimiCookies.length === 0) {
      console.log('❌ No Kimi cookies found. Are you logged in?');
      process.exit(1);
    }
    
    fs.mkdirSync(SAVE_DIR, { recursive: true });
    
    const data = {
      savedAt: new Date().toISOString(),
      totalCookies: allCookies.length,
      kimiCookies: kimiCookies.length,
      cookies: allCookies, // Save ALL cookies, not just Kimi (for completeness)
    };
    
    fs.writeFileSync(SAVE_FILE, JSON.stringify(data, null, 2));
    
    console.log(`✅ Saved ${kimiCookies.length} Kimi cookies permanently to:`);
    console.log(`   ${SAVE_FILE}`);
    console.log('');
    console.log('Cookie names:', kimiCookies.map(c => c.name).join(', '));
    
    process.exit(0);
  } catch (e) {
    console.error('Error:', e.message);
    process.exit(1);
  }
})();
