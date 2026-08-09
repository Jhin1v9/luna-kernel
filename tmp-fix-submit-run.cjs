const fs = require('fs');
const file = 'packages/kernel/kimi-bridge.cjs';
let data = fs.readFileSync(file, 'utf8');

const old1 = fs.readFileSync('tmp-fix-submit-old1.txt', 'utf8');
const new1 = fs.readFileSync('tmp-fix-submit-new1.txt', 'utf8');
if (!data.includes(old1)) { console.error('old1 not found'); process.exit(1); }
data = data.replace(old1, new1);

const old2 = fs.readFileSync('tmp-fix-submit-old2.txt', 'utf8');
const new2 = fs.readFileSync('tmp-fix-submit-new2.txt', 'utf8');
if (!data.includes(old2)) { console.error('old2 not found'); process.exit(1); }
data = data.replace(old2, new2);

// Global replace of remaining normPrefix references in this function
if (data.includes('normPrefix')) {
  data = data.replace(/normPrefix/g, 'normText');
}

fs.writeFileSync(file, data, 'utf8');
console.log('submit fix applied');
