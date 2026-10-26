/**
 * dsh-pet-desktop —— dsh-pet 的"桌面端"宿主半边。
 *
 * 1) 随 dsh web 启停注入助手（容器里的 8099 收件箱）；
 * 2) 用 webServer 把桌面端的页面与素材供出去（/pet-desktop/*）——
 *    安卓那个壳 App 只负责开悬浮窗 + 装一个 WebView 指向这里，
 *    所以以后改样式/加动画/改菜单都只更新插件，不用重装 APK。
 */
import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { dirname, extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { patchDshPet } from '../scripts/patch-dsh-pet.mjs'

export const name = 'dsh-pet-desktop'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const ASSETS = join(ROOT, 'assets')
// 助手脚本随包分发（不再依赖仓库外的绝对路径）
const HELPER = join(ROOT, 'lib', 'chat-helper.cjs')
/**
 * 找到 dsh-pet 的客户端 bundle。
 * 不能只靠 require.resolve：插件目录常是 link: 软链，真实路径下没有 node_modules/dsh-pet。
 * 这里按"profile 的 node_modules → 插件自身/上级 → DSH_HOME/profiles/*"依次找，最后才回落 require.resolve。
 */
function resolveDshPetClient() {
  const bases = []
  const home = process.env.DSH_HOME || join(process.env.HOME || '/root', '.dsh')
  try {
    for (const name of readdirSync(join(home, 'profiles'))) bases.push(join(home, 'profiles', name))
  } catch (e) { /* 没有 profiles 目录就跳过 */ }
  bases.push(ROOT, process.cwd(), join(ROOT, '..'))
  for (const base of bases) {
    const file = join(base, 'node_modules', 'dsh-pet', 'lib', 'client.js')
    if (existsSync(file)) return file
  }
  try {
    return join(dirname(createRequire(import.meta.url).resolve('dsh-pet/package.json')), 'lib', 'client.js')
  } catch (e) {
    console.warn('[pet-desktop] cannot resolve dsh-pet client:', e && e.message)
    return ''
  }
}
const CLIENT_PATH = resolveDshPetClient()

function notify(title, text) {
  try {
    const token = readFileSync('/root/.dsh/.bridge_token', 'utf8').trim()
    const u = 'http://127.0.0.1:3090/app/notify?title=' + encodeURIComponent(title) + '&text=' + encodeURIComponent(text)
    fetch(u, { headers: { 'X-Token': token } }).catch(() => {})
  } catch (e) {}
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.webm': 'video/webm',
  '.json': 'application/json; charset=utf-8',
}

export function apply(ctx) {
  // 0) 先把桌面端需要的补丁打到 dsh-pet 的客户端 bundle（幂等；插件升级后自动重打）
  try {
    const r = patchDshPet({ clientPath: CLIENT_PATH })
    if (r && r.changed) console.log('[pet-desktop] dsh-pet client patched:', (r.applied || []).join(', '))
    else if (r && r.ok === false) console.warn('[pet-desktop] dsh-pet patch failed:', r.reason)
  } catch (e) {
    console.warn('[pet-desktop] dsh-pet patch threw:', e)
  }

  // 0.5) 新用户：把壳 APK 落到 Download 并提示安装（Android 不允许静默装包）
  ctx.effect(() => {
    const apk = join(ASSETS, 'pet-shell.apk')
    const dir = '/sdcard/Download/DSHA'
    const dest = join(dir, 'DSHAPetShell.apk')
    try {
      if (!existsSync(apk)) return () => {}
      mkdirSync(dir, { recursive: true })
      const need = !existsSync(dest) || statSync(dest).size !== statSync(apk).size
      if (!need) return () => {}
      copyFileSync(apk, dest)
      console.log('[pet-desktop] shell apk ->', dest)
      // 有设备 shell 通道（root / Shizuku / ADB）就顺手装上
      const r = spawnSync('/root/dsh-bin/adb-shell', ['pm install -r ' + dest], { encoding: 'utf8', timeout: 60000 })
      if (r && r.status === 0 && String(r.stdout).includes('Success')) {
        console.log('[pet-desktop] shell apk installed automatically')
      } else {
        notify('桌面宠物：还差一步', '打开「文件管理 → Download/DSHA → DSHAPetShell.apk」点安装即可')
      }
    } catch (e) {
      console.warn('[pet-desktop] shell apk deploy failed:', e)
    }
    return () => {}
  }, 'dsh-pet-desktop: shell apk')

  // 1) 注入助手：跟着 dsh web 一起启停，别再当野进程
  ctx.effect(() => {
    let child = null
    try {
      if (!existsSync(HELPER)) {
        console.warn('[pet-desktop] helper not found:', HELPER)
        return () => {}
      }
      child = spawn(process.execPath, [HELPER], { stdio: ['ignore', 'pipe', 'pipe'], env: process.env })
      child.stdout?.on('data', (d) => console.log('[pet-desktop]', String(d).trim()))
      child.stderr?.on('data', (d) => console.warn('[pet-desktop]', String(d).trim()))
      child.on('exit', (code) => console.log('[pet-desktop] helper exited with', code))
    } catch (e) {
      console.warn('[pet-desktop] spawn failed:', e)
    }
    return () => {
      try {
        if (child && !child.killed) child.kill('SIGTERM')
      } catch (e) {
        /* 忽略 */
      }
    }
  }, 'dsh-pet-desktop: chat helper')

  // 1.5) 页面可写接口（与 8099 助手同构，作为回退）
  const mem = { inbox: [], size: 0 }
  ctx.inject(['webServer'], (ctx2) => {
    ctx2.webServer.register({
      kind: 'prefix',
      path: '/pet-desktop/api',
      handler: async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        const sub = url.pathname.slice('/pet-desktop/api'.length)
        const send = (code, obj) => {
          const body = JSON.stringify(obj)
          res.writeHead(code, {
            'content-type': 'application/json; charset=utf-8',
            'content-length': Buffer.byteLength(body),
            'access-control-allow-origin': '*',
            'cache-control': 'no-store',
          })
          res.end(body)
        }
        const readBody = async () => {
          let raw = ''
          for await (const chunk of req) raw += chunk
          return raw
        }
        try {
          if (sub === '/inbox') {
            if (req.method === 'POST') {
              const { text } = JSON.parse((await readBody()) || '{}')
              if (!text) return send(200, { ok: false, reason: 'empty' })
              mem.inbox.push({ text: String(text), at: Date.now() })
              if (mem.inbox.length > 8) mem.inbox = mem.inbox.slice(-8)
              return send(200, { ok: true, depth: mem.inbox.length })
            }
            const item = mem.inbox.shift()
            return send(200, { ok: true, item: item ?? null, depth: mem.inbox.length })
          }
          if (sub === '/size') {
            const w = parseInt(url.searchParams.get('w') || '0', 10)
            if (w > 20) mem.size = w
            return send(200, { ok: true, w: mem.size })
          }
          if (sub === '/report') {
            console.log('[pet-desktop/page]', (url.searchParams.get('d') || '').slice(0, 240))
            return send(200, { ok: true })
          }
          send(404, { ok: false, reason: 'not-found' })
        } catch (e) {
          send(500, { ok: false, reason: String(e) })
        }
      },
    })
  })

  // 2) 静态路由：/pet-desktop/<file>
  ctx.inject(['webServer'], (ctx2) => {
    ctx2.webServer.register({
      kind: 'prefix',
      path: '/pet-desktop',
      handler: async (req, res) => {
        try {
          const url = new URL(req.url ?? '/', 'http://127.0.0.1')
          let rel = decodeURIComponent(url.pathname.slice('/pet-desktop'.length))
          if (!rel || rel === '/') rel = '/pet.html'
          const file = normalize(join(ASSETS, rel))
          if (!file.startsWith(ASSETS)) {
            res.writeHead(403)
            res.end('forbidden')
            return
          }
          const data = await readFile(file)
          res.writeHead(200, {
            'content-type': MIME[extname(file)] ?? 'application/octet-stream',
            'content-length': data.length,
            'cache-control': 'no-cache',
            // 壳 App 从 127.0.0.1 打开，同源；这里仍放开 CORS 便于调试
            'access-control-allow-origin': '*',
          })
          res.end(data)
        } catch (e) {
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
          res.end('not found: ' + String(e && e.message ? e.message : e))
        }
      },
    })
    console.log('[pet-desktop] serving assets at /pet-desktop')
  })
}
