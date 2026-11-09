import axios, { type AxiosInstance, type AxiosError, type InternalAxiosRequestConfig } from 'axios'
import { useAuthStore } from '@/stores/auth'
import { DEFAULT_API_BASE } from '@/constants'

// 创建 axios 实例
// 注意：不要在 headers 里设 Content-Type — 否则 axios 1.x 会保留这个默认值，
// 不会为 FormData 自动加 multipart/form-data + boundary，
// 导致 multer 解析失败（multer 找不到 boundary 就把整个 body 当成空）。
// Content-Type 应该由 axios 根据请求数据自动决定（JSON → application/json，
// FormData → multipart/form-data; boundary=xxx）。
const http: AxiosInstance = axios.create({
  baseURL: import.meta.env.VITE_API_BASE || DEFAULT_API_BASE,
  timeout: 15000
})

/**
 * 预期状态码的配置字段。
 *
 * 原则：**某个状态码算不算「错误」，由调用侧决定，不由拦截器替所有人决定。**
 * 后端用 4xx 表达的不只有故障，还有产品规则（403「先关注才能发消息」）、
 * 正常状态（游客访问 /settings 一定 401）、以及空结果（话题不存在 404）。
 * 这些都该由调用方翻译成界面语言，而不是在控制台刷一条 [API Error] ——
 * 后者既污染排查，也会把「零 console error」这条 e2e 断言弄挂。
 */
type ExpectedStatusConfig = {
  silent404?: boolean
  /** 历史标记，保留兼容：等同于 quietStatuses: [401] */
  quiet401?: boolean
  /** 预期内的拒绝：仍然 reject 让调用方处理，但不打 console.error */
  quietStatuses?: number[]
}

/** 返回 true = 这条错误不该打日志。导出成纯函数是为了能直接测。 */
export function shouldStayQuiet(config: unknown, status?: number): boolean {
  if (!status || !config || typeof config !== 'object') return false
  const c = config as ExpectedStatusConfig
  if (c.silent404 && status === 404) return true
  if (c.quiet401 && status === 401) return true
  return Array.isArray(c.quietStatuses) && c.quietStatuses.includes(status)
}

// ===== 请求拦截器：自动加 token =====
// 从 Pinia store 读 token（持久化由 pinia-plugin-persistedstate 负责）
http.interceptors.request.use(
  (config: InternalAxiosRequestConfig) => {
    const auth = useAuthStore()
    if (auth.token && config.headers) {
      config.headers.Authorization = `Bearer ${auth.token}`
    }
    return config
  },
  (error) => Promise.reject(error)
)

// ===== 响应拦截器：统一错误处理 =====
http.interceptors.response.use(
  (response) => response.data, // 直接返回 data，调用方少一层 .data
  (error: AxiosError) => {
    // 「404 是预期状态」的出口（见下方 getOrNull）：
    // 直接 resolve null，既不打控制台日志也不弹错，交给调用方渲染自己的空态。
    //
    // 注意必须在 console.error 之前判：否则「这个话题不存在」这种
    // 每次点进空白话题都会发生的事，会把控制台刷满 [API Error]，
    // 顺带把「零 console error」的 e2e 断言也弄挂。
    if ((error.config as any)?.silent404 && error.response?.status === 404) {
      return Promise.resolve(null)
    }

    // 「预期内的拒绝」出口（见上方 shouldStayQuiet）。
    //
    // 已经登记的三类：
    // - quiet401：游客访问 /settings 一定 401，而 useUserSettings 是全局加载的，
    //   游客每次开页面都会打这一发，不是故障。
    // - quietStatuses: [403]：发消息前没关注对方，后端按产品规则挡下来；
    //   useChatEntry 会弹「要不要关注」，useChat 会把服务端原话透出去。
    // - silent404：走上面那条，直接 resolve null。
    //
    // 这里仍然 reject —— 调用方需要区分「被规则挡下」和「真的挂了」，
    // 区别只在于不要往控制台刷一条不该有的 [API Error]。
    // 判据由**调用方**在 config 上声明，拦截器不猜状态码的含义。
    if (shouldStayQuiet(error.config, error.response?.status)) {
      return Promise.reject(error)
    }

    // 完整错误信息：状态码 + 后端 message + URL，方便排查
    console.error(
      '[API Error]',
      error.response?.status,
      error.config?.method?.toUpperCase(),
      error.config?.url,
      '→',
      (error.response?.data as any)?.message || error.message
    )

    // 401 = token 失效，从 store 清登录态
    if (error.response?.status === 401) {
      const auth = useAuthStore()
      auth.logout()
    }

    return Promise.reject(error)
  }
)

/**
 * 对外暴露的请求实例 —— 类型上抹掉 AxiosResponse 这层包装。
 *
 * 为什么需要：响应拦截器里 `return response.data`，运行时拿到的就是业务数据本身，
 * 但 axios 1.x 的类型不会把拦截器的返回类型传播出去，
 * 调用方拿到的静态类型仍然是 `AxiosResponse<T>`，
 * 于是 `await request.post<Foo>(...)` 被推断成 `AxiosResponse<Foo>`，
 * 读 `.foo` 字段就报 TS2339。
 *
 * 这里用一次性的类型断言把「运行时行为」和「静态类型」对齐，
 * 业务侧就不需要再写 `as unknown as Foo` 这种逃生舱了。
 */
interface UnwrappedInstance {
  get<T>(url: string, config?: Record<string, unknown>): Promise<T>
  delete<T>(url: string, config?: Record<string, unknown>): Promise<T>
  post<T>(url: string, data?: unknown, config?: Record<string, unknown>): Promise<T>
  put<T>(url: string, data?: unknown, config?: Record<string, unknown>): Promise<T>
  patch<T>(url: string, data?: unknown, config?: Record<string, unknown>): Promise<T>
  /**
   * 用于「404 是预期状态」的接口，返回 null 而不是抛错。
   *
   * 典型场景：话题页访问一个不存在的话题。手敲 URL 或者搜了个没用过的词
   * 都会命中，页面本来就要渲染自己的空态 —— 但 404 走 reject 路径会被
   * 响应拦截器当成错误，在控制台打一条 [API Error] 再 reject，
   * 于是页面拿到了一个「异常」，还顺带污染了「零 console error」的 e2e 断言。
   *
   * 实现只能靠 config 标记（silent404）走拦截器的 reject 分支：
   * 想在调用侧用 validateStatus 判断 404 是**做不到**的 ——
   * 响应拦截器已经 `return response.data` 把 AxiosResponse 解开了，
   * 调用方拿到的就是业务数据本身，status 和 data 都读不到。
   *
   * 那个 `as any` 是为了让 axios 认识自定义的 silent404 字段；
   * 字段本身只在上面的拦截器里被读一次，不影响类型安全。
   */
  getOrNull<T>(url: string, config?: Record<string, unknown>): Promise<T | null>
}

const request = http as unknown as UnwrappedInstance

request.getOrNull = <T>(url: string, config?: Record<string, unknown>): Promise<T | null> =>
  http.get(url, { ...config, silent404: true } as any) as unknown as Promise<T | null>

export default request
