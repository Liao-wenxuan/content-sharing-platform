import axios, { type AxiosInstance, type AxiosError, type InternalAxiosRequestConfig } from 'axios'
import { useAuthStore } from '@/stores/auth'

// 创建 axios 实例
// 注意：不要在 headers 里设 Content-Type — 否则 axios 1.x 会保留这个默认值，
// 不会为 FormData 自动加 multipart/form-data + boundary，
// 导致 multer 解析失败（multer 找不到 boundary 就把整个 body 当成空）。
// Content-Type 应该由 axios 根据请求数据自动决定（JSON → application/json，
// FormData → multipart/form-data; boundary=xxx）。
const http: AxiosInstance = axios.create({
  baseURL: import.meta.env.VITE_API_BASE || 'http://localhost:3000/api',
  timeout: 15000
})

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
}

const request = http as unknown as UnwrappedInstance

export default request
