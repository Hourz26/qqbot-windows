// SnowLuma → DSH 无头模式 桥接（带上下文）
// 每个 QQ 好友对应一个持久化 Session，后续消息通过 --session-id 续接
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

const CONFIG = {
  wsUrl: 'ws://127.0.0.1:3001/?access_token=REPLACE_WITH_SNOWLUMA_WS_TOKEN',
  httpUrl: 'http://127.0.0.1:3000/',
  httpToken: 'REPLACE_WITH_SNOWLUMA_HTTP_TOKEN',
  selfUin: 3799652874,
  allowed: [3351763568],
  dshProfile: 'headless',
  // DSH 2.0.18 后稳定入口指向不存在的 app.asar 路径，这里用自建 shim（路径无空格）
  dshPath: 'C:\\Apps\\snowluma\\dsh-shim.cmd',
  workspace: 'C:\\Apps\\snowluma\\bridge-workspace',
  stateFile: 'C:\\Apps\\snowluma\\bridge-state.json',
  timeoutMs: 300000,
  sendAck: false,
  logFile: 'C:\\Apps\\snowluma\\logs\\bridge.log',
};

mkdirSync(CONFIG.workspace, { recursive: true });
mkdirSync(dirname(CONFIG.logFile), { recursive: true });

function log(...args) {
  const line = `${new Date().toISOString()}  ${args.join(' ')}`;
  console.log(line);
  try { appendFileSync(CONFIG.logFile, line + '\n', 'utf8'); } catch {}
}

// ---- 会话状态：{ "<qq>": "<sessionId>" } ----
function loadState() {
  try { return JSON.parse(readFileSync(CONFIG.stateFile, 'utf8')); } catch { return {}; }
}
function saveState(s) {
  try { writeFileSync(CONFIG.stateFile, JSON.stringify(s, null, 2), 'utf8'); } catch (e) { log('state save failed', e.message); }
}
let state = loadState();

function loadApiKey() {
  try {
    const yaml = readFileSync(`${process.env.USERPROFILE}\\.dsh\\.credentials.yaml`, 'utf8');
    const m = yaml.match(/DEEPSEEK_API_KEY:\s*(\S+)/);
    return m ? m[1] : '';
  } catch { return ''; }
}
const API_KEY = loadApiKey();
if (!API_KEY) log('WARN 未读到 DEEPSEEK_API_KEY');

async function sendPrivate(userId, text) {
  return sendSegments(userId, [{ type: 'text', data: { text } }]);
}

// 发送任意消息段（文本 / 表情 / 图片）
async function sendSegments(userId, segments) {
  const body = JSON.stringify({
    action: 'send_private_msg',
    params: { user_id: userId, message: segments },
  });
  try {
    const res = await fetch(CONFIG.httpUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${CONFIG.httpToken}` },
      body,
    });
    const json = await res.json().catch(() => ({}));
    if (json?.status !== 'ok') log('发送失败', JSON.stringify(json).slice(0, 200));
  } catch (e) { log('发送异常', e.message); }
}

// 通用 OneBot 调用
async function callAction(action, params) {
  const res = await fetch(CONFIG.httpUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${CONFIG.httpToken}` },
    body: JSON.stringify({ action, params }),
  });
  return res.json();
}

// ---- QQ 系统表情目录：id <-> 名称 ----
const faceById = new Map();
const faceByName = new Map();

