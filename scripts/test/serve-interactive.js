#!/usr/bin/env node
/**
 * Interactive Test Server
 * - Serve HTML reports tĩnh
 * - Proxy API calls tới backend (localhost:3000)
 * - Cho phép tab "Tự test" gọi API thật
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const STATIC_DIR = path.join(__dirname, 'data');
const BACKEND_PORT = 3000;
const SERVE_PORT = 5555;

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url);
  const pathname = parsed.pathname;

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // Proxy API calls to backend
  if (pathname.startsWith('/api/')) {
    const options = {
      hostname: 'localhost',
      port: BACKEND_PORT,
      path: req.url,
      method: req.method,
      headers: { ...req.headers, host: 'localhost:' + BACKEND_PORT },
    };

    const proxyReq = http.request(options, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    });

    proxyReq.on('error', (e) => {
      res.writeHead(502);
      res.end(JSON.stringify({ ok: false, error: 'Backend not reachable: ' + e.message }));
    });

    req.pipe(proxyReq);
    return;
  }

  // Serve static files
  let filePath = pathname === '/' ? '/test-flows-report.html' : decodeURIComponent(pathname);
  const fullPath = path.join(STATIC_DIR, filePath);
  const ext = path.extname(fullPath);
  const contentTypes = {
    '.html': 'text/html; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
  };

  fs.readFile(fullPath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': contentTypes[ext] || 'text/plain; charset=utf-8',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
});

server.listen(SERVE_PORT, () => {
  console.log(`Server: http://localhost:${SERVE_PORT}`);
  console.log(`API proxy: /api/* → localhost:${BACKEND_PORT}`);
  console.log('Ready for ngrok');
});
