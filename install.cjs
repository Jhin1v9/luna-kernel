#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const readline = require('readline');
const crypto = require('crypto');
const os = require('os');

const HOME = os.homedir();
const LUNA_DIR = process.env.LUNA_DIR || path.join(HOME, '.luna-kernel');
const LUNA_HOME = process.env.LUNA_HOME || path.join(HOME, '.luna');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function ask(question, defaultValue = '') {
  return new Promise((resolve) => {
    const prompt = defaultValue ? `${question} [${defaultValue}]: ` : `${question}: `;
    rl.question(prompt, (answer) => {
      resolve(answer.trim() || defaultValue);
    });
  });
}

function run(cmd, cwd = LUNA_DIR, timeout = 120000) {
  console.log(`$ ${cmd}`);
  return execSync(cmd, { cwd, stdio: 'inherit', timeout });
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

module.exports = { ask, run, generateToken, ensureDir, LUNA_DIR, LUNA_HOME, HOME };

// If executed directly, run installer
if (require.main === module) {
  (async () => {
    console.log('🌙 Luna Installer (Node phase)');
    console.log('');
    console.log('Utilitários carregados. Execute o fluxo completo via importação.');
    rl.close();
  })();
}
