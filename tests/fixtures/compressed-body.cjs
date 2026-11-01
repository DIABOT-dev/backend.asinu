// Isolated process, loopback ephemeral port only; no database or external service.
const http = require('node:http');
const express = require('express');
const app = express();
app.use(
  express.json({
    limit: '1mb',
    verify(req, _res, body) {
      req.rawBody = Buffer.from(body);
    },
  })
);
app.post('/', (req, res) => res.json(req.body));
app.use((err, _req, res, _next) => res.status(err.status || 500).end('rejected'));
const server = app.listen(0, '127.0.0.1', () => {
  const body = Buffer.concat([
    Buffer.from('1f8b0800000000000003ab564a54b232ac0500afac1b5607000000', 'hex'),
    Buffer.from([0]),
    Buffer.alloc(100 * 1024, 0x58),
  ]);
  const options = {
    host: '127.0.0.1',
    port: server.address().port,
    path: '/',
    method: 'POST',
    agent: false,
  };
  const first = http.request(
    {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'Content-Encoding': 'gzip',
        'Content-Length': body.length,
      },
    },
    (response) => {
      const initialStatus = response.statusCode;
      response.resume();
      response.on('end', () =>
        setTimeout(() => {
          const second = http.request(
            { ...options, headers: { 'Content-Type': 'application/json' } },
            (next) => {
              let text = '';
              next.on('data', (part) => {
                text += part;
              });
              next.on('end', () =>
                server.close(() => {
                  console.log(
                    JSON.stringify({
                      initialStatus,
                      healthyStatus: next.statusCode,
                      body: JSON.parse(text),
                    })
                  );
                  process.exit(0);
                })
              );
            }
          );
          second.on('error', () => process.exit(3));
          second.end(JSON.stringify({ healthy: true }));
        }, 150)
      );
    }
  );
  first.on('error', () => process.exit(3));
  first.end(body);
});
setTimeout(() => process.exit(2), 3000).unref();
