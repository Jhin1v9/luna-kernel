#!/usr/bin/env node
/**
 * fix-openchat-number-match.js — numero formatado (+34 685...) = numero (2026-10-20)
 *
 * BUG AO VIVO (owner viu a tela): openChat digita "+34 685 09 31 92" na busca,
 * o contato salvo "Abner" aparece, ele clica — mas matches() abortava porque
 * o classificador isDirectNumber usava /^\d{8,15}$/ que SÓ aceita digitos
 * puros. Com +/espacos, o numero virava "nome" -> core("Abner") !==
 * core("+34 685 09 31 92") -> ABORT com o chat CERTO aberto.
 *
 * O fallback de "contato salvo" (header mostra o nome, nao o numero -> aceita
 * painel nao-grupo) JA EXISTIA no matches() — so estava inalcancavel.
 *
 * FIX: normalizar antes de classificar — so digitos/separadores com 8+ digitos
 * conta como numero. Nome com emoji/acento continua pelo caminho de nome
 * (core() ja ignora emoji — decreto owner: "se for parecido manda tb").
 *
 * USO:  node fix-openchat-number-match.js
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = 'C:\\Users\\Abner\\Documents\\Luna cto\\luna-agent';
const FILE = path.join(ROOT, 'apps', 'whatsplay', 'src', 'browser.ts');
const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

if (!fs.existsSync(FILE)) { console.error('Nao encontrado: ' + FILE); process.exit(1); }
fs.copyFileSync(FILE, FILE + '.bak-' + ts);
let src = fs.readFileSync(FILE, 'utf8');
const isCrlf = src.includes('\r\n');
const norm = (s) => isCrlf ? s.replace(/\n/g, '\r\n') : s;

const OLD = `    const isJid = nameOrId.includes('@');
    const searchKey = isJid ? nameOrId.split('@')[0] : nameOrId;
    const isDirectNumber = /^\\d{8,15}$/.test(searchKey);`;

const NEW = `    const isJid = nameOrId.includes('@');
    const searchKey = isJid ? nameOrId.split('@')[0] : nameOrId;
    // fix owner 2026-10-20: "+34 685 09 31 92" / "(34) 685-093-192" falhavam no
    // regex puro -> numero virava "nome" -> matches() abortava COM O CHAT
    // CERTO ABERTO. Classifica como numero quando so tem digitos/separadores
    // e 8+ digitos (com DDI). O fallback de contato salvo do matches() (header
    // mostra o NOME salvo -> aceita painel nao-grupo) passa a ser alcancavel.
    const __digitsOnly = searchKey.replace(/\\D/g, '');
    const isDirectNumber = !isJid && __digitsOnly.length >= 8 && /^[\\d\\s()+.\\-]+$/.test(searchKey.trim());`;

if (src.includes('__digitsOnly')) {
  console.log('[SKIP] ja aplicado');
} else {
  const o = norm(OLD);
  const count = src.split(o).length - 1;
  if (count !== 1) { console.error('[FALHOU] ancora ' + count + 'x — me manda: grep -n "isDirectNumber" "' + FILE + '"'); process.exit(1); }
  fs.writeFileSync(FILE, src.replace(o, norm(NEW)));
  console.log('[OK] isDirectNumber agora aceita numero formatado (+34 685 09 31 92)');
}

try { execSync('pm2 restart luna-whatsplay', { encoding: 'utf8' }); console.log('[OK] luna-whatsplay reiniciado'); }
catch { console.log('pm2 restart falhou'); }

console.log('');
console.log('\x1b[32m✅ MATCH NUMERO↔NOME CURADO.\x1b[0m');
console.log('   "+34 685 09 31 92" -> classificado como numero -> busca -> Abner aparece');
console.log('   -> painel abre -> header sem digitos MAS contato salvo (nao-grupo)');
console.log('   -> ACEITO -> envia. Emoji/acento no nome: core() ja ignora.');
console.log('\x1b[90mBackup: browser.ts.bak-' + ts + '\x1b[0m');
