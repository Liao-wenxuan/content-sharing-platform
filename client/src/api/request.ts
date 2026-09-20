import axios, { type AxiosInstance, type AxiosError, type InternalAxiosRequestConfig } from 'axios'
import { useAuthStore } from '@/stores/auth'

// 创建 axios 实例
const request: AxiosInstance = axios.create({
  baseURL: import.meta.env.VITE_API_BASE || 'http://localhost:3000/api',
  timeout: 15000,
  headers: { 'Content-Type': 'application/json' },
})

// ===== 请求拦截器：自动加 token =====
// 从 Pinia store 读 token（持久化由 pinia-plugin-persistedstate 负责）
request.interceptors.request.use(
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
request.interceptors.response.use(
  (response) => response.data,  // 直接返回 data，调用方少一层 .data
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

export default request
