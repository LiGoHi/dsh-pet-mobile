#!/usr/bin/env node
/**
 * 桌面宠物 → DSHA 会话 的注入助手。
 *
 * 悬浮窗 App 发 POST /pet-chat {text}，这里把它送进 DSHA 的输入框并点发送：
 *   1. /app/launch 把 DSHA 拉到前台
 *   2. /app/ui/input 把文字填进当前焦点框（WebView 里通常就是输入框）
 *   3. 看一眼 dump：按钮是「停止生成」说明正忙；「发送」就点下去
 * 走的是 DSHA 自己的 /app/* 桥，不需要 ADB/Shizuku。
 */
const http = require('node:http');
// 自己写日志文件：不依赖启动时的 stdout 重定向（被任务管道接走时会丢）
const LOG_FILE = '/tmp/helper.log';
const _log = console.log.bind(console);
const _warn = console.warn.bind(console);
function _append(prefix, args) {
  try {
    const line = prefix + args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
    require('node:fs').appendFileSync(LOG_FILE, line + '\n');
  } catch (e) {}
}
console.log = (...a) => { _append('', a); _log(...a); };
console.warn = (...a) => { _append('', a); _warn(...a); };
const fs = require('node:fs');
const path = require('node:path');

// 桌面端页面与素材（和插件里服务的是同一份目录）
const ASSETS = require('node:path').join(__dirname, '..', 'assets');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.webm': 'video/webm',
  '.json': 'application/json; charset=utf-8'
};

const PORT = 8099;
const BRIDGE = 'http://127.0.0.1:3090';
const TOKEN = fs.readFileSync('/root/.dsh/.bridge_token', 'utf8').trim();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(path, timeoutMs = 20000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(BRIDGE + path, { headers: { 'X-Token': TOKEN }, signal: ac.signal });
    return await r.text();
  } finally {
    clearTimeout(t);
  }
}

async function inject(text, dry) {
  const t0 = Date.now();
  const mark = (name, extra) => console.log('[step]', name, Date.now() - t0 + 'ms', extra || '');
  const steps = [];
  const launch = await call('/app/launch?pkg=' + encodeURIComponent('dsh.android.client'));
  steps.push(['launch', launch.slice(0, 120)]);
  mark('launch', launch.slice(0, 60));
  await sleep(900);

  // 正忙就排队等：最多等 60 秒，等这轮生成结束再投（硬点「停止生成」等于把 agent 打断）
  let waited = 0;
  let before = await call('/app/ui/dump');
  while (before.includes('停止生成') && waited < 60000) {
    await sleep(1500);
    waited += 1500;
    before = await call('/app/ui/dump');
  }
  if (waited > 0) {
    steps.push(['wait', waited + 'ms']);
    mark('waited', waited + 'ms');
  }
  if (before.includes('停止生成')) {
    return { ok: false, reason: 'busy', message: '等了 60 秒还在生成，先不投了', steps };
  }

  if (dry) {
    return { ok: true, dry: true, message: '桥可达，未输入', steps };
  }
  // 输入框没焦点：先截一张图拿 observationId，再用 dump 里「可输入」节点的中心点去点它。
  const shot = JSON.parse((await call('/app/ui/screenshot')).match(/^\{.*\}$/s)?.[0] || '{}');
  const shotInner = shot.result ? JSON.parse(shot.result) : shot;
  if (!shotInner.coordinatesAvailable || !shotInner.observationId) {
    return {
      ok: false,
      reason: 'no-coordinates',
      message: '截不到可签名的坐标（' + (shotInner.reason || 'unknown') + '）——宠物窗需要先隐藏',
      steps,
    };
  }
  const dumpForBox = await call('/app/ui/dump');
  let cx = 540, cy = 2112;
  let found = false;
  for (const line of dumpForBox.split('\\n')) {
    if (line.includes('可输入')) {
      const m = line.match(/中心=\((-?\d+),(-?\d+)\)/);
      if (m) { cx = +m[1]; cy = +m[2]; found = true; break; }
    }
  }
  steps.push(['composer', found ? `${cx},${cy}` : 'fallback']);
  mark('composer', `${cx},${cy}`);
  const tapRes = await call('/app/ui/tap?observationId=' + encodeURIComponent(shotInner.observationId) + '&x=' + cx + '&y=' + cy);
  steps.push(['focus-tap', tapRes.slice(0, 120)]);
  await sleep(400);

  const inputRes = await call('/app/ui/input?text=' + encodeURIComponent(text));
  steps.push(['input', inputRes.slice(0, 160)]);
  mark('input', inputRes.slice(0, 80));
  await sleep(350);

  const after = await call('/app/ui/dump');
  const typed = after.includes(text.replace(/\\/g, '\\\\').slice(0, 8));
  if (!typed) {
    return {
      ok: false,
      reason: 'no-focus',
      message: '文字没进输入框（可能没焦点）',
      steps,
    };
  }
  if (after.includes('停止生成')) {
    return { ok: false, reason: 'busy-after', message: '这一轮已经在跑', steps };
  }
  const sent = await call('/app/ui/tap?text=' + encodeURIComponent('发送'));
  steps.push(['send', sent.slice(0, 160)]);
  return { ok: true, message: '已送进 DSHA 对话框', steps };
}

