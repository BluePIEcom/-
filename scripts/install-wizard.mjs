#!/usr/bin/env node
// install-wizard.mjs —— 给"拿到安装包的人"用的向导式安装。
//
// 和 install.mjs 的区别：
//   · install.mjs  假设你已经克隆了仓库，就地注册（适合开发者）
//   · 这个         把整个包复制到你选的目录，再按你选的路径建记忆、注册 MCP
//
// 会问两件事（都有默认值，直接回车就行）：
//   1) 装到哪          默认 %LOCALAPPDATA%\dsh-reef
//   2) 记忆存到哪      默认 %USERPROFILE%\.dsh\reef-memory
//
// 非交互：加 --yes 用默认值（CI / 脚本里用）。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline/promises'
import { fileURLToPath } from 'node:url'
import { stdin as input, stdout as output } from 'node:process'
import { writeMcpRegistration, seedChannels } from './lib/register.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = path.resolve(__dirname, '..')

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (!a.startsWith('--')) {
      out._.push(a)
      continue
    }
    const eq = a.indexOf('=')
    if (eq >= 0) out[a.slice(2, eq)] = a.slice(eq + 1)
    else out[a.slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? (i += 1, argv[i]) : true
  }
  return out
}
const args = parseArgs(process.argv.slice(2))

const HOME = os.homedir()
const DEFAULTS = {
  installDir: path.join(process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local'), 'dsh-reef'),
  memoryDir: path.join(process.env.DSH_HOME || path.join(HOME, '.dsh'), 'reef-memory'),
  profile: 'desktop',
  dshHome: path.resolve(process.env.DSH_HOME || path.join(HOME, '.dsh')),
}

// 只在**包根目录**跳过这些名字。不能在任意层级按名字跳过：
// 依赖包内部大量存在 dist/ 目录（例如 @modelcontextprotocol/sdk/dist/esm/…），
// 按名字全局跳过会把依赖复制残，用户装完就是 ERR_MODULE_NOT_FOUND（踩过）。
const SKIP_AT_ROOT = new Set(['.git', 'dist', 'shared-memory', '.panel-test', 'archive'])

/** 复制包内容到目标目录（不覆盖已存在的 config.json，可重复运行）。 */
function copyTree(from, to, { skipExisting = [] } = {}) {
  const copied = []
  const walk = (src, dst, atRoot) => {
    fs.mkdirSync(dst, { recursive: true })
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      if (atRoot && SKIP_AT_ROOT.has(entry.name)) continue
      const s = path.join(src, entry.name)
      const d = path.join(dst, entry.name)
      if (skipExisting.includes(d) && fs.existsSync(d)) continue
      // pnpm 的 node_modules 里包是符号链接，Dirent.isDirectory() 对它们是 false，
      // 必须用 statSync 跟随链接，否则整个依赖树会被"看起来像文件"而跳过。
      const st = fs.statSync(s)
      if (st.isDirectory()) walk(s, d, false)
      else if (st.isFile()) {
        fs.copyFileSync(s, d)
        copied.push(path.relative(to, d))
      }
    }
  }
  walk(from, to, true)
  return copied
}

async function ask(rl, question, fallback) {
  const answer = (await rl.question(`${question}\n  [${fallback}]: `)).trim()
  return answer || fallback
}

let rl = null
let installDir = typeof args['install-dir'] === 'string' ? path.resolve(args['install-dir']) : null
let memoryDir = typeof args['memory-dir'] === 'string' ? path.resolve(args['memory-dir']) : null
let profile = typeof args.profile === 'string' ? args.profile : null
const dshHome = path.resolve(typeof args['dsh-home'] === 'string' ? args['dsh-home'] : DEFAULTS.dshHome)

const yes = args.yes === true
if (!yes && args._.length === 0) {
  rl = readline.createInterface({ input, output })
  console.log(`
dsh-reef 安装向导
────────────────────────────────────────────
它会做三件事：
  1) 把程序复制到你选的目录
  2) 在你选的位置建共享记忆目录（不会被覆盖）
  3) 在 DSH profile 里注册 MCP，重启 DSH 后生效
`)
  installDir = path.resolve(await ask(rl, '① 安装到哪个目录？', DEFAULTS.installDir))
  memoryDir = path.resolve(await ask(rl, '② 共享记忆存到哪个目录？', DEFAULTS.memoryDir))
  profile = (await ask(rl, '③ DSH profile 名（桌面版一般是 desktop）', DEFAULTS.profile)).trim()
}

