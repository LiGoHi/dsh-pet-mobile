/**
 * 把桌面端需要的四处改动，幂等地打进已安装的 dsh-pet 客户端 bundle。
 *
 * 为什么要这个脚本：这些改动必须活在 dsh-pet 的页面代码里（跟着它的 switchTo / 状态轮询走），
 * 而 `dsh-pet` 一旦升级，`lib/client.js` 会被整份覆盖、我们的改动就没了。
 * 所以 dsh-pet-desktop 插件每次启动都会跑一遍本脚本——打过了就跳过，没打过（或升级过）就重打。
 *
 * 原则：
 *   · 只做**字符串锚点替换**，不依赖行号；
 *   · 每个补丁有独立 marker，已存在就跳过；
 *   · 任一锚点找不到（上游改写法）只记警告、继续打其余的，绝不把 bundle 写坏；
 *   · 写盘前先备份 client.js → client.js.dsh-pet-desktop.bak（只备份一次）；
 *   · 打完做一次 `node --check` 式语法校验（vm.compileFunction 不引依赖），不合格就回滚。
 */
import { existsSync, readFileSync, writeFileSync, copyFileSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const DEFAULT_CLIENT = process.env.DSH_PET_CLIENT || '/root/.dsh/profiles/web/node_modules/dsh-pet/lib/client.js'


const PATCHES = [
  {
    name: 'sendChat 重试 + 网络中断按"已送出"处理',
    marker: '补丁：浏览器里复用到的 keep-alive 连接',
    apply(s) {
      const from = `async function sendChat(baseUrl, text) {
\tconst res = await fetch(baseUrl, {
\t\tmethod: "POST",
\t\theaders: { "content-type": "application/json" },
\t\tbody: JSON.stringify({ text }),
\t\tsignal: AbortSignal.timeout(SEND_TIMEOUT_MS)
\t});
\tconst raw = await res.json().catch(() => null);`
      const to = `async function sendChat(baseUrl, text) {
\t// 补丁：浏览器里复用到的 keep-alive 连接可能已被服务端关掉（表现为 TypeError: Failed to fetch）。
\t// 对话是 POST、不可幂等，浏览器不会自动重试，所以这里自己重试一次（换一条新连接）。
\tlet res;
\tfor (let attempt = 0; ; attempt++) {
\t\ttry {
\t\t\tres = await fetch(baseUrl, {
\t\t\t\tmethod: "POST",
\t\t\t\theaders: { "content-type": "application/json" },
\t\t\t\tbody: JSON.stringify({ text }),
\t\t\t\tsignal: AbortSignal.timeout(SEND_TIMEOUT_MS)
\t\t\t});
\t\t\tbreak;
\t\t} catch (e) {
\t\t\tconst aborted = e && e.name === "TimeoutError";
\t\t\tif (attempt >= 1 || aborted) {
\t\t\t\tif (e && e.message === "Failed to fetch") return { ok: true, pending: true };
\t\t\t\tthrow e;
\t\t\t}
\t\t\tawait new Promise((r) => setTimeout(r, 300));
\t\t}
\t}
\tconst raw = await res.json().catch(() => null);`
      return s.includes(from) ? s.replace(from, to) : null
    },
  },
  {
    name: '本地自播动画外播（桌面端才能跟着播）',
    marker: 'const publishLocalAnim = (name) => {',
    apply(s) {
      const anchor = '\t\tconst switchTo = (next, nextOnce, cuePlaybackId) => {'
      if (!s.includes(anchor)) return null
      const hook = `\t\t/**
\t\t * 本地动画外播（dsh-pet-desktop 补丁）：随机链/点击/碎碎念/余额这些自播动画原本只活在页面里，
\t\t * 桌面悬浮窗因此看不到。这里把它们当成"点播"回写给宿主，写进 pets.<id>.anim，
\t\t * 所有 /state 消费端都能跟着播；自己消费回来时按 playbackId / 同名时间窗丢掉，不成环。
\t\t */
\t\tconst publishLocalAnim = (name) => {
\t\t\ttry {
\t\t\t\tconst now = Date.now();
\t\t\t\tif (now - (window.__petPubAt || 0) < 1200) return;
\t\t\t\twindow.__petPubAt = now;
\t\t\t\twindow.__petPubName = name;
\t\t\t\tvar facing = (function () {
\t\t\t\t\ttry {
\t\t\t\t\t\tvar vids = document.querySelectorAll('video');
\t\t\t\t\t\tfor (var i = 0; i < vids.length; i++) {
\t\t\t\t\t\t\tvar cs = getComputedStyle(vids[i]);
\t\t\t\t\t\t\tif (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') continue;
\t\t\t\t\t\t\tvar m = /matrix\\((-?[\\d.]+),/.exec(cs.transform || '');
\t\t\t\t\t\t\tif (m) return parseFloat(m[1]) < 0 ? 'right' : 'left';
\t\t\t\t\t\t\treturn 'left';
\t\t\t\t\t\t}
\t\t\t\t\t} catch (e) {}
\t\t\t\t\treturn null;
\t\t\t\t})();
\t\t\t\tfetch("/dsh-pet-7340/anim?pet=" + encodeURIComponent(cfg.id) + "&surface=web", {
\t\t\t\t\tmethod: "POST",
\t\t\t\t\theaders: { "content-type": "application/json" },
\t\t\t\t\tbody: JSON.stringify(facing ? { name: name, facing: facing } : { name: name })
\t\t\t\t}).then((r) => r.json()).then((j) => {
\t\t\t\t\tif (j && j.playbackId) {
\t\t\t\t\t\twindow.__petSelf = window.__petSelf || new Set();
\t\t\t\t\t\twindow.__petSelf.add(j.playbackId);
\t\t\t\t\t\tif (window.__petSelf.size > 80) {
\t\t\t\t\t\t\tvar it = window.__petSelf.values().next();
\t\t\t\t\t\t\twindow.__petSelf.delete(it.value);
\t\t\t\t\t\t}
\t\t\t\t\t}
\t\t\t\t}).catch(() => {});
\t\t\t} catch (e) {}
\t\t};
` + anchor
      let out = s.replace(anchor, hook)
      // switchTo 开头调用
      out = out.replace('\t\tconst switchTo = (next, nextOnce, cuePlaybackId) => {\n\t\t\tif (cuePlaybackId !== null) setCuePlayback(null);',
        '\t\tconst switchTo = (next, nextOnce, cuePlaybackId) => {\n\t\t\tif (nextOnce && cuePlaybackId === null && typeof next === "string") publishLocalAnim(next);\n\t\t\tif (cuePlaybackId !== null) setCuePlayback(null);')
      // 消费回自己那条时跳过
      out = out.replace(`\t\t\tif (!animCue || animCue.seq === prevAnimSeqRef.current) return;
\t\t\tprevAnimSeqRef.current = animCue.seq;`,
        `\t\t\tif (!animCue || animCue.seq === prevAnimSeqRef.current) return;
\t\t\tprevAnimSeqRef.current = animCue.seq;
\t\t\tif (animCue.playbackId && window.__petSelf && window.__petSelf.has(animCue.playbackId)) {
\t\t\t\twindow.__petSelf.delete(animCue.playbackId);
\t\t\t\treturn;
\t\t\t}
\t\t\tif (animCue.name && animCue.name === window.__petPubName
\t\t\t\t&& Date.now() - (window.__petPubAt || 0) < 2500) {
\t\t\t\treturn;
\t\t\t}`)
      return out === s ? null : out
    },
  },
]

const TAIL = `
// ---- dsh-pet-desktop：页面端附加脚本（自播外播兜底 / 收件箱 / 显示位置 / 尺寸）----
;(function () {
  if (window.__petDesktopExt) return;
  window.__petDesktopExt = true;

  // 两套端点：优先 8099 助手，失败回退到 dsh web 插件路由（同源）
  var EP = [
    { base: 'http://127.0.0.1:8099', inbox: '/inbox', size: '/pet-size', report: '/report' },
    { base: '',                      inbox: '/pet-desktop/api/inbox', size: '/pet-desktop/api/size', report: '/pet-desktop/api/report' }
  ];
  // 每次请求都从 8099 开始试，失败才用插件路由——不"记住"失败，避免助手短暂重启后永久失联
  function epFetch(kind, query, init) {
    var i = 0;
    function attempt() {
      if (i >= EP.length) return Promise.reject(new Error('no-endpoint'));
      var e = EP[i++];
      var opts = init || {};
      opts.cache = 'no-store';
      return fetch(e.base + e[kind] + (query || ''), opts).then(function (r) {
        if (!r.ok) throw new Error('http ' + r.status);
        return r;
      }).catch(function () { return attempt(); });
    }
    return attempt();
  }
  function report(obj) {
    try { epFetch('report', '?d=' + encodeURIComponent(JSON.stringify(obj))).catch(function () {}); } catch (e) {}
  }

  // 1) 自播动画外播的"兜底"：如果内部钩子（switchTo 补丁）没打上，
  //    就靠观察 video 的 src 变化来发布动画名——上游大改也能继续工作。
  {
    var lastSrc = '';
    var petId = 'main';
    function nameFromSrc(src) {
      try {
        var u = String(src || '');
        var q = u.split('?')[0];
        var file = decodeURIComponent(q.substring(q.lastIndexOf('/') + 1));
        return file.replace(/\.(webm|mov)$/i, '');
      } catch (e) { return ''; }
    }
    setInterval(function () {
      var vids = document.querySelectorAll('video');
      for (var i = 0; i < vids.length; i++) {
        var v = vids[i];
        if (!v.currentSrc || v.currentSrc === lastSrc) continue;
        var cs = getComputedStyle(v);
        if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') continue;
        lastSrc = v.currentSrc;
        if (Date.now() - (window.__petPubAt || 0) < 1500) break;   // 内部钩子刚发过，别重复
        var name = nameFromSrc(lastSrc);
        if (!name) break;
        var tf = cs.transform || '';
        var at = tf.indexOf('matrix(');
        var facing;
        if (at >= 0) facing = tf.charAt(at + 7) === '-' ? 'right' : 'left';
        fetch('/dsh-pet-7340/anim?pet=' + encodeURIComponent(petId) + '&surface=web', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(facing ? { name: name, facing: facing } : { name: name })
        }).catch(function () {});
        break;
      }
    }, 700);
  }

  // 2) 收件箱：桌面宠物投递 → 这里用页面自己的 DOM 写进输入框并发送
  function deepQuery(sel) {
    var f = document.querySelector(sel);
    if (f) return f;
    var walk = function (root) {
      var list = root.querySelectorAll('*');
      for (var i = 0; i < list.length; i++) {
        var el = list[i];
        if (el.shadowRoot) {
          var hit = el.shadowRoot.querySelector(sel);
          if (hit) return hit;
          var sub = walk(el.shadowRoot);
          if (sub) return sub;
        }
      }
      return null;
    };
    return walk(document);
  }
  function findComposer() {
    return deepQuery('textarea') || deepQuery('[contenteditable="true"]') || deepQuery('[role="textbox"]');
  }
  function findSendButton() {
    var all = Array.prototype.slice.call(document.querySelectorAll('button'));
    return all.find(function (b) {
      var label = (b.getAttribute('aria-label') || '') + ' ' + (b.getAttribute('title') || '') + ' ' + (b.textContent || '');
      return /发送|send|submit/i.test(label);
    }) || null;
  }
  function inject(text) {
    var tries = 0;
    function clickSend(el, n) {
      var btn = findSendButton();
      var disabled = !btn || btn.disabled || btn.getAttribute('aria-disabled') === 'true';
      if (!disabled) { try { btn.click(); } catch (e) {} }
      setTimeout(function () {
        var left = ((el.value !== undefined ? el.value : el.textContent) || '').trim();
        if (left.length > 0) {
          if (n < 2) return clickSend(el, n + 1);
          // 点了三次还有残留：回车兜底
          ['keydown', 'keypress', 'keyup'].forEach(function (type) {
            el.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
          });
          report({ ok: true, clicked: true, fallbackEnter: true });
          return;
        }
        report({ ok: true, clicked: true, tries: n + 1 });
      }, 420);
    }
    function attempt() {
      var el = findComposer();
      if (!el) {
        if (++tries < 3) return setTimeout(attempt, 400);
        report({ ok: false, reason: 'no-composer' });
        return;
      }
      try { el.focus(); } catch (e) {}
      try {
        if (el.tagName === 'TEXTAREA') {
          var setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
          setter.call(el, text);
          el.dispatchEvent(new Event('input', { bubbles: true }));
        } else {
          el.textContent = text;
          el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
        }
      } catch (e) {}
      setTimeout(function () {
        var now = ((el.value !== undefined ? el.value : el.textContent) || '').trim();
        if (!now) {
          if (++tries < 3) return setTimeout(attempt, 400);
          report({ ok: false, reason: 'composer-empty-after-write' });
          return;
        }
        clickSend(el, 0);
      }, 240);
    }
    attempt();
  }

  function tickInbox() {
    epFetch('inbox')
      .then(function (r) { return r.json(); })
      .then(function (j) { if (j && j.item && j.item.text) inject(j.item.text); })
      .catch(function () {})
      .then(function () { setTimeout(tickInbox, 2000); });
  }

  // 3) 显示位置 + 尺寸上报
  var lastDisplay = null, lastW = 0;
  function syncDisplayAndSize() {
    fetch('/dsh-pet-7340/config', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        var pets = (j && j.main && j.main.pets) || [];
        var visible = pets.some(function (p) { return p.display === 'web' || p.display === 'both'; });
        // 显隐交给 dsh-pet 自己（它按 display 卸载/挂载）。这里只记录，不再改 DOM——
        // 之前那套 style.display 兜底既选不中节点（宠物在 portal 里），又容易和插件打架。
        if (visible !== lastDisplay) {
          lastDisplay = visible;
          report({ pageDisplay: visible ? 'shown' : 'hidden' });
          // dsh-pet 从"仅桌面"切回"仅页面"时偶尔不会重新挂载：切到"应显示"后 2.5 秒还没有视频，
          // 就自己刷一次页面（60 秒内最多一次），保证宠物一定回来。
          setTimeout(function () {
            var hasPet = document.querySelectorAll('video').length > 0;
            var wrong = (visible && !hasPet) || (!visible && hasPet);
            if (wrong && Date.now() - (window.__petReloadAt || 0) > 60000) {
              window.__petReloadAt = Date.now();
              report({ selfReload: visible ? 'pet-missing' : 'pet-still-visible' });
              location.reload();
            }
          }, 2500);
        }
        var vids = document.querySelectorAll('video');
        for (var k = 0; k < vids.length; k++) {
          var cs = getComputedStyle(vids[k]);
          if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') continue;
          var r = vids[k].getBoundingClientRect();
          var wpx = Math.round(r.width * (window.devicePixelRatio || 1));
          if (wpx > 20) {
            lastW = wpx;
            epFetch('size', '?w=' + wpx).catch(function () {});
          }
          break;
        }
      })
      .catch(function () {});
  }

  setTimeout(tickInbox, 1500);
  setTimeout(syncDisplayAndSize, 900);
  setInterval(syncDisplayAndSize, 3000);
})();
`

function fail(msg) {
  console.warn('[patch-dsh-pet] ' + msg)
}

export function patchDshPet(opts) {
  const CLIENT = (opts && opts.clientPath) || DEFAULT_CLIENT
  const BACKUP_ = CLIENT + '.dsh-pet-desktop.bak'
  if (!existsSync(CLIENT)) {
    fail('client.js not found: ' + CLIENT)
    return { ok: false, reason: 'no-client' }
  }
  const original = readFileSync(CLIENT, 'utf8')
  let out = original
  const applied = []

  // 已经打过尾部附加脚本的话，先剥掉再重打（便于升级后统一处理）
  const tailMark = '// ---- dsh-pet-desktop：页面端附加脚本'
  const tailAt = out.indexOf(tailMark)
  if (tailAt >= 0) out = out.slice(0, tailAt)

  for (const p of PATCHES) {
    if (out.includes(p.marker)) { applied.push(p.name + '(skip)'); continue }
    const next = p.apply(out)
    if (next == null) { fail('anchor not found: ' + p.name); continue }
    out = next
    applied.push(p.name)
  }

  out = out + TAIL

  if (out === original) return { ok: true, changed: false, applied }

  // 语法校验：用 node --check 的等价手段（子进程最稳，能识别 ESM/IIFE）
  const tmp = '/tmp/dsh-pet-client-check.js'
  writeFileSync(tmp, out, 'utf8')
  const r = spawnSync(process.execPath, ['--check', tmp], { encoding: 'utf8' })
  if (r.status !== 0) {
    fail('syntax check failed, rollback: ' + (r.stderr || '').slice(0, 300))
    return { ok: false, reason: 'syntax', applied }
  }

  if (!existsSync(BACKUP_)) copyFileSync(CLIENT, BACKUP_)
  writeFileSync(CLIENT, out, 'utf8')
  // 状态落盘，便于 `curl /pet-desktop/api/status` 或人工核对
  try {
    writeFileSync('/root/dsha-pet-desktop/.patch-status.json', JSON.stringify({
      at: new Date().toISOString(),
      changed: true,
      applied,
      client: CLIENT,
      mtime: statSync(CLIENT).mtimeMs,
      hasHook: out.includes('publishLocalAnim'),
      hasVisibleObserver: out.includes('window.__petPubAt'),
      hasEndpointFallback: out.includes('/pet-desktop/api/inbox'),
    }, null, 2), 'utf8')
  } catch (e) { /* 状态写不进去不影响补丁本身 */ }
  console.log('[patch-dsh-pet] patched client.js (' + applied.join(', ') + ')')
  return { ok: true, changed: true, applied }
}
