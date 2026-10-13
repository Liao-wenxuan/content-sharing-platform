import request from './request'

/**
 * 收货地址
 *
 * 字段名是**驼峰**（服务端是 snake_case，转换在请求层做），
 * 和项目里其它 api 模块保持一致 —— 前端不该看到库的列名。
 */
export interface Address {
  id: number
  receiver: string
  phone: string
  province: string
  city: string
  detail: string
  isDefault: boolean
  createdAt: string
}

export interface AddressInput {
  receiver: string
  phone: string
  province: string
  city: string
  detail: string
  isDefault?: boolean
}

/** 服务端行 → 前端对象。`is_default` 的 0/1 在这里变成 true/false */
function toAddress(row: any): Address {
  return {
    id: row.id,
    receiver: row.receiver,
    phone: row.phone,
    province: row.province,
    city: row.city,
    detail: row.detail,
    isDefault: row.is_default === 1,
    createdAt: row.created_at
  }
}

export const addressesApi = {
  async list() {
    const res = await request.get<{ list: any[] }>('/addresses')
    return res.list.map(toAddress)
  },

  async create(input: AddressInput) {
    const res = await request.post<{ id: number }>('/addresses', input)
    return res.id
  },

  /** 只传要改的字段，没传的保持原值 —— 这是 PATCH 的语义 */
  async update(id: number, patch: Partial<AddressInput>) {
    await request.patch<{ ok: boolean }>(`/addresses/${id}`, patch)
  },

  async remove(id: number) {
    await request.delete<{ ok: boolean }>(`/addresses/${id}`)
  }
}

/** 一行地址的展示文本。「广东 深圳 南山区…」比分成三行更好扫 */
export function formatAddress(a: Address): string {
  return `${a.province} ${a.city} ${a.detail}`
}

/** 遮掉手机号中间四位。地址簿会被别人看到，明文显示是隐私问题 */
export function maskPhone(phone: string): string {
  if (phone.length < 7) return phone
  return `${phone.slice(0, 3)}****${phone.slice(-4)}`
}
