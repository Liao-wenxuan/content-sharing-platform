import request from './request'

/**
 * 多账号 / 切换账号
 *
 * ⚠️ 列表接口**不带 token**（服务端返回的也只有昵称和头像）。
 * 而「切到某个号」要走标准的登录接口重新换一个 token ——
 * 因为服务端只存了 token 的哈希，拿到哈希算不出原凭据。
 * 这么设计是为了让「数据库泄漏」不等于「账号被接管」。
 */
export interface DeviceAccount {
  id: number
  nickname: string
  avatar: string | null
  lastUsedAt: string
}

export const accountsApi = {
  /** 这台设备登录过哪些号。**不需要登录态** */
  async list() {
    const res = await request.get<{ list: DeviceAccount[] }>('/accounts')
    return res.list
  },

  /**
   * 从这台设备移除某个号。
   *
   * 要密码：否则任何人都能清别人的列表，
   * 而这个接口的作用本来就是「忘掉一个账号」。
   */
  async remove(id: number, password: string) {
    await request.delete<{ ok: boolean }>(`/accounts/${id}`, { password })
  }
}
