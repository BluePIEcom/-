#!/usr/bin/env node
// install.mjs —— 把共享记忆 MCP 注册进某个 DSH profile。
//
// 为什么用「注释标记块」而不是解析 YAML 再回写：
//   DSH 的 cordis.patch.yml 里可能有 `!!js` 标签、锚点、用户注释。用 YAML 库读进来再
//   dump 出去会把这些全部重排/丢失（踩过），所以这里只做**整体替换一个带标记的区块**，
//   区块外的内容一个字节都不碰。
//
// 幂等：重复运行只会替换自己的区块；区块不存在就追加。
//
// 用法：
//   node scripts/install.mjs --profile desktop
//   node scripts/install.mjs --profile desktop --config ./config.json --dsh-home ~/.dsh
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

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
const profileDir = path.join(dshHome, 'profiles', profile)
const patchFile = path.join(profileDir, 'cordis.patch.yml')
const configPath = path.resolve(ROOT, typeof args.config === 'string' ? args.config : 'config.json')
const serverPath = path.join(ROOT, 'src', 'server.mjs')

if (!fs.existsSync(profileDir)) {
  console.error(`[install] profile 不存在：${profileDir}\n  先启动一次 DSH（它会初始化这个 profile），再来运行本脚本。`)
  process.exit(1)
}

// 1) 准备 config.json + 记忆目录
if (!fs.existsSync(configPath)) {
  const example = path.join(ROOT, 'config.example.json')
  fs.copyFileSync(example, configPath)
  console.log(`[install] 已从 config.example.json 生成 ${configPath}`)
}
const config = JSON.parse(fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, ''))
const memoryDir = typeof args['memory-dir'] === 'string'
  ? path.resolve(args['memory-dir'])
  : path.resolve(ROOT, config.memoryDir ?? 'shared-memory')
fs.mkdirSync(memoryDir, { recursive: true })
fs.mkdirSync(path.join(memoryDir, config.adaptersDir ?? 'adapters'), { recursive: true })

/** 只在文件不存在时写种子内容，绝不覆盖用户已经写过的记忆。 */
function seed(file, text) {
  const p = path.join(memoryDir, file)
  if (fs.existsSync(p)) return
  fs.writeFileSync(p, text.trimEnd() + '\n', 'utf8')
}
for (const c of config.channels ?? []) {
  if (!c?.file) continue
  const hint = c.trust === 'trusted'
    ? `# ${c.title ?? c.file}\n\n（这个文件由人维护：写下你希望所有 agent 都遵守的事实与规矩。）`
    : `# ${c.title ?? c.file}\n\n（还没写过。agent 会在需要时往这里追加。）`
  seed(c.file, hint)
}

// 2) 生成要插入的 YAML 区块
const q = (s) => `'${String(s).replace(/'/g, "''")}'`
const nodePath = process.env.DSH_NODE || process.execPath
const block = [
  '# === dsh-reef BEGIN ===',
  '# 由 dsh-reef/scripts/install.mjs 维护；整段会被替换，请勿手改区块内部。',
  '- insert:',
  '    - id: mcp-shared-memory',
  "      name: '@deepseek-ai/dsh-mcp-client'",
  '      config:',
  '        serverName: shared-memory',
  '        transport: stdio',
  `        command: ${q(nodePath)}`,
  '        args:',
  `          - ${q(serverPath)}`,
  '          - --config',
  `          - ${q(configPath)}`,
  '# === dsh-reef END ===',
].join('\n')

// 3) 替换/追加区块（块外内容不动）
const original = fs.existsSync(patchFile) ? fs.readFileSync(patchFile, 'utf8').replace(/^\uFEFF/, '') : ''
const begin = '# === dsh-reef BEGIN ==='
const end = '# === dsh-reef END ==='
let next
const b = original.indexOf(begin)
const e = original.indexOf(end)
if (b >= 0 && e > b) {
  next = original.slice(0, b) + block + original.slice(e + end.length)
} else {
  // 兼容 profile 里那个空的根 `[]`：它和下面的块条目同在根层就会让 YAML 非法。
  let base = original
  const lines = base.split(/\r?\n/)
  const firstIdx = lines.findIndex((line) => line.trim() && !line.trimStart().startsWith('#'))
  if (firstIdx >= 0 && lines[firstIdx].trim() === '[]' && lines.slice(firstIdx + 1).some((line) => /^-\s/.test(line))) {
    lines.splice(firstIdx, 1)
    base = lines.join('\n')
  }
  next = base.trimEnd() ? `${base.trimEnd()}\n\n${block}\n` : `${block}\n`
}

if (next !== original) {
  if (original) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    fs.copyFileSync(patchFile, `${patchFile}.bak-${stamp}`)
  }
  fs.mkdirSync(path.dirname(patchFile), { recursive: true })
  fs.writeFileSync(patchFile, next, 'utf8')
  console.log(`[install] 已更新 ${patchFile}`)
} else {
  console.log(`[install] ${patchFile} 无需改动`)
}

console.log(`
[install] 完成。接下来：

  1) 重启一次 DSH（MCP server 只在启动时加载）
  2) 验证：node scripts/selftest.mjs --config "${configPath}"
  3) 在你的插件里放行需要的工具名（见 docs/INTEGRATION.md）

本次写入：
  profile   ${profileDir}
  patch     ${patchFile}
  config    ${configPath}
  memory    ${memoryDir}
  node      ${nodePath}
`)
