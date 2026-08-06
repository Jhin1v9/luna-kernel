const fs = require('fs');
const path = process.argv[2];
let content = fs.readFileSync(path, 'utf8');

const startMarker = '// 3b. WEB SEARCH';
const endMarker = '// 3c. BROWSER';

const startIdx = content.indexOf(startMarker);
const endIdx = content.indexOf(endMarker);

if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
  console.error('Markers not found');
  process.exit(1);
}

const header = content.substring(startIdx, content.indexOf('\n', startIdx) + 1);

const newBlock = header +
`function _serializeSearchResults(query, engine, results, limit) {
  const content = results.length
    ? results.slice(0, limit).map((r, i) => (i + 1) + '. ' + r.title + '\\nURL: ' + r.url + '\\n' + r.snippet).join('\\n\\n')
    : 'Nenhum resultado encontrado.';
  return { query, engine, results: results.slice(0, limit), count: results.length, content, stdout: content };
}

async function searchWeb(query, opts = {}) {
  const limit = opts.limit || 10;

  // 1. Yahoo Search via real browser (currently works with residential IP)
  try {
    const yahooUrl = 'https://search.yahoo.com/search?p=' + encodeURIComponent(query);
    const yahooResult = await browser(yahooUrl, { waitUntil: 'networkidle', timeout: 30000, limit: 50000 });
    if (yahooResult.success && yahooResult.content) {
      const results = [];
      // Parse Yahoo results: each result is in #web .dd or .algo containers
      const itemRegex = /<div[^>]*class="[^"]*(?:algo|web-res)[^"]*"[^>]*>[\\s\\S]*?<a[^>]*href="([^"]*)"[^>]*>[\\s\\S]*?<\/a>[\\s\\S]*?<\/div>/gi;
      let match;
      while ((match = itemRegex.exec(yahooResult.content)) !== null && results.length < limit) {
        const block = match[0];
        const urlMatch = block.match(/href="([^"]*)"/);
        const titleMatch = block.match(/<h3[^>]*>([\\s\\S]*?)<\/h3>/);
        const snippetMatch = block.match(/<p[^>]*class="[^"]*fc-falcon[^"]*"[^>]*>([\\s\\S]*?)<\/p>/) ||
                             block.match(/<span[^>]*class="[^"]*fc-falcon[^"]*"[^>]*>([\\s\\S]*?)<\/span>/);
        if (urlMatch && titleMatch) {
          const url = urlMatch[1].replace(/&amp;/g, '&');
          const title = titleMatch[1].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').trim();
          const snippet = snippetMatch ? snippetMatch[1].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').trim() : '';
          if (title && url && !url.includes('search.yahoo.com/search;_ylt')) {
            results.push({ title, url, snippet });
          }
        }
      }
      if (results.length) return ok(_serializeSearchResults(query, 'yahoo', results, limit));
    }
  } catch (e) {
    console.log('[LUNA] Yahoo search failed:', e.message);
  }

  // 2. DuckDuckGo scraping fallback (often blocked; kept as last resort)
  try {
    const searchUrl = 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query);
    const ddg = await new Promise((resolve, reject) => {
      const client = searchUrl.startsWith('https:') ? https : http;
      const req = client.get(searchUrl, {
        timeout: opts.timeout || 15000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
        }
      }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          let nextUrl;
          try { nextUrl = new URL(res.headers.location, searchUrl).href; } catch { return reject(new Error('Search redirect inválido')); }
          return fetchURL(nextUrl, opts).then(resolve).catch(reject);
        }
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve(data));
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Search timeout')); });
    });

    const results = [];
    const resultRegex = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\\s\\S]*?)<\\/a>[\\s\\S]*?<a[^>]*class="result__snippet"[^>]*>([\\s\\S]*?)<\\/a>/gi;
    let match;
    while ((match = resultRegex.exec(ddg)) !== null && results.length < limit) {
      const url = match[1].replace(/&amp;/g, '&');
      const title = match[2].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').trim();
      const snippet = match[3].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').trim();
      if (title && url) results.push({ title, url, snippet });
    }
    if (results.length) return ok(_serializeSearchResults(query, 'duckduckgo', results, limit));
  } catch (e) {
    console.log('[LUNA] DuckDuckGo fallback failed:', e.message);
  }

  // 3. All engines failed
  return err('Nenhum motor de busca gratuito conseguiu retornar resultados. Yahoo e DuckDuckGo estão bloqueando requisições automatizadas. Tente novamente em alguns minutos ou use fetchURL com uma URL específica.');
}

`;

content = content.substring(0, startIdx) + newBlock + content.substring(endIdx);
fs.writeFileSync(path, content);
console.log('Replaced searchWeb block with Yahoo scraping');
