import request from './request'

// ===== 类型定义 =====

export interface LoginParams {
  email: string
  password: string
}

export interface RegisterParams {
  email: string
  password: string
  nickname: string
}

export interface UserInfo {
  id: number          // 后端 SQLite INTEGER → number（不是 string）
  email: string
  nickname: string
  avatar: string | null
}

export interface LoginResponse {
  accessToken: string
  // refreshToken: 后端没实现，省略（如果以后加，先注释保留类型契约）
  userInfo: UserInfo
}

// ===== API 函数 =====

export const authApi = {
  // 登录
  login: (data: LoginParams) =>
    request.post<LoginResponse>('/auth/login', data),

  // 注册
  register: (data: RegisterParams) =>
    request.post<LoginResponse>('/auth/register', data),

  // 拿当前登录用户（需要 Bearer token）
  getCurrentUser: () => request.get<UserInfo>('/auth/me')

  // ❌ 没有 logout —— JWT 是无状态的，前端直接 store.logout() 清 token 即可
  //    App.vue 的"退出"按钮已经在用 auth.logout()
}

// 同样适用 axios v1 + TS 响应拦截器的类型断言 workaround：
// 运行时拦截器已解包 response.data，但 TS 类型不会自动传播
export async function unwrap<T>(promise: Promise<unknown>): Promise<T> {
  return (await promise) as T
}