const sessionId = process.argv[2] || 'web-msd1khx8-hslh';
const message = process.argv[3] || 'oi luna';

async function main() {
  const postRes = await fetch(`http://localhost:3458/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, sessionId, mode: 'instant', provider: 'kimi' })
  });
  const postData = await postRes.json();
  console.log('POST response:', JSON.stringify(postData));

  const res = await fetch(`http://localhost:3458/api/chat/stream?sessionId=${encodeURIComponent(sessionId)}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let received = 0;
  const start = Date.now();

  const timer = setTimeout(() => {
    console.log(`Timeout: received ${received} events`);
    reader.cancel();
    process.exit(0);
  }, 120000);

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('data:')) {
        const data = trimmed.slice(5).trim();
        if (!data) continue;
        received++;
        try {
          const ev = JSON.parse(data);
          const age = Date.now() - start;
          console.log(`[${age}ms] ${ev.type}${ev.text ? ' text=' + ev.text.slice(0, 80).replace(/\n/g, ' ') : ''}${ev.fullText ? ' fullText=' + ev.fullText.slice(0, 80).replace(/\n/g, ' ') : ''}${ev.messageId ? ' msgId=' + ev.messageId : ''}${ev.id ? ' id=' + ev.id : ''}`);
          if (ev.type === 'done' || ev.type === 'error') {
            clearTimeout(timer);
            setTimeout(() => process.exit(0), 500);
          }
        } catch (err) {
          console.log('parse error:', data);
        }
      }
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
