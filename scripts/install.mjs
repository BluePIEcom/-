#!/usr/bin/env node
// install.mjs —— 把共享记忆 MCP 注册进某个 DSH profile（开发者/已克隆仓库的人用）。
//
// 拿到安装包的人应该用 install-wizard.mjs：它会问安装路径与记忆路径，并把文件复制过去。
//
// 用法：
//   node scripts/install.mjs --profile desktop
//   node scripts/install.mjs --profile desktop --config ./config.json --memory-dir /abs/path
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeMcpRegistration, seedChannels } from './lib/register.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const eq = a.indexOf('=')
    if (eq >= 0) out[a.slice(2, eq)] = a.slice(eq + 1)
    else out[a.slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? (i += 1, argv[i]) : true
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
const profile = typeof args.profile === 'string' ? args.profile : 'desktop'
if (/[\\/\x00-\x1f<>:"|?*]/.test(profile) || profile === '.' || profile === '..') {
  console.error(`[install] 非法 profile 名：${profile}`)
  process.exit(1)
}

const dshHome = path.resolve(
  typeof args['dsh-home'] === 'string' ? args['dsh-home'] : (process.env.DSH_HOME || path.join(os.homedir(), '.dsh')),
)
const configPath = path.resolve(ROOT, typeof args.config === 'string' ? args.config : 'config.json')
const serverPath = path.join(ROOT, 'src', 'server.mjs')

if (!fs.existsSync(configPath)) {
  fs.copyFileSync(path.join(ROOT, 'config.example.json'), configPath)
  console.log(`[install] 已从 config.example.json 生成 ${configPath}`)
}
const config = JSON.parse(fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, ''))
const memoryDir = typeof args['memory-dir'] === 'string'
  ? path.resolve(args['memory-dir'])
  : path.resolve(ROOT, config.memoryDir ?? 'shared-memory')

const seeded = seedChannels({ memoryDir, channels: config.channels, adaptersDir: config.adaptersDir })
const nodePath = process.env.DSH_NODE || process.execPath

try {
  const reg = writeMcpRegistration({ dshHome, profile, nodePath, serverPath, configPath })
  console.log(reg.changed ? `[install] 已更新 ${reg.patchFile}` : `[install] ${reg.patchFile} 无需改动`)
  if (reg.backup) console.log(`[install] 原文件已备份：${reg.backup}`)
} catch (error) {
  console.error(`[install] ${error?.message ?? error}`)
  process.exit(1)
}

console.log(`
[install] 完成。接下来：

  1) 重启一次 DSH（MCP server 只在启动时加载）
  2) 验证：node scripts/selftest.mjs
  3) 打开面板：node src/panel/server.mjs   （终端会打印带令牌的地址）

本次写入：
  profile   ${path.join(dshHome, 'profiles', profile)}
  config    ${configPath}
  memory    ${seeded.memoryDir}${seeded.created.length ? `\n  seed      ${seeded.created.join(', ')}` : ''}
  node      ${nodePath}
`)
