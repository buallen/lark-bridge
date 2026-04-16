'use strict';

// ── Environment bootstrap ─────────────────────────────────────────────────────
const fs   = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m) process.env[m[1].trim()] = m[2].trim();
  });
}

// ── Single-instance PID lock ──────────────────────────────────────────────────
const LOCK_FILE = path.join(__dirname, '..', '.bot.pid');

const existingPid = (() => {
  try {
    const pid = parseInt(fs.readFileSync(LOCK_FILE, 'utf8').trim(), 10);
    if (pid && pid !== process.pid) {
      try { process.kill(pid, 0); return pid; } catch (_) { return null; }
    }
  } catch (_) {}
  return null;
})();

if (existingPid) {
  process.stderr.write(`[startup] Another instance is already running (PID ${existingPid}). Exiting.\n`);
  process.exit(1);
}

fs.writeFileSync(LOCK_FILE, String(process.pid));
process.on('exit', () => { try { fs.unlinkSync(LOCK_FILE); } catch (_) {} });

// ── Validate required env vars ────────────────────────────────────────────────
if (!process.env.LARK_APP_ID || !process.env.LARK_APP_SECRET) {
  process.stderr.write('Missing LARK_APP_ID or LARK_APP_SECRET environment variables.\n');
  process.exit(1);
}

// ── Start HTTP server ─────────────────────────────────────────────────────────
const logger = require('./logger');
const { startHealthServer } = require('./health');

startHealthServer();

// Keep the event loop alive
setInterval(() => {}, 60_000);

// ── Graceful shutdown ─────────────────────────────────────────────────────────
process.on('SIGTERM', () => { logger.log('[shutdown] SIGTERM'); process.exit(0); });
process.on('SIGINT',  () => { logger.log('[shutdown] SIGINT');  process.exit(0); });

logger.log('lark-bridge started (send-only mode)', { port: 9090 });