async function loadFaceCatalog() {
  try {
    const j = await callAction('fetch_sys_faces', {});
    let n = 0;
    for (const pack of j?.data?.packs ?? []) {
      for (const e of pack.emojis ?? []) {
        const id = String(e.q_sid ?? '');
        const name = String(e.q_des ?? '').replace(/^\//, '').trim();
        if (!id || !name) continue;
        if (!faceById.has(id)) faceById.set(id, name);
        if (!faceByName.has(name)) faceByName.set(name, id);
        for (const a of e.emoji_name_alias ?? []) if (!faceByName.has(a)) faceByName.set(a, id);
        n++;
      }
    }
    log(`表情目录已加载: ${n} 条`);
  } catch (e) { log('表情目录加载失败', e.message); }
}

// 把回答里的 [表情:名称] 转成 face 消息段
function buildSegments(text) {
  const segs = [];
  const re = /\[表情[:：]([^\]]{1,12})\]/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    const before = text.slice(last, m.index);
    if (before) segs.push({ type: 'text', data: { text: before } });
    const key = m[1].trim();
    const id = faceById.get(key) || faceByName.get(key);
    if (id) {
      segs.push({ type: 'face', data: { id } });
      log(`发表情: ${key} -> id=${id}`);
    } else {
      segs.push({ type: 'text', data: { text: `[${key}]` } });
      log(`未知表情名: ${key}`);
    }
    last = m.index + m[0].length;
  }
  const tail = text.slice(last);
  if (tail) segs.push({ type: 'text', data: { text: tail } });
  return segs.length ? segs : [{ type: 'text', data: { text } }];
}

// 跑一次无头任务，解析 json 事件流；提示词走 stdin，避免 cmd 参数被换行截断
function runDsh(prompt, sessionId) {
  return new Promise((resolve) => {
    const args = ['--profile', CONFIG.dshProfile, '--json'];
    if (sessionId) args.push('--session-id', sessionId);
    args.push('-');

    const dsh = spawn('cmd.exe', ['/c', CONFIG.dshPath, ...args], {
      cwd: CONFIG.workspace,
      env: { ...process.env, DEEPSEEK_API_KEY: API_KEY },
      windowsHide: true,
    });

    dsh.stdin.write(prompt, 'utf8');
    dsh.stdin.end();

    let buf = '', err = '', sid = '', text = '', final = '';
    const timer = setTimeout(() => { try { dsh.kill(); } catch {} }, CONFIG.timeoutMs);

    dsh.stdout.on('data', (d) => {
      buf += d.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line.startsWith('{')) continue;
        try {
          const ev = JSON.parse(line);
          if (ev.type === 'session' && ev.sessionId) sid = ev.sessionId;
          else if (ev.type === 'text' && ev.text) text += ev.text;
          else if (ev.type === 'final' && ev.text) final = ev.text;
        } catch {}
      }
    });
    dsh.stderr.on('data', (d) => { err += d.toString('utf8'); });

    dsh.on('close', (code) => {
      clearTimeout(timer);
      const answer = (final || text).trim();
      resolve({ code, answer, sessionId: sid, stderr: err });
    });
    dsh.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, answer: '', stderr: e.message }); });
  });
}

function extractText(segments) {
  if (typeof segments === 'string') return segments;
  if (!Array.isArray(segments)) return '';
  return segments.map((s) => {
    if (s.type === 'text') return s?.data?.text ?? '';
    if (s.type === 'face') {
      const id = String(s?.data?.id ?? '');
      const name = faceById.get(id);
      // 让模型看得懂：带上名称，未知则给 id
      return name ? `[表情:${name}]` : `[表情:${id}]`;
    }
    if (s.type === 'mface') {
      const sum = s?.data?.summary || s?.data?.name || '';
      return sum ? `[表情包:${sum}]` : '[表情包]';
    }
    return '';
  }).join('').trim();
}

