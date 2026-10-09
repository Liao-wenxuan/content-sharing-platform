/**
 * LoginView 组件测试
 *
 * 这个页面最该锁的是 **redirect 的开放重定向防护**：
 *
 *   if (typeof r === 'string' && r.startsWith('/') && !r.startsWith('//'))
 *
 * `//evil.com` 也是一个以 `/` 开头的字符串，浏览器会把它当成
 * 协议相对 URL 跳到外站去 —— 所以必须显式排除。只判 startsWith('/')
 * 的写法在这里是有洞的，而洞不会报错，只会在用户点完登录按钮之后
 * 把他送到钓鱼站上。这种安全判断必须单测钉死，不能靠 review 眼力。
 *
 * 其余锁表单校验和两种模式的差异（注册要多一个昵称）。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { authApi } from '@/api/auth'
import { useAuthStore } from '@/stores/auth'
import LoginView from '@/views/LoginView.vue'

vi.mock('@/api/auth', () => ({
  authApi: { login: vi.fn(), register: vi.fn() }
}))

const ElMessage = { success: vi.fn(), error: vi.fn() }
vi.mock('element-plus', () => ({
  ElMessage: {
    success: (...a: unknown[]) => ElMessage.success(...a),
    error: (...a: unknown[]) => ElMessage.error(...a)
  }
}))

const push = vi.fn()
/** route 每个用例一份
 *  resolveRedirect 读的是 route.query.redirect，
 *  用例之间改同一个对象容易互相污染 */
let route: { query: Record<string, string> }
vi.mock('vue-router', () => ({
  useRouter: () => ({ push }),
  useRoute: () => route
}))

const api = vi.mocked(authApi)

const LOGIN_OK = {
  accessToken: 'tok-123',
  userInfo: { id: 7, email: 'a@b.com', nickname: '栗子拿铁', avatar: null }
}

const stubs = {
  'el-card': { template: '<section><slot name="header" /><slot /></section>' },
  'el-segmented': {
    props: ['modelValue', 'options'],
    template:
      '<div class="seg-stub"><button v-for="o in options" :key="o.value" class="seg-item" :data-v="o.value" @click="$emit(\'update:modelValue\', o.value)">{{ o.label }}</button></div>',
    emits: ['update:modelValue']
  },
  'el-form': { template: '<form @submit.prevent="$emit(\'submit\')"><slot /></form>' },
  'el-form-item': { template: '<div class="fi-stub"><slot /></div>' },
  'el-input': {
    // size 必须声明成 prop：不声明的话它会作为 fallthrough 属性落到根元素上，
    // jsdom 直接抛 "Failed setting prop size on <input>"，把测试输出刷爆
    props: ['modelValue', 'type', 'placeholder', 'size', 'prefixIcon', 'showPassword'],
    emits: ['update:modelValue', 'keyup'],
    template:
      '<input class="input-stub" :type="type === \'password\' ? \'password\' : \'text\'" :placeholder="placeholder" :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />'
  },
  'el-alert': { props: ['title'], template: '<div class="alert-stub">{{ title }}</div>' },
  'el-button': {
    emits: ['click'],
    template: '<button class="submit-btn-stub" @click="$emit(\'click\')"><slot /></button>'
  },
  'el-icon': { template: '<span />' }
}

const mounted: ReturnType<typeof mount>[] = []

function mountView() {
  const w = mount(LoginView, { global: { stubs } })
  mounted.push(w)
  return w
}

/**
 * 按 placeholder 找输入框：顺序会变（注册模式多一个昵称），位置不可靠。
 * 用 class 选而不是标签名 —— stub 渲染出来的是 `<input class="input-stub">`，
 * 写 `findAll('input-stub')` 当标签名找会一个都找不到。
 */
function inputByPlaceholder(w: ReturnType<typeof mountView>, ph: string) {
  return w.findAll('.input-stub').find((i) => i.attributes('placeholder') === ph)!
}

async function fill(w: ReturnType<typeof mountView>, ph: string, val: string) {
  await inputByPlaceholder(w, ph).setValue(val)
}

beforeEach(() => {
  const pinia = createPinia()
  setActivePinia(pinia)
  vi.clearAllMocks()
  route = { query: {} }
  api.login.mockResolvedValue(LOGIN_OK as any)
})

afterEach(() => {
  while (mounted.length) mounted.pop()!.unmount()
})

