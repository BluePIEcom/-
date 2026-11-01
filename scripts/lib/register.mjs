// 注册逻辑的唯一实现：把 shared-memory MCP 写进某个 DSH profile。
//
// 为什么单独抽出来：install.mjs（开发者/已下载仓库的人用）和 install-wizard.mjs
// （拿到安装包的人用）必须写出一模一样的区块，否则同一台机器上装两次会出现两个
// mcp-shared-memory 条目。两处各写一份逻辑就是漂移的开始。
import fs from 'node:fs'
import path from 'node:path'

export const MCP_ID = 'mcp-shared-memory'
export const SERVER_NAME = 'shared-memory'
export const BEGIN = '# === dsh-reef BEGIN ==='
export const END = '# === dsh-reef END ==='

const q = (s) => `'${String(s).replace(/'/g, "''")}'`

/** 生成要插入的 YAML 区块。 */
export function buildPatchBlock({ nodePath, serverPath, configPath }) {
  return [
    BEGIN,
    '# 由 dsh-reef 的安装脚本维护；整段会被替换，请勿手改区块内部。',
    '- insert:',
    `    - id: ${MCP_ID}`,
    "      name: '@deepseek-ai/dsh-mcp-client'",
    '      config:',
    `        serverName: ${SERVER_NAME}`,
    '        transport: stdio',
    `        command: ${q(nodePath)}`,
    '        args:',
    `          - ${q(serverPath)}`,
    '          - --config',
    `          - ${q(configPath)}`,
    END,
  ].join('\n')
}

/** 把区块写进 profile 的 cordis.patch.yml（幂等；块外内容一个字节不动）。 */
export function writeMcpRegistration({ dshHome, profile, nodePath, serverPath, configPath }) {
  const profileDir = path.join(dshHome, 'profiles', profile)
  const patchFile = path.join(profileDir, 'cordis.patch.yml')
  if (!fs.existsSync(profileDir)) {
    throw new Error(`profile 不存在：${profileDir}\n先启动一次 DSH（它会初始化这个 profile），再重试。`)
  }

  const block = buildPatchBlock({ nodePath, serverPath, configPath })
  const original = fs.existsSync(patchFile) ? fs.readFileSync(patchFile, 'utf8').replace(/^\uFEFF/, '') : ''
  const b = original.indexOf(BEGIN)
  const e = original.indexOf(END)

  let next
  if (b >= 0 && e > b) {
    next = original.slice(0, b) + block + original.slice(e + END.length)
  } else {
    // 兼容 profile 根层的空 `[]`（它和块条目同在根层会让 YAML 非法）
    let base = original
    const lines = base.split(/\r?\n/)
    const firstIdx = lines.findIndex((line) => line.trim() && !line.trimStart().startsWith('#'))
    if (firstIdx >= 0 && lines[firstIdx].trim() === '[]' && lines.slice(firstIdx + 1).some((line) => /^-\s/.test(line))) {
      lines.splice(firstIdx, 1)
      base = lines.join('\n')
    }
    next = base.trimEnd() ? `${base.trimEnd()}\n\n${block}\n` : `${block}\n`
  }

  if (next === original) return { changed: false, patchFile }

  let backup = null
  if (original) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    backup = `${patchFile}.bak-${stamp}`
    fs.copyFileSync(patchFile, backup)
  }
  fs.mkdirSync(path.dirname(patchFile), { recursive: true })
  fs.writeFileSync(patchFile, next, 'utf8')
  return { changed: true, patchFile, backup }
}

/** 建记忆目录并写种子文件（已存在则绝不覆盖）。 */
export function seedChannels({ memoryDir, channels, adaptersDir = 'adapters' }) {
  fs.mkdirSync(memoryDir, { recursive: true })
  fs.mkdirSync(path.join(memoryDir, adaptersDir), { recursive: true })
  const created = []
  for (const c of channels ?? []) {
    if (!c?.file) continue
    const p = path.join(memoryDir, c.file)
    if (fs.existsSync(p)) continue
    const hint = c.trust === 'trusted'
      ? `# ${c.title ?? c.file}\n\n（这个文件由人维护：写下你希望所有 agent 都遵守的事实与规矩。）`
      : `# ${c.title ?? c.file}\n\n（还没写过。agent 会在需要时往这里追加。）`
    fs.writeFileSync(p, hint.trimEnd() + '\n', 'utf8')
    created.push(c.file)
  }
  return { memoryDir, created }
}
