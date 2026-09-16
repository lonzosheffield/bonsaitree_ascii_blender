// Bonsai Duet — local static file server.
//
// Zero dependencies. Node's own http/fs/path only. Run with `npm start`.
//
//   http://localhost:8137/?duration=3600&speed=1&seed=0     (N6)
//
// Design notes:
//   * No caching. Agents edit files under this server constantly; a cached
//     module is a debugging tarpit. Every response is `no-store`.
//   * Range requests are supported for public/*.webm so a <video> element can
//     seek. The JPEG ladder (N4) does not need them but video does.
//   * Every path is resolved and then checked to be inside the project root,
//     so `GET /../../etc/passwd` and its encoded variants cannot escape.

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 8137;
const HOST = process.env.HOST || '127.0.0.1';

// ---------------------------------------------------------------------------
// Preflight. Everything below runs before `listen()` so a misconfigured machine
// produces one readable sentence instead of a stack trace or a half-drawn page.
// ---------------------------------------------------------------------------

/** Minimum Node major. Matches `engines.node` in package.json. */
const MIN_NODE_MAJOR = 24;

const nodeMajor = Number.parseInt(process.versions.node.split('.')[0], 10);
if (!(nodeMajor >= MIN_NODE_MAJOR)) {
  console.error(
    `[bonsai-duet] Node ${MIN_NODE_MAJOR} or newer is required; this is Node ${process.versions.node}.\n` +
    `[bonsai-duet] Install the current LTS from https://nodejs.org and run \`npm start\` again.`,
  );
  process.exit(1);
}

/**
 * The right-hand panel is a pre-rendered JPEG ladder committed to the repo
 * (~53 MB under public/frames). A shallow or partial checkout leaves the page
 * looking broken with no explanation, so say so here rather than in the console
 * of a browser the reader may never open.
 */
function preflightAssets() {
  const required = [
    ['index.html', 'the page itself'],
    [path.join('public', 'frames', 'manifest.json'), 'the 600-frame ladder manifest'],
    [path.join('public', 'frames', 'frame-0000.jpg'), 'the first rendered frame'],
    [path.join('public', 'frames', 'frame-0599.jpg'), 'the last rendered frame'],
    [path.join('public', 'skeleton-42.json'), 'the shared skeleton for seed 42'],
  ];
  const missing = required.filter(([rel]) => !fs.existsSync(path.join(ROOT, rel)));
  if (missing.length === 0) return;

  console.warn('[bonsai-duet] WARNING — some committed assets are missing from this checkout:');
  for (const [rel, what] of missing) console.warn(`[bonsai-duet]   ${rel}  (${what})`);
  console.warn('[bonsai-duet] The page will still boot, but a panel may be blank.');
  console.warn('[bonsai-duet] This usually means a partial clone. Re-clone or restore the files.');
}

preflightAssets();

const MIME = new Map(Object.entries({
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
}));

const DEFAULT_MIME = 'application/octet-stream';

function contentType(filePath) {
  return MIME.get(path.extname(filePath).toLowerCase()) || DEFAULT_MIME;
}

/**
 * Map a request URL to an absolute path inside ROOT, or null if it escapes.
 */
function resolveRequestPath(rawUrl) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(rawUrl, 'http://localhost').pathname);
  } catch {
    return null; // malformed percent-encoding
  }
  if (pathname.includes('\0')) return null;
  if (pathname.endsWith('/')) pathname += 'index.html';

  const resolved = path.resolve(ROOT, '.' + path.posix.normalize(pathname));
  const rel = path.relative(ROOT, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return resolved;
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

/** Parse a single-range `Range: bytes=a-b` header. Returns null if absent/unusable. */
function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const [, startRaw, endRaw] = m;
  let start;
  let end;
  if (startRaw === '') {
    if (endRaw === '') return null;
    const suffix = Number(endRaw);
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(startRaw);
    end = endRaw === '' ? size - 1 : Math.min(Number(endRaw), size - 1);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return null;
  return { start, end };
}

const server = http.createServer(async (req, res) => {
  const method = req.method || 'GET';
  if (method !== 'GET' && method !== 'HEAD') {
    send(res, 405, 'Method Not Allowed\n', { Allow: 'GET, HEAD' });
    return;
  }

  const filePath = resolveRequestPath(req.url || '/');
  if (!filePath) {
    send(res, 400, 'Bad Request\n');
    return;
  }

  let stat;
  try {
    stat = await fsp.stat(filePath);
    if (stat.isDirectory()) {
      const indexPath = path.join(filePath, 'index.html');
      stat = await fsp.stat(indexPath);
      return streamFile(req, res, indexPath, stat, method);
    }
  } catch {
    send(res, 404, `404 Not Found: ${req.url}\n`);
    return;
  }

  return streamFile(req, res, filePath, stat, method);
});

function streamFile(req, res, filePath, stat, method) {
  const type = contentType(filePath);
  const base = {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'Last-Modified': stat.mtime.toUTCString(),
    'Accept-Ranges': 'bytes',
  };

  const range = parseRange(req.headers.range, stat.size);
  if (range) {
    const length = range.end - range.start + 1;
    res.writeHead(206, {
      ...base,
      'Content-Range': `bytes ${range.start}-${range.end}/${stat.size}`,
      'Content-Length': length,
    });
    if (method === 'HEAD') return res.end();
    fs.createReadStream(filePath, { start: range.start, end: range.end })
      .on('error', () => res.destroy())
      .pipe(res);
    return;
  }

  res.writeHead(200, { ...base, 'Content-Length': stat.size });
  if (method === 'HEAD') return res.end();
  fs.createReadStream(filePath)
    .on('error', () => res.destroy())
    .pipe(res);
}

server.on('error', (err) => {
  // Windows surfaces an already-bound port as EACCES, not EADDRINUSE.
  if (err && (err.code === 'EADDRINUSE' || err.code === 'EACCES')) {
    console.error(`[bonsai-duet] port ${PORT} is already in use (${err.code}).`);
    console.error('[bonsai-duet] Start it on another port instead:');
    const alt = PORT + 1;
    console.error(`[bonsai-duet]   PowerShell:  $env:PORT=${alt}; npm start`);
    console.error(`[bonsai-duet]   bash/zsh:    PORT=${alt} npm start`);
    console.error(`[bonsai-duet] Then open http://localhost:${alt}/ instead of http://localhost:${PORT}/.`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  Bonsai Duet');
  console.log(`  serving  ${ROOT}`);
  console.log('');
  console.log(`  the hour     http://localhost:${PORT}/`);
  console.log(`  60s preview  http://localhost:${PORT}/?duration=3600&speed=60`);
  console.log('');
  console.log('  Ctrl+C to stop.');
  console.log('');
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
    // Do not wait forever on keep-alive sockets.
    setTimeout(() => process.exit(0), 500).unref();
  });
}
