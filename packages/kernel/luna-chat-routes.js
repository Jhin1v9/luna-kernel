// Wrapper (fix-luna-web-3458): o luna-server.js do kernel faz
// require('./luna-chat-routes') e espera { router, setupAuth }.
// O arquivo real mora em apps/dashboard/ — apontamos pra la em vez de copiar
// (copiar quebra os requires relativos dele: selfheal, luna-goal, e o
// require lazy de './luna-server' que tem fallback p/ global.__lunaApp).
module.exports = require('../../apps/dashboard/luna-chat-routes.js');
