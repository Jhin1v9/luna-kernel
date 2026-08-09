const fs = require('fs');
const file = 'packages/kernel/kimi-bridge.cjs';
let data = fs.readFileSync(file, 'utf8');

// 1. Replace definition of prefix/normPrefix
const oldDef = `    const prefix = (text || '').slice(0, 100);
    // Whitespace-normalized comparison: contenteditable innerText can render
    // whitespace differently from the inserted string (collapsed runs, NBSP).
    const normPrefix = prefix.replace(/\\s+/g, ' ').trim();
    const readInput = async () => {
      if (!normPrefix) return '';`;

const newDef = `    // v2.6.8-fix: use the whitespace-normalized message (preferring the tail)
    // as the verification signature. A shared prefix between the previous and
    // new message used to fool the bridge into thinking the new text was already
    // in the input, causing the previous message to be re-sent.
    const signature = (text || '').replace(/\\s+/g, ' ').trim();
    const normText = signature.length > 300 ? signature.slice(-300) : signature;
    const readInput = async () => {
      if (!normText) return '';`;

if (!data.includes(oldDef)) {
  console.error('oldDef not found');
  process.exit(1);
}
data = data.replace(oldDef, newDef);

// 2. Add explicit pre-submit clear before baseline
const oldBaseline = `    // Pre-submit baseline. Only CHANGES relative to this state confirm the
    // submit — a stop button left over from a previous turn or a send button
    // disabled on an empty input must not count as success.
    const baseline = await readState() || { assistants: 0, sendDisabled: false, generating: false };
    // Sticky: true once the box is OBSERVED holding the typed text. An input
    // clear only proves the send if the text was there before — otherwise a
    // silent fill failure would look exactly like a successful submit.
    let inputHeldPrefix = normPrefix ? (await readInput()).includes(normPrefix) : false;`;

const newBaseline = `    // v2.6.8-fix: hard-clear the input before taking a baseline. This prevents
    // a stale previous message from being mistaken for the new text when the two
    // happen to share a prefix.
    try {
      await this._fillContentEditable(inputLocator, '');
      const afterClear = await readInput();
      if (afterClear) {
        log.warn(\`[_submitWithVerification] input still contains text after clear: \${afterClear.slice(0, 80)}\`);
      }
    } catch (clearErr) {
      log.warn(\`[_submitWithVerification] pre-submit clear failed: \${clearErr.message}\`);
    }

    // Pre-submit baseline. Only CHANGES relative to this state confirm the
    // submit — a stop button left over from a previous turn or a send button
    // disabled on an empty input must not count as success.
    const baseline = await readState() || { assistants: 0, sendDisabled: false, generating: false };
    // Sticky: true once the box is OBSERVED holding the typed text. An input
    // clear only proves the send if the text was there before — otherwise a
    // silent fill failure would look exactly like a successful submit.
    let inputHeldPrefix = normText ? (await readInput()).includes(normText) : false;`;

if (!data.includes(oldBaseline)) {
  console.error('oldBaseline not found');
  process.exit(1);
}
data = data.replace(oldBaseline, newBaseline);

// 3. Replace remaining normPrefix references in this function
if (data.includes('normPrefix')) {
  // We need to be careful to only replace inside _submitWithVerification.
  // Since normPrefix only exists there, a global replace is safe.
  data = data.replace(/normPrefix/g, 'normText');
}

fs.writeFileSync(file, data, 'utf8');
console.log('submit fix applied');