// 从消息段里取出图片地址
function extractImageUrls(segments) {
  if (!Array.isArray(segments)) return [];
  return segments
    .filter((s) => s.type === 'image')
    .map((s) => s?.data?.url || s?.data?.file || '')
    .filter((u) => /^https?:\/\//.test(u));
}

// 下载 QQ 图片到本地工作区，供 read_image 读取
async function downloadImages(urls, tag) {
  const dir = `${CONFIG.workspace}\\uploads`;
  mkdirSync(dir, { recursive: true });
  const saved = [];
  for (let i = 0; i < urls.length; i++) {
    try {
      const res = await fetch(urls[i], { signal: AbortSignal.timeout(30000) });
      if (!res.ok) { log('图片下载失败', res.status); continue; }
      const ct = res.headers.get('content-type') || 'image/jpeg';
      const ext = ct.includes('png') ? 'png' : ct.includes('gif') ? 'gif' : ct.includes('webp') ? 'webp' : 'jpg';
      const file = `${dir}\\${tag}-${i + 1}.${ext}`;
      const buf = Buffer.from(await res.arrayBuffer());
      writeFileSync(file, buf);
      saved.push(file);
      log(`图片已保存 ${file} (${buf.length} bytes)`);
    } catch (e) { log('图片下载异常', e.message); }
  }
  return saved;
}

// QQ 不渲染 Markdown，做一次轻量降级
function plain(text) {
  return text
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/```[a-zA-Z]*\n?/g, '').trim())
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*]\s+/gm, '· ')
    .trim();
}

// 让模型知道自己在 QQ 里、可以发图、可以发表情
const BRIDGE_HINT =
  '【QQ 桥接说明】你在 QQ 私聊里回复用户。你可以用 web_search / web_fetch 联网查资料。' +
  '需要发图片时，在回答里写 Markdown 图片语法 ![描述](https://图片直链)，桥接层会自动发送该图片；' +
  '要把本地图片（包括你收到的用户图片，路径已在消息里给出）发回给用户，同样写 ![描述](本地绝对路径)，桥接层会直接发送该文件。' +
  '需要发 QQ 表情时，在回答里写 [表情:名称]，例如 [表情:微笑]、[表情:呲牙]、[表情:偷笑]、[表情:大哭]、[表情:笑哭]、[表情:赞]、[表情:比心]、[表情:狗头]、[表情:鼓掌]、[表情:疑问]、[表情:晕]、[表情:打脸]、[表情:摸鱼]、[表情:旺柴]。' +
  '用户发来的表情会以 [表情:名称] 的形式出现在消息里。' +
  'QQ 不渲染 Markdown，所以不要用表格、加粗或标题，直接写纯文本。';

// 本地路径规范化：file:///D:/x.gif -> D:\x.gif
function normalizeLocal(p) {
  let s = String(p);
  if (/^file:/i.test(s)) {
    s = s.replace(/^file:\/\//i, '');
    try { s = decodeURIComponent(s); } catch {}
  }
  if (/^\/[A-Za-z]:/.test(s)) s = s.slice(1);
  return /^[A-Za-z]:/.test(s) ? s.replace(/\//g, '\\') : s;
}

// 从回答里提取图片：网络直链或本地文件路径
function extractImages(text) {
  const imgs = [];
  const isUrl = (u) => /^https?:\/\//i.test(u);
  const looksLocal = (u) => /^file:/i.test(u) || /^[A-Za-z]:[\\/]/.test(u) || /^\/[A-Za-z]:[\\/]/.test(u);

  let rest = text.replace(/!\[[^\]]*\]\(([^)\s]+)\)/g, (_m, target) => {
    if (isUrl(target) || looksLocal(target)) { imgs.push(target); return ''; }
    return _m;
  });

  // 裸网络图片链接
  const bare = rest.match(/https?:\/\/[^\s，。）)]+\.(?:png|jpe?g|gif|webp)(?:\?[^\s，。）)]*)?/gi) || [];
  for (const u of bare) { imgs.push(u); rest = rest.split(u).join(''); }

  // 裸本地图片路径
  const localRe = /(?:file:\/\/\/)?[A-Za-z]:[\\/][^\s，。）)"']+\.(?:png|jpe?g|gif|webp)/gi;
  for (const p of rest.match(localRe) || []) { imgs.push(p); rest = rest.split(p).join(''); }

  return { imgs: [...new Set(imgs)].slice(0, 3), rest: rest.replace(/\n{3,}/g, '\n\n').trim() };
}

let queue = Promise.resolve();
let queueLen = 0;

async function handle(userId, text, images = []) {
  const key = String(userId);

  // 重置上下文
  if (/^(\/reset|重置|新话题)$/i.test(text.trim())) {
    delete state[key];
    saveState(state);
    await sendPrivate(userId, '上下文已清空，我们重新开始。');
    return;
  }

  let imageNote = '';
  if (images.length) {
    imageNote = `\n\n用户随消息发来了 ${images.length} 张图片，本地路径：\n${images.map((p) => `- ${p}`).join('\n')}\n请先调用 read_image 逐张查看，再回答问题。`;
  }
  if (!text && !images.length) return;

  const started = Date.now();

  let sid = state[key];
  const prompt = `${BRIDGE_HINT}${imageNote}\n\n用户消息：${text || '（只有图片，没有文字）'}`;
  let res = await runDsh(prompt, sid);

  // 续接失败（id 失效）-> 放弃旧会话，重开一个
  if (sid && res.code !== 0 && !res.answer) {
    log(`resume failed for ${key} (${res.stderr.slice(0, 120)}), starting new session`);
    delete state[key];
    res = await runDsh(prompt, undefined);
  }

  if (res.sessionId) {
    state[key] = res.sessionId;
    saveState(state);
  }

  const answer = res.answer || '（这次没能生成回复）';
  log(`>> ${key} (${Math.round((Date.now() - started) / 1000)}s, sid=${state[key] || '-'}): ${answer.slice(0, 120).replace(/\n/g, ' ')}`);

  // 先发图片，再发文字
  const { imgs, rest } = extractImages(answer);
  for (const url of imgs) {
    await sendImage(userId, url);
  }
  const body = plain(rest) || (imgs.length ? '' : '（空回复）');
  if (body) await sendSegments(userId, buildSegments(body));
}

async function sendImage(userId, target) {
  const isRemote = /^https?:\/\//i.test(target);
  const file = isRemote ? target : normalizeLocal(target);

  if (!isRemote && !existsSync(file)) {
    log('本地图片不存在，跳过:', file);
    return;
  }

  try {
    const json = await callAction('send_private_msg', {
      user_id: userId,
      message: [{ type: 'image', data: { file } }],
    });
    if (json?.status !== 'ok') log('发图失败', file.slice(0, 90), JSON.stringify(json).slice(0, 120));
    else log('发图 ok', file.slice(0, 90));
  } catch (e) { log('发图异常', e.message); }
}

function enqueue(job) {
  queueLen += 1;
  queue = queue
    .then(job)
    .catch((e) => log('job error', e?.message || String(e)))
    .finally(() => { queueLen -= 1; });
  return queue;
}

function connect() {
  log('connecting snowluma ws');
  const ws = new WebSocket(CONFIG.wsUrl);
  ws.addEventListener('open', () => log('ws open'));
  ws.addEventListener('message', (ev) => {
    let e;
    try { e = JSON.parse(String(ev.data)); } catch { return; }
    if (e.post_type !== 'message' || e.message_type !== 'private') return;
    const from = Number(e.user_id);
    if (!CONFIG.allowed.includes(from)) return;
    const text = extractText(e.message);
    const urls = extractImageUrls(e.message);
    if (!text && urls.length === 0) return;
    log(`<< ${from}: ${(text || '[图片]').slice(0, 120).replace(/\n/g, ' ')}${urls.length ? ` (+${urls.length} 图)` : ''}`);
    if (queueLen > 0) sendPrivate(from, `上一条还在处理，这条已排队（前面还有 ${queueLen} 条）`);
    enqueue(async () => {
      const images = urls.length ? await downloadImages(urls, `u${from}-${Date.now()}`) : [];
      await handle(from, text, images);
    });
  });
  ws.addEventListener('close', () => { log('ws closed -> 5s'); setTimeout(connect, 5000); });
  ws.addEventListener('error', (err) => log('ws error', err?.message || ''));
}

await loadFaceCatalog();
connect();
