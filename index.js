'use strict';

const lark = require('@larksuiteoapi/node-sdk');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// Load .env if present
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m) process.env[m[1].trim()] = m[2].trim();
  });
}

// ── Config ────────────────────────────────────────────────────────────────────
const APP_ID = process.env.LARK_APP_ID;
const APP_SECRET = process.env.LARK_APP_SECRET;
const DEFAULT_WORKDIR = process.env.WORKDIR || '/Users/kan.lu/Documents/GitHub';
const STATE_FILE = path.join(__dirname, '.state.json');

if (!APP_ID || !APP_SECRET) {
  console.error('❌ Missing LARK_APP_ID or LARK_APP_SECRET environment variables.');
  process.exit(1);
}

// Resolve node + claude cli.js from nvm (works under launchd where nvm not in PATH)
const NVM_NODE = (() => {
  const nvmBase = path.join(process.env.HOME, '.nvm', 'versions', 'node');
  try {
    const versions = fs.readdirSync(nvmBase).sort().reverse();
    for (const v of versions) {
      const p = path.join(nvmBase, v, 'bin', 'node');
      if (fs.existsSync(p)) return p;
    }
  } catch (_) {}
  return process.execPath;
})();

const CLAUDE_CLI = (() => {
  const nvmBase = path.join(process.env.HOME, '.nvm', 'versions', 'node');
  try {
    const versions = fs.readdirSync(nvmBase).sort().reverse();
    for (const v of versions) {
      const cli = path.join(nvmBase, v, 'lib', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
      if (fs.existsSync(cli)) return cli;
    }
  } catch (_) {}
  return null;
})();

const NVM_BIN = path.dirname(NVM_NODE);
const CLAUDE_SESSIONS_BASE = path.join(process.env.HOME, '.claude', 'projects');

// ── Lark clients ─────────────────────────────────────────────────────────────
const apiClient = new lark.Client({
  appId: APP_ID,
  appSecret: APP_SECRET,
  domain: lark.Domain.Lark,
  loggerLevel: lark.LoggerLevel.warn,
});

// ── Message deduplication ─────────────────────────────────────────────────────
const processedMsgIds = new Set();
const MAX_PROCESSED_IDS = 1000;

// ── Per-user state (persisted across restarts) ────────────────────────────────
// key: open_id, value: { workdir, sessionId, running }
const userState = new Map();

function loadState() {
  try {
    const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    for (const [k, v] of Object.entries(data)) {
      userState.set(k, { workdir: v.workdir || DEFAULT_WORKDIR, sessionId: v.sessionId || null, running: false });
    }
    console.log('[state] loaded', userState.size, 'users from', STATE_FILE);
  } catch (_) {}
}

function saveState() {
  try {
    const data = {};
    for (const [k, v] of userState.entries()) {
      data[k] = { workdir: v.workdir, sessionId: v.sessionId };
    }
    fs.writeFileSync(STATE_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('[state] save error:', e.message);
  }
}

function getState(openId) {
  if (!userState.has(openId)) {
    userState.set(openId, { workdir: DEFAULT_WORKDIR, sessionId: null, running: false });
  }
  return userState.get(openId);
}

loadState();

// ── Session ID helpers ────────────────────────────────────────────────────────
// Claude 会把路径中的 '/' 和 '.' 都替换成 '-'
function encodeWorkdir(dir) {
  return dir.replace(/[/.]/g, '-');
}

// 找出某次 Claude 运行后新建的 session 文件（用 birthtime 判断）
function findNewSessionId(workdir, afterMs) {
  const projectDir = path.join(CLAUDE_SESSIONS_BASE, encodeWorkdir(workdir));
  try {
    const files = fs.readdirSync(projectDir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => {
        const stat = fs.statSync(path.join(projectDir, f));
        return { name: f, btime: stat.birthtimeMs };
      })
      .filter(f => f.btime >= afterMs)
      .sort((a, b) => b.btime - a.btime);
    if (files.length > 0) return path.basename(files[0].name, '.jsonl');
  } catch (_) {}
  return null;
}

// ── Lark message helpers ──────────────────────────────────────────────────────
async function reply(chatId, text) {
  const CHUNK = 4000;
  for (let i = 0; i < text.length; i += CHUNK) {
    try {
      const res = await apiClient.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          content: JSON.stringify({ text: text.slice(i, i + CHUNK) }),
          msg_type: 'text',
        },
      });
      if (res.code !== 0) console.error('[reply error] code:', res.code, 'msg:', res.msg);
    } catch (e) {
      console.error('[reply exception]', e.message);
    }
  }
}

// ── Run Claude CLI ────────────────────────────────────────────────────────────
function runClaude(prompt, workdir, sessionId) {
  return new Promise((resolve, reject) => {
    if (!CLAUDE_CLI) return reject(new Error('claude cli.js not found'));

    const env = {
      ...process.env,
      PATH: `${NVM_BIN}:${process.env.PATH || '/usr/local/bin:/usr/bin:/bin'}`,
      HOME: process.env.HOME,
      TERM: 'xterm-256color',
      FORCE_COLOR: '0',
    };

    const args = [CLAUDE_CLI, '-p', prompt, '--dangerously-skip-permissions', '--output-format', 'text'];
    if (sessionId) args.push('--resume', sessionId);

    let stdout = '';
    let stderr = '';
    const proc = spawn(NVM_NODE, args, { cwd: workdir, env });

    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      reject(new Error('Timed out after 10 minutes'));
    }, 10 * 60 * 1000);

    proc.on('close', code => {
      clearTimeout(timer);
      const result = stdout.trim() || stderr.trim();
      if (result) resolve(result);
      else if (code === 0) resolve('✅ Done (no output)');
      else reject(new Error(`Claude exited with code ${code}\n${stderr.trim()}`));
    });

    proc.on('error', err => { clearTimeout(timer); reject(err); });
  });
}

