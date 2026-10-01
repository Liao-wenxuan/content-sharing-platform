import { ref } from 'vue'

/**
 * 搜索历史（顶栏下拉 / 搜索结果页共用）
 *
 * 存 localStorage，只保留最近 10 条；重复搜索会置顶而不是追加。
 *
 * 用模块级 ref 而不是 Pinia：这就是一串字符串，够不上 store 的分量，
 * 而模块级单例天然保证「顶栏下拉删掉一条，搜索结果页里的历史也少一条」，
 * 不需要额外的同步代码。放 composables/ 是为了和 useTheme 保持同一层抽象。
 */

const STORAGE_KEY = 'sg:search-history'
const MAX_HISTORY = 10

function readStorage(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    if (!Array.isArray(parsed)) return []
    // 兜一层类型过滤：localStorage 里的东西可能被别的脚本写坏过
    return parsed.filter((x): x is string => typeof x === 'string' && x.trim() !== '')
  } catch {
    return []
  }
}

// 模块级单例：两个消费方共享同一个数组引用
const history = ref<string[]>(readStorage())

export function useSearchHistory() {
  function persist(list: string[]) {
    history.value = list
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(list))
    } catch {
      // 隐私模式 / 配额满时写不进去也不能影响搜索本身，静默降级为内存态
    }
  }

  /** 记一次搜索：去重后置顶，超出上限丢最旧的 */
  function save(keyword: string) {
    const kw = keyword.trim()
    if (!kw) return
    persist([kw, ...history.value.filter((h) => h !== kw)].slice(0, MAX_HISTORY))
  }

  function remove(keyword: string) {
    persist(history.value.filter((h) => h !== keyword))
  }

  function clear() {
    persist([])
  }

  return { history, save, remove, clear }
}
