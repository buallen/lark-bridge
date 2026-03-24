'use strict';

const lark = require('@larksuiteoapi/node-sdk');
const { spawn } = require('child_process');
const https = require('https');
const os = require('os');
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

// ── Lark tenant token (for media download) ────────────────────────────────────
let _tenantToken = null;
let _tenantTokenExp = 0;

async function getTenantToken() {
  if (_tenantToken && Date.now() < _tenantTokenExp) return _tenantToken;
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET });
    const req = https.request({
      hostname: 'open.larksuite.com',
      path: '/open-apis/auth/v3/tenant_access_token/internal',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          _tenantToken = j.tenant_access_token;
          _tenantTokenExp = Date.now() + (j.expire - 300) * 1000;
          resolve(_tenantToken);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// 从 Lark 下载图片，保存到临时文件，返回文件路径
async function downloadLarkImage(messageId, imageKey) {
  const token = await getTenantToken();
  return new Promise((resolve, reject) => {
    https.get({
      hostname: 'open.larksuite.com',
      path: `/open-apis/im/v1/messages/${messageId}/resources/${imageKey}?type=image`,
      headers: { Authorization: `Bearer ${token}` },
    }, (res) => {
      if (res.statusCode !== 200) return reject(new Error(`Lark image HTTP ${res.statusCode}`));
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const ct = (res.headers['content-type'] || 'image/jpeg').split(';')[0].trim();
        const ext = ct.includes('png') ? 'png' : ct.includes('gif') ? 'gif' : ct.includes('webp') ? 'webp' : 'jpg';
        const tmpPath = path.join(os.tmpdir(), `lark_img_${Date.now()}.${ext}`);
        fs.writeFileSync(tmpPath, buf);
        resolve(tmpPath);
      });
    }).on('error', reject);
  });
}

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
// Lark card 的 markdown 元素（tag: "markdown"）支持：
//   加粗/斜体/删除线/链接/无序列表/有序列表/分割线(---)/代码块(```)
// 不支持：# 标题、> 引用块 → 仅这两项需要预处理

function preprocessForLarkMarkdown(md) {
  return md.split('\n').map(line => {
    // 标题 → 加粗
    const hm = line.match(/^#{1,3}\s+(.+)/);
    if (hm) return `**${hm[1]}**`;
    // 引用块 → 加粗竖线 + 斜体内容
    const bqm = line.match(/^>+\s*(.*)/);
    if (bqm) return bqm[1] ? `**│** *${bqm[1]}*` : '**│**';
    return line;
  }).join('\n');
}

// 发送新 interactive card 消息
async function reply(chatId, markdown) {
  try {
    const res = await apiClient.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        content: makeCardContent(markdown),
        msg_type: 'interactive',
      },
    });
    if (res.code !== 0) console.error('[reply error] code:', res.code, 'msg:', res.msg, JSON.stringify(res).slice(0, 300));
  } catch (e) {
    console.error('[reply exception]', e.message, e.response?.data ? JSON.stringify(e.response.data).slice(0, 300) : '');
  }
}

// ── Run Claude CLI ────────────────────────────────────────────────────────────
function runClaude(prompt, workdir, sessionId, onProgress = null) {
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
    // stdio: ['ignore', 'pipe', 'pipe'] — 将 stdin 重定向到 /dev/null，避免 3 秒等待
    const proc = spawn(NVM_NODE, args, { cwd: workdir, env, stdio: ['ignore', 'pipe', 'pipe'] });

    proc.stdout.on('data', d => {
      const chunk = d.toString();
      stdout += chunk;
      if (onProgress) onProgress(stdout); // 传入完整已输出文本
    });
    proc.stderr.on('data', d => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      reject(new Error('Timed out after 10 minutes'));
    }, 10 * 60 * 1000);

    proc.on('close', code => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout.trim() || '✅ Done (no output)');
      } else {
        // 非 0 退出码一律 reject，触发上层错误处理（如 session 过期重试）
        reject(new Error(stderr.trim() || stdout.trim() || `Claude exited with code ${code}`));
      }
    });

    proc.on('error', err => { clearTimeout(timer); reject(err); });
  });
}

// 将 markdown 内容打包成 interactive card JSON 字符串
function makeCardContent(markdownText) {
  const processed = preprocessForLarkMarkdown(markdownText);
  const lines = processed.split('\n');
  const elements = [];
  let cur = [], curLen = 0;
  for (const line of lines) {
    if (curLen + line.length + 1 > 3000 && cur.length > 0) {
      elements.push({ tag: 'markdown', content: cur.join('\n') });
      cur = []; curLen = 0;
    }
    cur.push(line);
    curLen += line.length + 1;
  }
  if (cur.length > 0) elements.push({ tag: 'markdown', content: cur.join('\n') });
  return JSON.stringify({ config: { wide_screen_mode: true }, elements });
}

