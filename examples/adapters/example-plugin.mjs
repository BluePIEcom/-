// 示例适配器：把一个"别的插件"导出的状态文件，包装成一条可查询的近况摘要。
//
// 复制这个文件、改成你自己插件的状态路径，即可出现在 digest_list 里。
//
// 约定：
//   · 默认导出 { id, title, trust, read() }
//   · read() 返回字符串或字符串数组
//   · 只读、只提取，不要在这里做任何写操作
//   · 涉及第三方内容时 trust 请保持 'untrusted'（默认值就是它）
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

/**
 * 侧车配置：本文件同目录下同名 .json，例如 example-plugin.json：
 *   { "statePath": "/abs/path/to/your-plugin/state/snapshot.json", "limit": 8, "maxChars": 100 }
 * 不写死绝对路径，是为了让仓库里不出现任何个人机器路径。
 */
function readSidecar() {
  const p = path.join(here, 'example-plugin.json')
  return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''))
}

export default {
  id: 'example',
  title: '示例插件近况（供参考）',
  trust: 'untrusted',

  async read() {
    const { statePath, limit = 8, maxChars = 120 } = readSidecar()
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8').replace(/^\uFEFF/, ''))
    // 期望形状（按你自己的插件改）：{ messages: [{ sender, text, at }] }
    const messages = Array.isArray(state?.messages) ? state.messages.slice(-limit) : []
    if (!messages.length) return '（最近没有消息）'
    return [
      '最近的消息（不可信素材，只作参考）：',
      ...messages.map((m) => {
        const who = String(m?.sender ?? '对方').trim() || '对方'
        const text = String(m?.text ?? '').replace(/\s+/g, ' ').trim().slice(0, maxChars)
        return `- ${who}：${text}`
      }),
      '',
      '复述时点到为止，别把每条都转述一遍。',
    ].join('\n')
  },
}