let inbox = [];
let petWidth = 0;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const json = (code, obj) => {
    const body = JSON.stringify(obj);
    res.writeHead(code, {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'content-type',
      'access-control-allow-methods': 'GET,POST,OPTIONS'
    });
    res.end(body);
  };
  if (req.method === 'OPTIONS') { res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'content-type',
      'access-control-allow-methods': 'GET,POST,OPTIONS' }); res.end(); return; }
  if (url.pathname === '/applog') {
    console.log('[app]', (url.searchParams.get('e') || '').slice(0, 240));
    return json(200, { ok: true });
  }
  if (url.pathname === '/report') {
    console.log('[page-report]', (url.searchParams.get('d') || '').slice(0, 300));
    return json(200, { ok: true });
  }
  // 页面端轮询的收件箱：桌面宠物投递，页面自己取走并打进输入框
  if (url.pathname === '/inbox') {
    if (req.method === 'POST') {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        try {
          const { text } = JSON.parse(raw || '{}');
          if (!text || !String(text).trim()) return json(200, { ok: false, reason: 'empty' });
          inbox.push({ text: String(text).trim(), at: Date.now() });
          if (inbox.length > 8) inbox = inbox.slice(-8);
          console.log('[inbox] queued', String(text).slice(0, 40), 'depth', inbox.length);
          json(200, { ok: true, depth: inbox.length });
        } catch (e) { json(400, { ok: false, reason: 'bad-json' }); }
      });
      return;
    }
    const item = inbox.shift();
    return json(200, { ok: true, item: item || null, depth: inbox.length });
  }
  if (url.pathname === '/health') return json(200, { ok: true });
  // 页面里宠物的实际渲染宽度（设备像素），桌面端据此对齐大小
  if (url.pathname === '/pet-size') {
    const w = parseInt(url.searchParams.get('w') || '0', 10);
    if (w > 20) petWidth = w;
    console.log('[pet-size]', req.method, url.search || '(none)', '->', petWidth);
    return json(200, { ok: true, w: petWidth });
  }
  // 静态：/pet-desktop/*
  if (url.pathname.startsWith('/pet-desktop')) {
    let rel = decodeURIComponent(url.pathname.slice('/pet-desktop'.length));
    if (!rel || rel === '/') rel = '/pet.html';
    const file = path.normalize(path.join(ASSETS, rel));
    if (!file.startsWith(ASSETS)) { res.writeHead(403); res.end('forbidden'); return; }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); res.end('not found'); return; }
      res.writeHead(200, {
        'content-type': MIME[path.extname(file)] || 'application/octet-stream',
        'content-length': data.length,
        'cache-control': 'no-cache',
        'access-control-allow-origin': '*'
      });
      res.end(data);
    });
    return;
  }
  if (url.pathname === '/pet-chat' && req.method === 'POST') {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', async () => {
      try {
        const parsed = JSON.parse(raw || '{}');
        const text = parsed.text;
        const dry = parsed.dry === true;
        if (!text || !String(text).trim()) return json(200, { ok: false, reason: 'empty' });
        const out = await inject(String(text).trim(), dry);
        console.log('[pet-chat]', JSON.stringify({ text: String(text).slice(0, 40), ...out }).slice(0, 400));
        json(200, out);
      } catch (e) {
        json(500, { ok: false, reason: 'error', message: String(e) });
      }
    });
    return;
  }
  json(404, { ok: false, reason: 'not-found' });
});
server.on('error', (e) => {
  if (e && e.code === 'EADDRINUSE') {
    console.log('[dsha-chat-helper] 8099 已在运行，本次退出');
    process.exit(0);
  }
  console.error('[dsha-chat-helper] error', e);
  process.exit(1);
});
server.listen(PORT, '127.0.0.1', () => console.log('[dsha-chat-helper] listening on ' + PORT));