installDir = installDir || DEFAULTS.installDir
memoryDir = memoryDir || DEFAULTS.memoryDir
profile = profile || DEFAULTS.profile
if (rl) rl.close()

if (installDir === memoryDir) {
  console.error('[wizard] 安装目录和记忆目录不能是同一个（升级时会互相覆盖）')
  process.exit(1)
}
const profileDir = path.join(dshHome, 'profiles', profile)
if (!fs.existsSync(profileDir)) {
  console.error(`[wizard] 找不到 DSH profile：${profileDir}\n  先启动一次 DSH，再来安装。`)
  process.exit(1)
}

// 1) 复制程序
const copied = copyTree(PKG_ROOT, installDir, { skipExisting: [path.join(installDir, 'config.json')] })

// 2) 生成 config.json（记忆目录用绝对路径）
const configPath = path.join(installDir, 'config.json')
if (!fs.existsSync(configPath)) {
  const base = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'config.example.json'), 'utf8'))
  base.memoryDir = memoryDir
  fs.writeFileSync(configPath, JSON.stringify(base, null, 2) + '\n', 'utf8')
}
const config = JSON.parse(fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, ''))
config.memoryDir = memoryDir
fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8')

// 3) 建记忆目录
const seeded = seedChannels({ memoryDir, channels: config.channels, adaptersDir: config.adaptersDir })

// 4) 注册 MCP
const nodePath = process.env.DSH_NODE || process.execPath
const serverPath = path.join(installDir, 'src', 'server.mjs')
const reg = writeMcpRegistration({ dshHome, profile, nodePath, serverPath, configPath })

// 5) 放两个快捷脚本
const panelDir = path.join(installDir, 'src', 'panel')
const tokenFile = path.join(memoryDir, '.panel-token')
fs.writeFileSync(path.join(installDir, 'start-panel.cmd'), [
  '@echo off',
  'chcp 65001 >nul',
  'cd /d "%~dp0"',
  `"${nodePath}" "src\\panel\\server.mjs" --port 3210`,
  'pause',
].join('\r\n') + '\r\n', 'utf8')

fs.writeFileSync(path.join(installDir, 'open-panel.cmd'), [
  '@echo off',
  'chcp 65001 >nul',
  'setlocal',
  `if not exist "${tokenFile}" (`,
  '  echo [ERR] 先运行一次 start-panel.cmd 生成令牌',
  '  pause',
  '  exit /b 1',
  ')',
  `set /p TOK=<"${tokenFile}"`,
  'set "URL=http://127.0.0.1:3210/?token=%TOK%"',
  'set "EDGE=%ProgramFiles(x86)%\\Microsoft\\Edge\\Application\\msedge.exe"',
  'if not exist "%EDGE%" set "EDGE=%ProgramFiles%\\Microsoft\\Edge\\Application\\msedge.exe"',
  'if exist "%EDGE%" ( start "" "%EDGE%" --app="%URL%" --window-size=1200,880 & exit /b 0 )',
  'start "" "%URL%"',
].join('\r\n') + '\r\n', 'utf8')

console.log(`
✓ 安装完成
────────────────────────────────────────────
  程序      ${installDir}      （复制 ${copied.length} 个文件）
  记忆      ${memoryDir}${seeded.created.length ? `\n            新建 ${seeded.created.join(', ')}` : ''}
  profile   ${profileDir}
  patch     ${reg.changed ? '已写入' : '无需改动'}  ${reg.patchFile}

接下来：
  1) 重启一次 DSH（MCP server 只在启动时加载）
  2) 打开面板：双击 ${path.join(installDir, 'start-panel.cmd')}
     然后在 DSH 会话里问 agent「读一下共享记忆」验证工具是否可用
  3) 想把面板做成独立窗口：双击 ${path.join(installDir, 'open-panel.cmd')}

卸载：删掉上面两个目录，再把 cordis.patch.yml 里
      "${'# === dsh-reef BEGIN ==='}" 到 "${'# === dsh-reef END ==='}" 之间整段删掉。
`)