// ── Message handler ───────────────────────────────────────────────────────────
const HELP_TEXT = `🤖 Claude Code Bot

📋 Commands:
  help        — show this help
  pwd         — show current directory & session ID
  cd <path>   — change working directory (resets context)
  new         — clear context, start a fresh conversation

💬 Conversation:
  Any other message → sent to Claude Code as a task
  Context is preserved across messages within a session
  Send "new" to start over with a clean slate

📁 Default directory: ${DEFAULT_WORKDIR}

💡 Examples:
  list all subfolders here
  cd my-project
  analyze security issues in this codebase
  new
  what files did you just change?`;

async function handleMessage(data) {
  try {
    const msg = data.message;
    const msgId = msg?.message_id;

    // 去重：跳过已处理的 message_id
    if (msgId) {
      if (processedMsgIds.has(msgId)) {
        console.log('[msg] duplicate, skip:', msgId);
        return;
      }
      processedMsgIds.add(msgId);
      if (processedMsgIds.size > MAX_PROCESSED_IDS) {
        processedMsgIds.delete(processedMsgIds.values().next().value);
      }
    }

    // 过滤超过 60 秒的旧消息（防止 WS 重连时历史消息重放）
    const msgTime = Number(msg?.create_time);
    const age = msgTime ? Date.now() - msgTime : 0;
    if (msgTime && age > 60_000) {
      console.log('[msg] skipping old message, age:', Math.round(age / 1000), 's, id:', msgId);
      return;
    }

    const openId = data.sender?.sender_id?.open_id;
    const chatId = msg?.chat_id;
    console.log('[msg] chatId:', chatId, 'openId:', openId, 'type:', msg?.message_type, 'msgId:', msgId, 'age:', Math.round(age / 1000) + 's');

    if (!chatId || !openId) return;
    if (msg.message_type !== 'text') {
      await reply(chatId, '⚠️ Only text messages are supported.');
      return;
    }

    const text = (() => {
      try { return JSON.parse(msg.content).text.trim(); }
      catch (_) { return ''; }
    })();
    if (!text) return;

    const state = getState(openId);

    // ── Built-in commands ────────────────────────────────────────────────────
    if (text === 'help') { await reply(chatId, HELP_TEXT); return; }

    if (text === 'pwd') {
      await reply(chatId, `📁 Directory: \`${state.workdir}\`\n🔗 Session: \`${state.sessionId || 'none'}\``);
      return;
    }

    if (text === 'new') {
      state.sessionId = null;
      saveState();
      await reply(chatId, '🆕 Started a new conversation. Context has been cleared.');
      return;
    }

    if (text.startsWith('cd ')) {
      const raw = text.slice(3).trim().replace(/^~/, process.env.HOME || '~');
      const newDir = path.resolve(state.workdir, raw);
      if (fs.existsSync(newDir) && fs.statSync(newDir).isDirectory()) {
        state.workdir = newDir;
        state.sessionId = null;
        saveState();
        await reply(chatId, `✅ Working directory: \`${newDir}\`\n(Context reset for new directory)`);
      } else {
        await reply(chatId, `❌ Directory not found: \`${newDir}\``);
      }
      return;
    }

    // ── Block concurrent runs ────────────────────────────────────────────────
    if (state.running) {
      await reply(chatId, '⏳ Still running previous task, please wait…');
      return;
    }

    // ── Forward to Claude ────────────────────────────────────────────────────
    state.running = true;
    const sessionLabel = state.sessionId ? '(continuing session)' : '(new session)';
    await reply(chatId, `🔄 Running in \`${state.workdir}\` ${sessionLabel}…`);

    try {
      const startMs = Date.now();
      const result = await runClaude(text, state.workdir, state.sessionId);

      // 首次运行后找到新建的 session 文件
      if (!state.sessionId) {
        const newId = findNewSessionId(state.workdir, startMs);
        if (newId) {
          state.sessionId = newId;
          console.log(`[${openId}] New session started: ${newId}`);
        }
      }
      saveState();
      await reply(chatId, result);
    } catch (err) {
      // session 过期则重试
      if (state.sessionId && err.message.includes('No conversation found')) {
        console.log(`[${openId}] Session expired, retrying fresh`);
        state.sessionId = null;
        try {
          const startMs = Date.now();
          const result = await runClaude(text, state.workdir, null);
          const newId = findNewSessionId(state.workdir, startMs);
          if (newId) state.sessionId = newId;
          saveState();
          await reply(chatId, result);
        } catch (err2) {
          await reply(chatId, `❌ Error: ${err2.message}`);
        }
      } else {
        await reply(chatId, `❌ Error: ${err.message}`);
      }
    } finally {
      state.running = false;
    }
  } catch (fatalErr) {
    console.error('[handleMessage FATAL]', fatalErr.message, fatalErr.stack);
  }
}

// ── Start WebSocket long connection ──────────────────────────────────────────
const wsClient = new lark.WSClient({
  appId: APP_ID,
  appSecret: APP_SECRET,
  domain: lark.Domain.Lark,
  loggerLevel: lark.LoggerLevel.warn,
});

wsClient.start({
  eventDispatcher: new lark.EventDispatcher({}).register({
    'im.message.receive_v1': handleMessage,
  }),
});

console.log('✅ Lark Claude Bot started');
console.log(`   Node:   ${NVM_NODE}`);
console.log(`   Claude: ${CLAUDE_CLI || 'NOT FOUND'}`);
console.log(`   Workdir: ${DEFAULT_WORKDIR}`);
