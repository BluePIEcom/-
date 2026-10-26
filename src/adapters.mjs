// 适配器（adapter）：让"别的插件"把自己那边的近况暴露成一条可按需查询的摘要。
//
// 为什么需要它（踩过的坑）：
//   我们最初想靠"把摘要注入提示词"实现跨插件同步，结果发现 DSH 里一条消息可能走三条
//   完全不同的投递路径（定时唤醒 / 实时投递 / 长轮询工具返回）。注入改哪一条都可能漏，
//   而且代理在线等消息时（qq_wait_for_messages 这类长轮询），提示词根本不会被重建。
//   → 结论：跨插件共享不要依赖提示词注入，要提供**可按需调用的工具**。
//
// 适配器就是一个 .mjs 文件，默认导出：
//   {
//     id: 'qq',                        // 必填，字母数字下划线
//     title: 'QQ 侧近况',               // 必填，给人看的名字
//     trust: 'untrusted',              // 可选，默认 untrusted（第三方内容）
//     read: async () => '文本或多行数组' // 必填，返回摘要文本
//   }
// read() 里自己决定读哪个状态文件、怎么脱敏。本项目不替你读别人的私有状态。
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export const ADAPTER_TRUST = ['trusted', 'self', 'untrusted']

/** 从目录里加载所有适配器；单个坏文件只跳过它，不影响其它。 */
export async function loadAdapters(dir) {
  const out = []
  let entries = []
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.mjs')) continue
    const file = path.join(dir, entry.name)
    try {
      const mod = await import(pathToFileURL(file).href)
      const def = mod.default ?? mod.adapter
      if (!def || typeof def !== 'object') throw new Error('默认导出必须是对象')
      if (typeof def.id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(def.id)) throw new Error('id 非法')
      if (typeof def.read !== 'function') throw new Error('缺少 read()')
      out.push({
        id: def.id,
        title: typeof def.title === 'string' && def.title ? def.title : def.id,
        trust: ADAPTER_TRUST.includes(def.trust) ? def.trust : 'untrusted',
        read: def.read,
        file,
      })
    } catch (error) {
      out.push({ id: path.basename(entry.name, '.mjs'), title: entry.name, trust: 'untrusted', error: String(error?.message ?? error) })
    }
  }
  return out
}

/** 调一次适配器并把结果规整成文本。 */
export async function readAdapter(adapter) {
  if (adapter.error) return `（适配器 ${adapter.id} 加载失败：${adapter.error}）`
  try {
    const value = await adapter.read()
    if (Array.isArray(value)) return value.join('\n')
    return String(value ?? '')
  } catch (error) {
    return `（适配器 ${adapter.id} 读取失败：${error?.message ?? error}）`
  }
}
