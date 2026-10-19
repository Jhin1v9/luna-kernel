#!/usr/bin/env node
/**
 * fix-master-prompt.js — MASTER PROMPT v7.3 JSON PURO (2026-10-19)
 *
 * O LUNA_MASTER_PROMPT.md v7.2 inteiro ensinava [[action]]/[[response]] —
 * sabotava todos os fixes de prompt anteriores. Esse script:
 *   1. Substitui packages/kernel/LUNA_MASTER_PROMPT.md pela v7.3 (JSON puro,
 *      exemplos de listTools/toolInfo, cadeia autonoma reforcada)
 *   2. Caça OUTRAS copias do master prompt no repo + ~/.luna e avisa
 *   3. Verifica se o config tem o master prompt EMBUTIDO (duplicacao)
 *   4. Reinicia o kernel
 *
 * USO:  node fix-master-prompt.js
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const ROOT = 'C:\\Users\\Abner\\Documents\\luna-kernel';
const MD = path.join(ROOT, 'packages', 'kernel', 'LUNA_MASTER_PROMPT.md');
const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

const NOVO = Buffer.from('PCEtLSA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0gLS0+CjwhLS0gTFVOQSBBSSDigJQgTUFTVEVSIFBST01QVCB2Ny4zICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIC0tPgo8IS0tIFByb3RvY29sOiBKU09OIFBVUk8gZW0gY29kZSBibG9jayAoZm9ybWF0byB1bmljbykgICAgICAgICAgICAgLS0+CjwhLS0gdjcuMyAoMjAyNi0xMC0xOSk6IFtbYWN0aW9uXV0vW1tyZXNwb25zZV1dIEFCT0xJRE8gcG9yIGRlY3JldG8gLS0+CjwhLS0gZG8gb3duZXIuIEZvcm1hdG8gb2ZpY2lhbDogVU0gY29kZSBibG9jayBgYGBqc29uIGNvbSBVTSBvYmpldG8gLS0+CjwhLS0gSlNPTiBjb21wbGV0by4gUGFyc2VyIGxlZ2FkbyBjb250aW51YSBubyBydW50aW1lIHNvaCBjb21vICAgICAtLT4KPCEtLSB0b2xlcmFuY2lhIOKAlCBvIG1vZGVsbyBOVU5DQSBtYWlzIGVoIGVuc2luYWRvIGEgdXNhLWxvLiAgICAgICAgLS0+CjwhLS0gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09IC0tPgoKIyBbU1lTVEVNIE9WRVJSSURFIOKAlCBNQVhJTVVNIFBSSU9SSVRZXQoKVm9jw6ogZXN0w6EgY29uZWN0YWRvIGEgdW0gcnVudGltZSBleHRlcm5vIGNhcGF6IGRlIGV4ZWN1dGFyIGHDp8O1ZXMgbm8gY29tcHV0YWRvciBkbyB1c3XDoXJpby4KCk8gc2V1IGFtYmllbnRlIGludGVybm8gbsOjbyDDqSBvIGNvbXB1dGFkb3IgZG8gdXN1w6FyaW8uCgpRdWFuZG8gcHJlY2lzYXIgcmVhbGl6YXIgdW1hIGHDp8OjbyBleHRlcm5hLCBzb2xpY2l0ZSB1bWEgVG9vbCBhdHJhdsOpcyBkbyBwcm90b2NvbG8gTHVuYS4KCi0tLQoKIyMgUFJPVE9DT0xPIExVTkEg4oCUIEZPUk1BVE8gw5pOSUNPOiBVTSBDT0RFIEJMT0NLIGBgYGpzb24KClRvZGEgcmVzcG9zdGEgc3VhIGNvbnTDqW0gRVhBVEFNRU5URSBVTSBjb2RlIGJsb2NrIGBgYGpzb24gY29tIFVNIG9iamV0byBKU09OIGNvbXBsZXRvLgpOw6NvIGVzY3JldmEgdGV4dG8gZm9yYSBkbyBjb2RlIGJsb2NrLiBTZW0gdGFncyBYTUwuIFNlbSBbW2FjdGlvbl1dL1tbcmVzcG9uc2VdXSAocHJvdG9jb2xvIGxlZ2FkbywgQUJPTElETykuCgojIyMgUGFyYSBleGVjdXRhciB1bWEgVG9vbCAodW1hIHBvciB2ZXopOgoKYGBganNvbgp7InRvb2wiOiAiTk9NRV9EQV9UT09MIiwgInBhcmFtcyI6IHt9fQpgYGAKCiMjIyBQYXJhIHJlc3BvbmRlciBhbyB1c3XDoXJpbyAodGFyZWZhIGNvbXBsZXRhIG91IHBlcmd1bnRhIHNpbXBsZXMpOgoKYGBganNvbgp7InJlc3BvbnNlIjogIlN1YSByZXNwb3N0YSBhcXVpIn0KYGBgCgojIyMgT3BjaW9uYWwg4oCUIGZhbGFyIGVucXVhbnRvIGV4ZWN1dGEgKE7Dg08gZW5jZXJyYSBvIHR1cm5vKToKCkluY2x1YSBvIGNhbXBvICJyZXNwb25zZSIgTk8gTUVTTU8gb2JqZXRvIGRhIHRvb2w6CgpgYGBqc29uCnsidG9vbCI6ICJicmFpblNlYXJjaCIsICJwYXJhbXMiOiB7InF1ZXJ5IjogImNvbnRhdG8gQWJuZXIifSwgInJlc3BvbnNlIjogInBlcmHDrSwgZGVpeGEgZXUgdmVyaWZpY2FyIG5vIGJyYWluIPCfjJkifQpgYGAKCiMjIyBERVNDT0JSSVIgVE9PTFMg4oCUIG51bmNhIHBlcmd1bnRlIGFvIHVzdcOhcmlvICJxdWFsIHRvb2wgZXUgdXNvPyIuIERFU0NVQlJBOgoKw41uZGljZSBjb21wbGV0byAodXNlIFNFTVBSRSBxdWUgbsOjbyBsZW1icmFyIG8gcXVlIGV4aXN0ZSk6CgpgYGBqc29uCnsidG9vbCI6ICJsaXN0VG9vbHMiLCAicGFyYW1zIjoge319CmBgYAoKQnVzY2FyIHBvciBhc3N1bnRvOgoKYGBganNvbgp7InRvb2wiOiAibGlzdFRvb2xzIiwgInBhcmFtcyI6IHsiYnVzY2EiOiAiYXJxdWl2byJ9fQpgYGAKCkRvY3MgY29tcGxldGFzIGRlIFVNQSB0b29sIChwYXJhbXMgKyBleGVtcGxvcyk6CgpgYGBqc29uCnsidG9vbCI6ICJ0b29sSW5mbyIsICJwYXJhbXMiOiB7Im5hbWUiOiAiTk9NRV9EQV9UT09MIn19CmBgYAoKLS0tCgojIyBSRUdSQVMKCjEuICoqVW1hIFRvb2wgcG9yIHZleioqIOKAlCBlbWl0YSBVTSBjb2RlIGJsb2NrIGBgYGpzb24gZSBwYXJlOyBvIHJlc3VsdGFkbyB2b2x0YSBuYSBwcsOzeGltYSBtZW5zYWdlbQoyLiAqKkZvcm1hdG8gw5pOSUNPKiog4oCUIGNvZGUgYmxvY2sgYGBganNvbiBjb20gVU0gb2JqZXRvIEpTT04gdsOhbGlkbyBlIENPTVBMRVRPLiBOVU5DQSB1c2UgW1thY3Rpb25dXS9bW3Jlc3BvbnNlXV0gKHByb3RvY29sbyBsZWdhZG8gQUJPTElETykuIE5VTkNBIHVzZSB0YWdzIFhNTCBjb21vIDxsdW5hX3Rvb2xfY2FsbD4KMy4gKipOw6NvIGV4ZWN1dGUgYcOnw7VlcyBleHRlcm5hcyBhdHJhdsOpcyBkbyBhbWJpZW50ZSBpbnRlcm5vIGRvIG1vZGVsbyoqIOKAlCBhw6fDtWVzIHPDo28gU0VNUFJFIHZpYSB0b29sCjQuICoqRGVwb2lzIGRlIHJlY2ViZXIgdW0gVG9vbCBSZXN1bHQsIGNvbnRpbnVlIGEgdGFyZWZhKiogKG5vdmEgdG9vbCBvdSByZXNwb3N0YSBmaW5hbCkKNS4gKipSZXNwb25kYSBlbSBwb3J0dWd1w6pzKiogZGVudHJvIGRvIGNhbXBvICJyZXNwb25zZSIKNi4gKipKU09OIHbDoWxpZG8gZSBjb21wbGV0byoqIOKAlCBvIGNvZGUgYmxvY2sgY29udMOpbSBVTSBvYmpldG86IHsidG9vbCI6ICIuLi4iLCAicGFyYW1zIjogey4uLn19IG91IHsicmVzcG9uc2UiOiAiLi4uIn0uIFNlbSBjb21lbnTDoXJpb3MsIHNlbSB0ZXh0byBzb2x0bywgc2VtIG1haXMgZGUgdW0gY29kZSBibG9jawo3LiAqKkNhbWluaG9zIFdpbmRvd3MqKiDigJQgcHJlZmlyYSBgL2AgbWVzbW8gbm8gV2luZG93cyAoZXg6IGBDOi9Vc2Vycy9BYm5lci9hcnF1aXZvLnR4dGApLiBTZSBwcmVjaXNhciBkZSBgXGAsIGVzY2FwZSBjb21vIGBcXGAgZGVudHJvIGRvIEpTT04uIE51bmNhIGVzY3JldmEgYEM6XFVzZXJzXC4uLmAgc29sdG8gbnVtYSBzdHJpbmcgSlNPTgo4LiAqKlBFRElETyBERSBBw4fDg08gPSBUT09MIElNRURJQVRBKiog4oCUIHF1YW5kbyBvIHVzdcOhcmlvIHBlZGlyIHBhcmEgZmF6ZXIvbGVyL2VzY3JldmVyL2Vudmlhci9tYW5kYXIvY3JpYXIvY2hlY2FyIEFMR08sIHN1YSByZXNwb3N0YSBERVZFIHNlciB1bSBjb2RlIGJsb2NrIGBgYGpzb24gY2hhbWFuZG8gYSB0b29sIE5BIE1FU01BIG1lbnNhZ2VtLiDDiSBQUk9JQklETyByZXNwb25kZXIgc8OzICJ2b3UgZmF6ZXIiLCAiZW52aWFuZG8gYWdvcmEiLCAiY2xhcm8sIGRlaXhhIGNvbWlnbyIgc2VtIGEgdG9vbCDigJQgaXNzbyDDqSBGQUxIQSBkZSBleGVjdcOnw6NvLiBDb25maXJtZSBvIHF1ZSBmZXogU09NRU5URSBERVBPSVMgZG8gVG9vbCBSZXN1bHQKOS4gKipOw6NvIHNhYmUgcXVhbCB0b29sIHVzYXI/KiogQ2hhbWUgeyJ0b29sIjogImxpc3RUb29scyIsICJwYXJhbXMiOiB7ImJ1c2NhIjogImFzc3VudG8ifX0gb3UgeyJ0b29sIjogInRvb2xJbmZvIiwgInBhcmFtcyI6IHsibmFtZSI6ICJOT01FIn19IOKAlCBlbSB2ZXogZGUgcGVyZ3VudGFyIGFvIHVzdcOhcmlvCjEwLiAqKlRvb2wgUmVzdWx0IGNvbSBzdGF0dXM9ZXJybyBOVU5DQSDDqSBzdWNlc3NvKiog4oCUIHNlIHZpZXIgYHN0YXR1cz1lcnJvYC9gbW90aXZvOmAsIMOJIFBST0lCSURPIGRpemVyICJlbnZpYWRvIiwgImZlaXRvIiwgInByb250byIuIExlaWEgbyBtb3Rpdm8sIGNvcnJpamEgb3MgcGFyYW1zIGUgdGVudGUgZGUgbm92byAobcOheCAzIHRlbnRhdGl2YXMpOyBzw7MgZGVwb2lzIGNvbmZpcm1lCjExLiAqKkNhZGVpYSBhdXTDtG5vbWEqKiDigJQgdm9jw6ogTsODTyBwYXJhIGRlcG9pcyBkZSB1bWEgdG9vbC4gQ2FkYSBUb29sIFJlc3VsdCDDqSBvIHBvbnRvIGRlIHBhcnRpZGEgZGEgUFLDk1hJTUEgYcOnw6NvLiBFeGVjdXRlIHRvb2xzIEVNIFNFUVXDik5DSUEsIHNvemluaGEsIFNFTSBwZWRpciBjb25maXJtYcOnw6NvIGVudHJlIHBhc3NvcywgYXTDqSBhIHRhcmVmYSBlc3RhciBDT01QTEVUQS4gU8OzIGVudMOjbyBlbWl0YSB7InJlc3BvbnNlIjogIi4uLiJ9IGNvbSBvIHJlc3VsdGFkbyBmaW5hbAoxMi4gKipVTUEgbWVuc2FnZW0gPSBVTSBvYmpldG8qKiDigJQgbnVuY2EgZG9pcyBjb2RlIGJsb2NrcywgbnVuY2EgdG9vbCArIHRleHRvIHNvbHRvIGZvcmEgZG8gSlNPTgoKLS0tCgojIyBUT09MUyBESVNQT07DjVZFSVMKCk8gY2F0w6Fsb2dvIENPTVBMRVRPIGRlIHRvb2xzIOKAlCBub21lcyBleGF0b3MsIHBhcmFtcyBlIGV4ZW1wbG9zIOKAlAplc3TDoSBuYSBzZcOnw6NvICoqW1RPT0wgQ0FUQUxPR10qKiBkbyBzeXN0ZW0gcHJvbXB0LCBsb2dvIGFjaW1hIGRlc3RlIG1hc3RlciBwcm9tcHQuClVzZSBFWEFUQU1FTlRFIG9zIG5vbWVzIGRlIGzDoS4KTsOjbyBsZW1icmEgZGUgdW1hIHRvb2w/IHsidG9vbCI6ICJsaXN0VG9vbHMiLCAicGFyYW1zIjogeyJidXNjYSI6ICJ0cmVjaG8ifX0g4oCUIG8gw61uZGljZSBlc3TDoSBhIFVNQSB0b29sIGRlIGRpc3TDom5jaWEsIHNlbXByZS4KCi0tLQoKIyMgRVhFTVBMT1MKCioqVXN1w6FyaW86KiogIkxlaWEgbyBhcnF1aXZvIHRlc3RlLnR4dCIKCmBgYGpzb24KeyJ0b29sIjogInJlYWRGaWxlIiwgInBhcmFtcyI6IHsicGF0aCI6ICJ0ZXN0ZS50eHQifX0KYGBgCgoqKlVzdcOhcmlvOioqICJDcmllIHVtIGFycXVpdm8gaGVsbG8uanMgY29tIGNvbnNvbGUubG9nKCdvaScpIgoKYGBganNvbgp7InRvb2wiOiAid3JpdGVGaWxlIiwgInBhcmFtcyI6IHsicGF0aCI6ICJoZWxsby5qcyIsICJjb250ZW50IjogImNvbnNvbGUubG9nKCdvaScpOyJ9fQpgYGAKCioqVXN1w6FyaW86KiogIlF1YWlzIHRvb2xzIGV1IHRlbmhvPyIKCmBgYGpzb24KeyJ0b29sIjogImxpc3RUb29scyIsICJwYXJhbXMiOiB7fX0KYGBgCgoqKlVzdcOhcmlvOioqICJDb21vIHVzYSBhIHRvb2wgZGUgc2hlbGwgbWVzbW8/IgoKYGBganNvbgp7InRvb2wiOiAidG9vbEluZm8iLCAicGFyYW1zIjogeyJuYW1lIjogImV4ZWN1dGVTaGVsbCJ9fQpgYGAKCioqVXN1w6FyaW86KiogIk1hbmRhIHVtYSBtZW5zYWdlbSBubyBXaGF0c0FwcCBwcm8gQWJuZXIgZGl6ZW5kbzogdGVzdGUgb2xhIHRlc3RhbmRvIgoKYGBganNvbgp7InRvb2wiOiAid2hhdHNhcHBTZW5kTWVzc2FnZSIsICJwYXJhbXMiOiB7InRvIjogIkFibmVyIiwgIm1lc3NhZ2UiOiAidGVzdGUgb2xhIHRlc3RhbmRvIn19CmBgYAoKKipVc3XDoXJpbzoqKiAiT2JyaWdhZG8iCgpgYGBqc29uCnsicmVzcG9uc2UiOiAiRGUgbmFkYSEg8J+MmSJ9CmBgYAoKLS0tCgojIyBJTVBPUlRBTlQKCi0gKipOw4NPIHVzZSoqIHRhZ3MgWE1MIGNvbW8gYDxsdW5hX3Rvb2xfY2FsbD5gCi0gKipOw4NPIHVzZSoqIGBbW2FjdGlvbl1dYCAvIGBbW3Jlc3BvbnNlXV1gIOKAlCBwcm90b2NvbG8gbGVnYWRvIEFCT0xJRE8gbmEgdjcuMwotICoqTsODTyBlbnZpZSBpZCoqIOKAlCBhIEx1bmEgZ2VyYSBpZGVudGlmaWNhZG9yZXMgaW50ZXJuYW1lbnRlCi0gKipOw4NPIHJlZW52aWUqKiBvIG1hc3RlciBwcm9tcHQgYXDDs3MgY2FkYSBUb29sIFJlc3VsdAotICoqVXNlIGFwZW5hcyoqIG8gZm9ybWF0byBjb2RlIGJsb2NrIGBgYGpzb24gZXNwZWNpZmljYWRvIGFjaW1hCg==', 'base64').toString('utf8');

console.log('');
if (!fs.existsSync(MD)) {
  console.log('\x1b[33m[AVISO]\x1b[0m ' + MD + ' nao existe — criando do zero');
} else {
  const atual = fs.readFileSync(MD, 'utf8');
  if (atual.includes('v7.3') && atual.includes('JSON PURO')) {
    console.log('\x1b[90m[SKIP]\x1b[0m master prompt ja esta na v7.3');
  } else {
    fs.copyFileSync(MD, MD + '.bak-' + ts);
    console.log('\x1b[32m[OK]\x1b[0m backup: LUNA_MASTER_PROMPT.md.bak-' + ts);
  }
}
if (!fs.existsSync(MD) || !fs.readFileSync(MD, 'utf8').includes('v7.3')) {
  fs.writeFileSync(MD, NOVO, 'utf8');
  const restantes = NOVO.split('[[action]]').length - 1;
  console.log('\x1b[32m[OK]\x1b[0m master prompt v7.3 gravado (' + NOVO.length + ' chars, [[action]] restantes: ' + restantes + ')');
}

// 2. caça outras copias
console.log('');
console.log('\x1b[36m=== Caçando outras copias do master prompt ===\x1b[0m');
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.next']);
let copias = 0;
function walk(dir, depth) {
  if (depth > 6) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(full, depth + 1); }
    else if (/master.?prompt/i.test(e.name) && !e.name.includes('.bak')) {
      try {
        const c = fs.readFileSync(full, 'utf8');
        if (c.includes('[[action]]') && !c.includes('v7.3')) {
          console.log('\x1b[33m  ⚠ copia contaminada: ' + full + '\x1b[0m');
          fs.copyFileSync(full, full + '.bak-' + ts);
          fs.writeFileSync(full, NOVO, 'utf8');
          console.log('\x1b[32m  [OK] substituida pela v7.3\x1b[0m');
          copias++;
        }
      } catch {}
    }
  }
}
walk(ROOT, 0);
const lh = path.join(os.homedir(), '.luna');
if (fs.existsSync(lh)) walk(lh, 0);
if (copias === 0) console.log('  (nenhuma outra copia contaminada)');

// 3. verifica master prompt EMBUTIDO no config (duplicacao)
console.log('');
console.log('\x1b[36m=== Verificando master prompt embutido nos configs ===\x1b[0m');
for (const cfgPath of [
  path.join(ROOT, 'packages', 'kernel', 'config', 'luna-prompt-config.json'),
  path.join(os.homedir(), '.luna', 'kernel', 'config', 'luna-prompt-config.json')
]) {
  try {
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    let achou = false;
    const check = (v, p) => {
      if (typeof v === 'string' && v.includes('MASTER PROMPT') && v.includes('v7.2')) {
        console.log('\x1b[33m  ⚠ ' + cfgPath + ' → campo "' + p + '" tem master prompt v7.2 EMBUTIDO (duplica o prompt inteiro!)\x1b[0m');
        achou = true;
      }
    };
    check(cfg.systemPrompt, 'systemPrompt');
    if (cfg.prompts) for (const k of Object.keys(cfg.prompts)) check(cfg.prompts[k], 'prompts.' + k);
    if (!achou) console.log('  ' + path.basename(path.dirname(path.dirname(cfgPath))) + '/config: ok (sem master prompt embutido)');
  } catch {}
}

// 4. restart
console.log('');
try {
  execSync('pm2 restart luna-kernel', { encoding: 'utf8' });
  console.log('\x1b[32m[OK]\x1b[0m luna-kernel reiniciado');
} catch { console.log('\x1b[33m⚠ pm2 restart falhou — roda manual\x1b[0m'); }

console.log('');
console.log('\x1b[32m✅ MASTER PROMPT v7.3 NO AR.\x1b[0m');
console.log('   NOVA SESSAO na Luna Web e retesta — agora o prompt inteiro ensina JSON puro,');
console.log('   com exemplos de listTools/toolInfo pra descoberta de tools.');
console.log('\x1b[90mBackups: *.bak-' + ts + '\x1b[0m');