// 发送普通文本消息，返回 message_id
async function sendTextMsg(chatId, text) {
  try {
    const res = await apiClient.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: chatId, content: JSON.stringify({ text }), msg_type: 'text' },
    });
    return res.data?.message_id || null;
  } catch (e) {
    console.error('[sendText exception]', e.message);
    return null;
  }
}

// 删除消息
async function deleteMsg(messageId) {
  try { await apiClient.im.message.delete({ path: { message_id: messageId } }); } catch (_) {}
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

    // ── 解析消息内容（文本 / 图片 / 富文本）────────────────────────────────────
    let text = '';
    const tmpFiles = []; // 临时图片文件，用完后删除
    const msgType = msg.message_type;

    if (msgType === 'text') {
      try { text = JSON.parse(msg.content).text.trim(); } catch (_) {}
      if (!text) return;

    } else if (msgType === 'image') {
      // 单张图片消息
      let imageKey;
      try { imageKey = JSON.parse(msg.content).image_key; } catch (_) {}
      if (!imageKey) { await reply(chatId, '⚠️ 无法解析图片。'); return; }
      try {
        const imgPath = await downloadLarkImage(msgId, imageKey);
        tmpFiles.push(imgPath);
        text = `请分析这张图片（文件已保存到本地）: ${imgPath}`;
      } catch (e) {
        await reply(chatId, `❌ 图片下载失败: ${e.message}`);
        return;
      }

    } else if (msgType === 'post') {
      // 富文本（可能包含文字 + 多张图片）
      let postContent;
      try { postContent = JSON.parse(msg.content); } catch (_) {}
      if (!postContent) { await reply(chatId, '⚠️ 无法解析富文本。'); return; }
      const lang = postContent.zh_cn || postContent.en_us || Object.values(postContent)[0];
      const textParts = [];
      if (lang?.title) textParts.push(lang.title);
      for (const line of (lang?.content || [])) {
        for (const el of line) {
          if (el.tag === 'text' && el.text) textParts.push(el.text);
          else if (el.tag === 'at' && el.user_name) textParts.push(`@${el.user_name}`);
          else if (el.tag === 'img' && el.image_key) {
            try {
              const imgPath = await downloadLarkImage(msgId, el.image_key);
              tmpFiles.push(imgPath);
              textParts.push(`[图片已保存: ${imgPath}]`);
            } catch (e) {
              textParts.push(`[图片下载失败: ${e.message}]`);
            }
          }
        }
      }
      text = textParts.join('\n').trim();
      if (!text) {
        // post 内容为空（可能是纯 @mention 或系统通知），用原始 JSON 兜底
        console.log('[msg] post content empty, raw:', msg.content?.slice(0, 300));
        text = `[富文本消息（原始内容）]\n${msg.content?.slice(0, 1000) || ''}`;
      }

    } else if (msgType === 'merge_forward') {
      // 转发的聊天记录
      let content;
      try { content = JSON.parse(msg.content); } catch (_) {}
      const msgList = content?.merge_forward_content?.message_list || [];
      if (msgList.length === 0) { await reply(chatId, '⚠️ 无法解析转发记录。'); return; }
      const lines = [`[转发的聊天记录，共 ${msgList.length} 条]`];
      for (const m of msgList) {
        const from = m.from_name || m.from || '未知';
        const ts = m.create_time ? new Date(Number(m.create_time) * 1000).toLocaleString('zh-CN') : '';
        let body = '';
        try {
          const c = JSON.parse(m.message?.content || '{}');
          if (c.text) body = c.text;
          else if (c.image_key) body = '[图片]';
          else body = m.message?.content?.slice(0, 200) || '';
        } catch (_) { body = m.message?.content?.slice(0, 200) || ''; }
        lines.push(`${from}${ts ? ` (${ts})` : ''}: ${body}`);
      }
      text = lines.join('\n');

    } else if (msgType === 'interactive') {
      // 互动卡片（含 Lark Task 任务、投票等）
      let card;
      try { card = JSON.parse(msg.content); } catch (_) {}
      const parts = [];
      // 提取标题
      const title = card?.header?.title?.content || card?.header?.title?.text
        || card?.card?.header?.title?.content || '';
      if (title) parts.push(`标题: ${title}`);
      // 递归提取文本节点
      const extractText = (el) => {
        if (!el || typeof el === 'string') return el || '';
        if (el.content) return el.content;
        if (el.text) return typeof el.text === 'string' ? el.text : (el.text?.content || '');
        if (Array.isArray(el.elements)) return el.elements.map(extractText).filter(Boolean).join(' ');
        if (Array.isArray(el.fields)) return el.fields.map(f => extractText(f.text)).filter(Boolean).join(', ');
        return '';
      };
      const elements = card?.elements || card?.body?.elements || card?.card?.elements || [];
      for (const el of elements) {
        const t = extractText(el).trim();
        if (t) parts.push(t);
      }
      text = parts.length > 0
        ? `[Lark 卡片消息]\n${parts.join('\n')}`
        : `[Lark 卡片消息（原始 JSON）]\n${JSON.stringify(card).slice(0, 1000)}`;

    } else if (msgType === 'file' || msgType === 'audio') {
      // 文件/音频：提示不支持，但告知文件信息
      let info = '';
      try { const c = JSON.parse(msg.content); info = c.file_name || c.file_key || ''; } catch (_) {}
      await reply(chatId, `⚠️ 暂不支持 ${msgType} 消息${info ? `（${info}）` : ''}，请发送文字或图片。`);
      return;

    } else if (msgType === 'video') {
      await reply(chatId, '⚠️ 暂不支持视频消息，请截图后发送图片。');
      return;

    } else {
      // 未知类型：记录原始内容，方便调试
      console.log('[msg] unknown type:', msgType, 'content:', msg.content?.slice(0, 300));
      await reply(chatId, `⚠️ 暂不支持的消息类型: ${msgType}`);
      return;
    }

    // 临时文件 5 分钟后自动清理
    if (tmpFiles.length > 0) {
      setTimeout(() => { tmpFiles.forEach(f => { try { fs.unlinkSync(f); } catch (_) {} }); }, 5 * 60 * 1000);
    }

    // Thread 话题：在 prompt 前加上话题标识，帮助 Claude 理解上下文
    if (msg.thread_id && msg.parent_id) {
      text = `[话题回复 thread_id=${msg.thread_id}]\n${text}`;
    }

    const state = getState(openId);
    console.log('[claude] prompt preview:', text.slice(0, 120).replace(/\n/g, '↵'));

    // ── Built-in commands ────────────────────────────────────────────────────
    if (text === 'help') { await reply(chatId, HELP_TEXT); return; }

    if (text === 'test') {
      await reply(chatId, `# 标题 H1
## 标题 H2

普通文本，**加粗**，*斜体*，~~删除线~~，\`内联代码\`

> 这是引用块
> 多行引用

- 无序列表项 1
- 无序列表项 2
  - 嵌套项

1. 有序列表 1
2. 有序列表 2

[点击链接](https://www.google.com)

\`\`\`javascript
const hello = "world";
console.log(hello);
\`\`\`

---

表格（如果支持）:
| 列1 | 列2 |
|-----|-----|
| A   | B   |`);
      return;
    }

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

    // 在用户 prompt 前注入格式说明，使输出适配 Lark 消息渲染
    const LARK_FORMAT_HINT = `[系统提示：你的回复将展示在 Lark 消息中，请遵守以下格式规则：
- 不要使用 # 标题语法，改用 emoji + **加粗** 作为章节标题（如 🔍 **问题分析**）
- 代码块正常使用 \`\`\`lang，Lark 支持
- 列表、加粗、斜体、链接正常使用
- 不要输出过长的纯文字段落，适当分段
以下是用户的请求：]\n`;

    // 流式模拟：每 4s 发一条新进度消息（新消息会推送到客户端），完成后删除所有进度消息
    const progressMsgIds = [];
    const startMs = Date.now();
    let lastProgressTime = 0;
    let lastProgressLen = 0;

    const onProgress = (fullText) => {
      const now = Date.now();
      if (now - lastProgressTime < 4000) return;
      if (fullText.length === lastProgressLen) return; // 没有新内容
      lastProgressTime = now;
      lastProgressLen = fullText.length;
      const elapsed = Math.round((now - startMs) / 1000);
      const preview = fullText.length > 800 ? '…' + fullText.slice(-800) : fullText;
      sendTextMsg(chatId, `⏳ 生成中 (${elapsed}s)…\n\n${preview} ▌`).then(id => {
        if (id) progressMsgIds.push(id);
      }).catch(() => {});
    };

    const runWithStreaming = async (prompt, sessionId) => {
      const result = await runClaude(prompt, state.workdir, sessionId, onProgress);
      if (!state.sessionId) {
        const newId = findNewSessionId(state.workdir, startMs);
        if (newId) { state.sessionId = newId; console.log(`[${openId}] New session: ${newId}`); }
      }
      return result;
    };

    // 发起始占位（让用户知道开始运行了）
    const placeholderMsgId = await sendTextMsg(chatId, `⏳ 生成中…`);
    if (placeholderMsgId) progressMsgIds.push(placeholderMsgId);

    const cleanup = async () => {
      for (const id of progressMsgIds) await deleteMsg(id);
    };

    try {
      const result = await runWithStreaming(LARK_FORMAT_HINT + text, state.sessionId);
      saveState();
      await cleanup();
      await reply(chatId, result);
    } catch (err) {
      if (state.sessionId && err.message.includes('No conversation found')) {
        console.log(`[${openId}] Session expired, retrying fresh`);
        state.sessionId = null;
        try {
          const result = await runWithStreaming(LARK_FORMAT_HINT + text, null);
          saveState();
          await cleanup();
          await reply(chatId, result);
        } catch (err2) {
          await cleanup();
          await reply(chatId, `❌ Error: ${err2.message}`);
        }
      } else {
        await cleanup();
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
