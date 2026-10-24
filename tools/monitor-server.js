const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PORT = 8088;
const LOG = path.resolve(__dirname, '../PS5Relapse/host-stdout.log');
const HTML = path.resolve(__dirname, 'overflow-monitor.html');

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];

  if (url === '/' || url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    fs.createReadStream(HTML).pipe(res);
    return;
  }

  if (url === '/history') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    try {
      const content = fs.readFileSync(LOG, 'utf8');
      const lines = content.split('\n').filter(l => /\/beacon\/V\d+/.test(l));
      res.end(JSON.stringify(lines));
    } catch (e) {
      res.end('[]');
    }
    return;
  }

  if (url === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    res.write('retry: 2000\n\n');

    const tail = spawn('tail', ['-f', '-n', '0', LOG]);
    let buf = '';
    tail.stdout.on('data', chunk => {
      buf += chunk.toString();
      const parts = buf.split('\n');
      buf = parts.pop();
      parts.forEach(line => {
        if (/\/beacon\/V\d+/.test(line)) {
          res.write(`data: ${line}\n\n`);
        }
      });
    });

    const keepAlive = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', () => { clearInterval(keepAlive); tail.kill(); });
    return;
  }

  res.writeHead(404);
  res.end('');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  ╔══════════════════════════════════════╗`);
  console.log(`  ║   OVERFLOW MONITOR — LIVE            ║`);
  console.log(`  ║   http://localhost:${PORT}              ║`);
  console.log(`  ╚══════════════════════════════════════╝\n`);
  console.log(`  Tailing: ${LOG}\n`);
});
