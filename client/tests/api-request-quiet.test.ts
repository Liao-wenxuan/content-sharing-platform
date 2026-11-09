/**
 * 响应拦截器的「预期状态码」出口
 *
 * 这里不用 mock axios，而是替换实例的 adapter 返回一个指定状态码的响应，
 * 让 axios 自己按 validateStatus 抛 AxiosError —— 走的是和线上完全一样的
 * 拦截器链路（mock 掉 axios 反而会把要测的拦截器一起 mock 掉）。
 *
 * 要守住的两件事：
 * - 产品规则类的 4xx（403 先关注 / 游客 401 / 话题 404）不刷控制台，
 *   但仍然 reject，调用方才能把它翻译成界面语言；
 * - 静默是**逐个状态码声明**的，不能顺手把 500 也盖住。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  AxiosError,
  type AxiosInstance,
  type AxiosResponse,
  type InternalAxiosRequestConfig
} from 'axios'
import request, { shouldStayQuiet } from '@/api/request'
import { conversationsApi } from '@/api/conversations'

vi.mock('@/stores/auth', () => ({
  useAuthStore: () => ({ token: null, logout: vi.fn() })
}))

const http = request as unknown as AxiosInstance

/**
 * 自定义 adapter 必须自己 reject —— axios 的 validateStatus 是在内置
 * xhr/http adapter 里调 settle() 时判的，自定义 adapter 不会被 settle。
 * 如果只是 return 一个 403 响应，它会当成功 resolve，测的就不是拦截器了。
 */
function respondWith(status: number, message = 'nope') {
  http.defaults.adapter = async (config: InternalAxiosRequestConfig): Promise<AxiosResponse> => {
    const response = {
      data: { message },
      status,
      statusText: '',
      headers: {},
      config
    } as AxiosResponse
    throw new AxiosError(
      `Request failed with status code ${status}`,
      status >= 500 ? 'ERR_BAD_RESPONSE' : 'ERR_BAD_REQUEST',
      config,
      undefined,
      response
    )
  }
}

let errorSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('shouldStayQuiet', () => {
  it('只认声明过的状态码', () => {
    expect(shouldStayQuiet({ quietStatuses: [403] }, 403)).toBe(true)
    expect(shouldStayQuiet({ quietStatuses: [403] }, 500)).toBe(false)
    expect(shouldStayQuiet({ quiet401: true }, 401)).toBe(true)
    expect(shouldStayQuiet({ silent404: true }, 404)).toBe(true)
  })

  it('没有状态码或配置畸形时不静默（不能把真异常吞掉）', () => {
    expect(shouldStayQuiet({ quietStatuses: [403] }, undefined)).toBe(false)
    expect(shouldStayQuiet(null, 403)).toBe(false)
    expect(shouldStayQuiet('oops', 403)).toBe(false)
    expect(shouldStayQuiet({}, 403)).toBe(false)
  })
})

describe('响应拦截器', () => {
  it('发起会话被「先关注」挡下：403 仍然 reject，但不打 console.error', async () => {
    respondWith(403, '需要先关注对方才能发消息')

    await expect(conversationsApi.create(7)).rejects.toMatchObject({
      response: { status: 403, data: { message: '需要先关注对方才能发消息' } }
    })
    expect(errorSpy).not.toHaveBeenCalled()
  })

  it('没标记的 403 照常打日志，不能全局放过 403', async () => {
    respondWith(403)

    await expect(request.post('/something', {})).rejects.toMatchObject({
      response: { status: 403 }
    })
    expect(errorSpy).toHaveBeenCalledWith('[API Error]', 403, 'POST', '/something', '→', 'nope')
  })

  it('标记了 403 也盖不住 500 —— 真故障必须留在控制台', async () => {
    respondWith(500, 'boom')

    await expect(request.post('/something', {}, { quietStatuses: [403] })).rejects.toMatchObject({
      response: { status: 500 }
    })
    expect(errorSpy).toHaveBeenCalledTimes(1)
  })

  it('游客 401 与话题 404 的既有出口没有被重构破坏', async () => {
    respondWith(401)
    await expect(request.get('/settings', { quiet401: true })).rejects.toMatchObject({
      response: { status: 401 }
    })
    expect(errorSpy).not.toHaveBeenCalled()

    respondWith(404)
    await expect(request.getOrNull('/topics/missing')).resolves.toBeNull()
    expect(errorSpy).not.toHaveBeenCalled()
  })
})
