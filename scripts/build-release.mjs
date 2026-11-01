#!/usr/bin/env node
// build-release.mjs —— 打一个"下载即用"的发布包。
//
// 关键点：**用 hoisted 方式重新装依赖**，不要直接复制开发目录的 node_modules。
//   pnpm 默认（isolated）会在 node_modules 顶层放一堆符号链接；
//   复制工具（资源管理器、zip、甚至 Node 的 fs 复制）对链接的处理各不相同，
//   结果就是"发布包里少了依赖，用户装完报 ERR_MODULE_NOT_FOUND"（我们踩过）。
//   hoisted 模式产出的是**真实目录**，复制/压缩都不会丢。
//
// 产物：dist/dsh-reef-v<version>/  ← 直接压缩成 zip 上传 Release
// 不含：.git、config.json（本机路径）、shared-memory/、archive/、.panel-token、*.bak
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const OUT = path.join(ROOT, 'dist', `dsh-reef-v${pkg.version}`)

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue
    out[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? (i += 1, argv[i]) : true
  }
  return out
}
const args = parseArgs(process.argv.slice(2))
const pnpm = typeof args.pnpm === 'string' ? args.pnpm : (process.env.DSH_PNPM || 'pnpm')

const INCLUDE = ['package.json', 'pnpm-lock.yaml', 'README.md', 'LICENSE', 'config.example.json', 'src', 'scripts', 'docs', 'examples', 'tests']
const DENY_NAMES = new Set(['.git', 'dist', 'shared-memory', '.panel-test', 'archive', 'config.json', '.panel-token'])

fs.rmSync(OUT, { recursive: true, force: true })
fs.mkdirSync(OUT, { recursive: true })

let files = 0
let bytes = 0
function copy(src, dst) {
  const name = path.basename(src)
  if (DENY_NAMES.has(name) || name.endsWith('.bak')) return
  const st = fs.statSync(src) // 跟随符号链接
  if (st.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true })
    for (const entry of fs.readdirSync(src)) copy(path.join(src, entry), path.join(dst, entry))
    return
  }
  fs.copyFileSync(src, dst)
  files += 1
  bytes += st.size
}

for (const item of INCLUDE) {
  const src = path.join(ROOT, item)
  if (!fs.existsSync(src)) continue
  copy(src, path.join(OUT, item))
}

// 用 hoisted 装一份干净的依赖（不含 devDependencies）
let depNote = ''
try {
  // pnpm 可能是一个 .mjs（DSH 自带的那种），也可能是一个可执行文件；两种都支持。
  const isMjs = /\.mjs$/i.test(pnpm)
  const file = isMjs ? process.execPath : pnpm
  const prefix = isMjs ? [pnpm] : []
  execFileSync(file, [...prefix, 'install', '--prod', '--node-linker=hoisted', '--ignore-scripts', '--reporter=append-only'], {
    cwd: OUT,
    stdio: 'inherit',
    env: { ...process.env, CI: 'true' },
  })
  const nm = path.join(OUT, 'node_modules')
  const entries = fs.existsSync(nm) ? fs.readdirSync(nm).length : 0
  depNote = `hoisted 依赖已安装（node_modules 顶层 ${entries} 项）`
  console.log(`[build] ${depNote}`)
} catch (error) {
  depNote = '依赖未打包（本机没有 pnpm 或安装失败）—— 下载者需要自己 pnpm install'
  console.warn(`[build] ⚠️ ${depNote}`)
}

// 统计（含刚装的 node_modules）
function walk(dir) {
  let n = 0
  let b = 0
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    const st = fs.statSync(p)
    if (st.isDirectory()) {
      const r = walk(p)
      n += r.n
      b += r.b
    } else {
      n += 1
      b += st.size
    }
  }
  return { n, b }
}
const total = walk(OUT)

// 给下载者看的入口说明
fs.writeFileSync(path.join(OUT, '安装说明.txt'), `dsh-reef v${pkg.version} —— 安装说明
====================================

前提：这台机器上装过 DeepSeek Harness（DSH），并且至少启动过一次。
${depNote.includes('未打包') ? '\n⚠️ 本包未内置依赖，安装前请在本目录执行：pnpm install\n' : ''}
安装（二选一）
--------------
A. 向导式（推荐，会问你装到哪、记忆存到哪）：
     双击 安装.cmd
   或命令行：
     node scripts\\install-wizard.mjs

B. 非交互（全用默认路径）：
     node scripts\\install-wizard.mjs --yes

默认路径
--------
  程序：%LOCALAPPDATA%\\dsh-reef
  记忆：%USERPROFILE%\\.dsh\\reef-memory

装完要做的
----------
1) 重启一次 DSH（MCP server 只在启动时加载）
2) 打开面板：双击安装目录里的 start-panel.cmd
   （独立窗口打开：open-panel.cmd）
3) 在 DSH 会话里让 agent「读一下共享记忆」，能返回内容就说明通了

卸载
----
1) 删掉程序目录和记忆目录
2) 打开 %USERPROFILE%\\.dsh\\profiles\\desktop\\cordis.patch.yml
   删掉 "# === dsh-reef BEGIN ===" 到 "# === dsh-reef END ===" 之间整段
3) 重启 DSH
`, 'utf8')

fs.writeFileSync(path.join(OUT, '安装.cmd'), [
  '@echo off',
  'chcp 65001 >nul',
  'cd /d "%~dp0"',
  'where node >nul 2>nul',
  'if errorlevel 1 (',
  '  echo [ERR] 找不到 node。请先安装 Node.js 22 或更高版本：https://nodejs.org',
  '  pause',
  '  exit /b 1',
  ')',
  'node scripts\\install-wizard.mjs',
  'pause',
].join('\r\n') + '\r\n', 'utf8')

console.log(`[build] 已生成 ${OUT}`)
console.log(`[build] ${total.n} 个文件，${(total.b / 1024 / 1024).toFixed(1)} MB`)
console.log(`[build] 下一步：Compress-Archive -Path "${OUT}" -DestinationPath "${path.join(ROOT, 'dist', `dsh-reef-v${pkg.version}-win.zip`)}" -Force`)
