/**
 * Servidor estático mínimo para la sala de pruebas.
 *
 * Sin dependencias: sirve el repositorio completo para que el navegador pueda
 * importar `src/core/*` como módulos ES tal cual, sin paso de compilación.
 *
 *   node dev/serve.mjs [puerto]
 */

import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { isPublicAssetPath } from '../src/main/internalAssets.js';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PORT = Number(process.argv[2] || process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

function safePath(urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const normalized = normalize(decoded).replace(/^(\.\.[/\\])+/, '');
  const full = join(ROOT, normalized);
  if (!full.startsWith(ROOT + sep) && full !== ROOT) return null;
  return full;
}

const server = createServer(async (req, res) => {
  try {
    let pathname = new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname;
    if (pathname === '/' || pathname === '') {
      res.writeHead(302, { Location: process.argv.includes('--browser') ? '/browser/' : '/demo/' });
      res.end();
      return;
    }

    if (pathname === '/browser/' || pathname === '/browser') {
      let html = await readFile(join(ROOT, 'src/ui/shell/index.html'), 'utf8');
      html = html.replace('href="./styles.css"', 'href="/src/ui/shell/styles.css"')
        .replace('<script type="module" src="./app.js"></script>', '<script type="module" src="/dev/preview.js"></script><script type="module" src="/src/ui/shell/app.js"></script>');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      res.end(html); return;
    }
    let file = safePath(pathname);
    if (!file) {
      res.writeHead(403).end('Prohibido');
      return;
    }

    const resource = file.slice(ROOT.length + 1).split(sep).join('/');
    if (resource !== 'dev/preview.js' && !isPublicAssetPath(resource.endsWith('/') ? resource + 'index.html' : extname(resource) ? resource : resource + '/index.html')) {
      res.writeHead(404).end('No encontrado'); return;
    }
    let info = await stat(file).catch(() => null);
    if (info?.isDirectory()) {
      file = join(file, 'index.html');
      info = await stat(file).catch(() => null);
    }
    if (!info?.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('No encontrado');
      return;
    }

    res.writeHead(200, {
      'content-type': MIME[extname(file)] || 'application/octet-stream',
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff',
    });
    createReadStream(file).pipe(res);
  } catch (error) {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }).end(`Error: ${error.message}`);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Sala de pruebas de Nexo → http://localhost:${PORT}/demo/  (bind ${HOST}:${PORT})`);
});