describe('LoginView 表单校验', () => {
  it('什么都不填就点提交：不发请求，给提示', async () => {
    const w = mountView()
    await w.find('.submit-btn-stub').trigger('click')
    await flushPromises()

    expect(api.login).not.toHaveBeenCalled()
    expect(w.find('.alert-stub').text()).toBe('请输入邮箱和密码')
  })

  it('只填邮箱没填密码：仍然不发请求', async () => {
    const w = mountView()
    await fill(w, 'you@example.com', 'a@b.com')
    await w.find('.submit-btn-stub').trigger('click')
    await flushPromises()

    expect(api.login).not.toHaveBeenCalled()
    expect(w.find('.alert-stub').text()).toBe('请输入邮箱和密码')
  })

  it('注册模式必须填昵称', async () => {
    const w = mountView()
    await w.findAll('.seg-item')[1].trigger('click')
    await fill(w, 'you@example.com', 'a@b.com')
    await fill(w, '请输入密码', 'secret123')
    await w.find('.submit-btn-stub').trigger('click')
    await flushPromises()

    expect(api.register).not.toHaveBeenCalled()
    expect(w.find('.alert-stub').text()).toBe('请输入昵称')
  })
})

describe('LoginView 提交', () => {
  it('登录成功后写进 auth store 并跳首页', async () => {
    const w = mountView()
    await fill(w, 'you@example.com', 'a@b.com')
    await fill(w, '请输入密码', 'secret123')
    await w.find('.submit-btn-stub').trigger('click')
    await flushPromises()

    expect(api.login).toHaveBeenCalledWith({ email: 'a@b.com', password: 'secret123' })
    expect(api.register).not.toHaveBeenCalled()
    expect(useAuthStore().isLoggedIn).toBe(true)
    expect(ElMessage.success).toHaveBeenCalledWith('欢迎回来，栗子拿铁')
    expect(push).toHaveBeenCalledWith('/')
  })

  it('注册时带上昵称', async () => {
    api.register.mockResolvedValue(LOGIN_OK as any)
    const w = mountView()
    await w.findAll('.seg-item')[1].trigger('click')
    await fill(w, '给自己起个名字', '新人')
    await fill(w, 'you@example.com', 'a@b.com')
    await fill(w, '请输入密码', 'secret123')
    await w.find('.submit-btn-stub').trigger('click')
    await flushPromises()

    expect(api.register).toHaveBeenCalledWith({
      email: 'a@b.com',
      password: 'secret123',
      nickname: '新人'
    })
    expect(ElMessage.success).toHaveBeenCalledWith('注册成功，欢迎加入')
  })

  it('接口失败时展示后端给的原因，并且不跳转', async () => {
    api.login.mockRejectedValue({ response: { data: { message: '邮箱或密码不正确' } } })
    const w = mountView()
    await fill(w, 'you@example.com', 'a@b.com')
    await fill(w, '请输入密码', 'wrong')
    await w.find('.submit-btn-stub').trigger('click')
    await flushPromises()

    expect(w.find('.alert-stub').text()).toBe('邮箱或密码不正确')
    expect(push).not.toHaveBeenCalled()
    expect(useAuthStore().isLoggedIn).toBe(false)
  })

  it('网络层就挂了也要有人话提示，不能是空白', async () => {
    api.login.mockRejectedValue(new Error('Network Error'))
    const w = mountView()
    await fill(w, 'you@example.com', 'a@b.com')
    await fill(w, '请输入密码', 'x')
    await w.find('.submit-btn-stub').trigger('click')
    await flushPromises()

    expect(w.find('.alert-stub').text()).toContain('请检查后端是否启动')
  })
})

describe('LoginView 登录后跳转到哪（开放重定向防护）', () => {
  async function submitWithRedirect(q: string) {
    route.query = q ? { redirect: q } : {}
    const w = mountView()
    await fill(w, 'you@example.com', 'a@b.com')
    await fill(w, '请输入密码', 'secret123')
    await w.find('.submit-btn-stub').trigger('click')
    await flushPromises()
    return w
  }

  it('站内路径照跳', async () => {
    await submitWithRedirect('/favorites')
    expect(push).toHaveBeenCalledWith('/favorites')
  })

  it('带 query 的站内路径也照跳', async () => {
    await submitWithRedirect('/search?q=%E7%BE%8E%E9%A3%9F')
    expect(push).toHaveBeenCalledWith('/search?q=%E7%BE%8E%E9%A3%9F')
  })

  it('//evil.com 是协议相对 URL，必须被挡掉 —— 这是这个文件存在的理由', async () => {
    await submitWithRedirect('//evil.com/steal')
    expect(push).toHaveBeenCalledWith('/')
    expect(push).not.toHaveBeenCalledWith('//evil.com/steal')
  })

  it('绝对外站 URL 被挡掉', async () => {
    await submitWithRedirect('https://evil.com/steal')
    expect(push).toHaveBeenCalledWith('/')
  })

  it('相对路径（不以 / 开头）被挡掉', async () => {
    await submitWithRedirect('evil.com')
    expect(push).toHaveBeenCalledWith('/')
  })

  it('没有 redirect 时回首页', async () => {
    await submitWithRedirect('')
    expect(push).toHaveBeenCalledWith('/')
  })
})
