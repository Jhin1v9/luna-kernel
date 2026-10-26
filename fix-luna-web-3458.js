#!/usr/bin/env node
/* fix-luna-web-3458.js — wrapper das rotas do dashboard pro kernel.
   O luna-server.js (porta 3458) morria no boot na linha 140: o require de
   './luna-chat-routes' nao resolvia em packages/kernel/ e o keep-alive so
   salvava o processo — o server.listen(PORT) da linha 435 NUNCA executava.
   Fix: packages/kernel/luna-chat-routes.js vira um wrapper que aponta pro
   arquivo real em apps/dashboard/ (deps dele resolvem la; soul via
   global.__lunaApp do kernel). */
const fs = require('fs');
const { execSync, spawn } = require('child_process');

const P = 'C:\\Users\\Abner\\Documents\\luna-kernel\\packages\\kernel\\luna-chat-routes.js';
const WRAPPER = `// Wrapper (fix-luna-web-3458): o luna-server.js do kernel faz
// require('./luna-chat-routes') e espera { router, setupAuth }.
// O arquivo real mora em apps/dashboard/ — apontamos pra la em vez de copiar
// (copiar quebra os requires relativos dele: selfheal, luna-goal, e o
// require lazy de './luna-server' que tem fallback p/ global.__lunaApp).
module.exports = require('../../apps/dashboard/luna-chat-routes.js');
`;

try {
  fs.writeFileSync(P, WRAPPER);
  execSync('node --check "' + P + '"', { stdio: 'pipe' });
  console.log('[OK] wrapper escrito e sintaxe valida: ' + P);
} catch (e) { console.log('[FAIL] ' + e.message); process.exit(1); }

try {
  spawn('cmd.exe', ['/c', 'pm2', 'restart', 'luna-kernel'], { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
  console.log('[OK] restart disparado: luna-kernel');
} catch (e) { console.log('[AVISO] restart: ' + e.message); }

console.log('');
console.log('=== AGUARDA ~5s E RODA: ===');
console.log('curl -s -o /dev/null -w "%{http_code}\\n" http://127.0.0.1:3458');
console.log('grep -a "Luna Web rodando" ~/.pm2/logs/luna-kernel-out.log | tail -2');
console.log('=== esperado: 200 + "Luna Web rodando em http://localhost:3458" ===');
