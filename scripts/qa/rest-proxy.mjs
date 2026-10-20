#!/usr/bin/env node
/**
 * Proxy mínimo para pruebas locales: la app habla con `<URL>/rest/v1/...` (como
 * detrás de Kong o del Caddy de services/pgrest) y el PostgREST suelto de la
 * base de pruebas atiende en la raíz. Escucha en :54391 y reenvía a :54392.
 *   node scripts/qa/rest-proxy.mjs
 */
import http from 'node:http';

const TARGET = { host: '127.0.0.1', port: Number(process.env.QA_PGRST_PORT ?? 54392) };
http
  .createServer((req, res) => {
    const path = (req.url ?? '/').replace(/^\/rest\/v1/, '') || '/';
    const up = http.request({ ...TARGET, path, method: req.method, headers: req.headers }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    up.on('error', (e) => {
      res.writeHead(502);
      res.end(String(e));
    });
    req.pipe(up);
  })
  .listen(Number(process.env.QA_PROXY_PORT ?? 54391), '127.0.0.1');
