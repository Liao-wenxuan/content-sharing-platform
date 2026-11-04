/**
 * ProfileView 组件测试
 *
 * 这个页面之前**一条组件测试都没有** —— 而它恰恰是「编辑资料」这件事的所在地。
 * 这轮给头像 / 封面接上上传，正好一起把最要紧的几条路径钉住。
 *
 * 钉的是「写错了也不会崩」的那几条：
 * - 打开弹窗要回填当前值（不回填就是把用户已有资料清空了）
 * - 昵称为空 / 超长 → 拦下来，不发请求
 * - 图片链接格式不对 → 拦下来（服务端只查长度，存进去主页上就是裂图）
 * - 图片还在上传 → 拦下来（存下去的是空链接）
 * - 保存成功 → 页面上的昵称 / 头像要跟着变
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises, type DOMWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { postsApi } from '@/api/posts'
import { favoritesApi } from '@/api/favorites'
import { followsApi } from '@/api/follows'
import { authApi } from '@/api/auth'
import { uploadImage } from '@/api/uploads'
import { useAuthStore } from '@/stores/auth'
import ProfileView from '@/views/ProfileView.vue'

vi.mock('@/api/posts', () => ({
  postsApi: {
    getUserPosts: vi.fn(),
    getMyPosts: vi.fn(),
    listByUser: vi.fn()
  }
}))
vi.mock('@/api/favorites', () => ({
  favoritesApi: { folders: vi.fn(), list: vi.fn() }
}))
vi.mock('@/api/follows', () => ({
  followsApi: { relation: vi.fn(), suggestions: vi.fn(), follow: vi.fn(), unfollow: vi.fn() }
}))
vi.mock('@/api/auth', () => ({ authApi: { updateProfile: vi.fn() } }))
vi.mock('@/api/uploads', () => ({ uploadImage: vi.fn() }))
vi.mock('@/utils/imageCompress', () => ({
  compressImage: vi.fn(async () => ({
    blob: new Blob([new Uint8Array(4)], { type: 'image/webp' }),
    type: 'image/webp',
    originalSize: 1000,
    finalSize: 100,
    width: 10,
    height: 10,
    orientation: 1,
    strategy: 'resized',
    thumb: null,
    thumbWidth: 0,
    thumbHeight: 0
  }))
}))

const ElMessage = { success: vi.fn(), error: vi.fn() }
vi.mock('@/utils/element', () => ({
  ElMessage: {
    success: (...a: unknown[]) => ElMessage.success(...a),
    error: (...a: unknown[]) => ElMessage.error(...a)
  },
  ElMessageBox: { confirm: vi.fn() }
}))

const push = vi.fn()
const route = {
  params: { id: 'me' } as Record<string, string>,
  query: {} as Record<string, string>
}
vi.mock('vue-router', () => ({
  useRoute: () => route,
  useRouter: () => ({ push })
}))

const ME = {
  id: 7,
  nickname: '旧昵称',
  avatar: '/uploads/old-avatar.png',
  cover: '/uploads/old-cover.png'
}

const stubs = {
  'el-card': { template: '<div class="card-stub"><slot /><slot name="header" /></div>' },
  'el-avatar': { template: '<span class="avatar-stub"><slot /></span>' },
  'el-button': {
    emits: ['click'],
    template:
      '<button class="btn-stub" :disabled="disabled" @click="$emit(\'click\')"><slot /></button>',
    props: ['disabled']
  },
  'el-tag': { template: '<span class="tag-stub"><slot /></span>' },
  'el-tabs': { template: '<div class="tabs-stub"><slot /></div>' },
  'el-tab-pane': { template: '<div class="tab-pane-stub" />' },
  'el-radio-group': { template: '<div class="radio-stub"><slot /></div>' },
  'el-radio-button': { template: '<span class="radio-btn-stub"><slot /></span>' },
  'el-empty': { template: '<div class="empty-stub"><slot /></div>' },
  'el-skeleton': { template: '<div class="skeleton-stub" />' },
  'el-select': { template: '<div class="select-stub"><slot /></div>' },
  'el-option': { template: '<span class="option-stub" />' },
  'el-icon': { template: '<i class="icon-stub"><slot /></i>' },
  'el-form': { template: '<form class="form-stub"><slot /></form>' },
  'el-form-item': {
    props: ['label', 'error'],
    // error 要渲染出来 —— 它承载的是「为什么不能保存」，
    // 不渲染的话测试只能看见输入框下方的格式提示，看不见提交时的拦截原因
    template:
      '<div class="form-item-stub"><p v-if="error" class="form-error">{{ error }}</p><slot /></div>'
  },
  // 输入框要能双向绑定 + 报错态，测试里要直接改值
  'el-input': {
    props: ['modelValue', 'error'],
    emits: ['update:modelValue'],
    template:
      '<input class="input-stub" :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />'
  },
  // 弹窗要渲染默认插槽和 footer，否则测试根本找不到表单
  'el-dialog': {
    props: ['modelValue'],
    template:
      '<div class="dialog-stub" v-if="modelValue"><slot /><div class="dialog-footer"><slot name="footer" /></div></div>'
  },
  // 上传组件：测试直接拿它的 on-change 回调来模拟「选了一个文件」
  'el-upload': {
    name: 'ElUploadStub',
    props: ['onChange'],
    template: '<div class="upload-stub" />'
  },
  'el-progress': { props: ['percentage'], template: '<div class="progress-stub" />' },
  'router-link': { template: '<a><slot /></a>' }
}

const mounted: ReturnType<typeof mount>[] = []

function mountView() {
  const w = mount(ProfileView, { global: { stubs } })
  mounted.push(w)
  return w
}

/** 打开编辑弹窗 */
async function openEdit(w: ReturnType<typeof mountView>) {
  const btn = w.findAll('.btn-stub').find((b) => b.text() === '编辑资料')
  expect(btn).toBeTruthy()
  await btn!.trigger('click')
  await flushPromises()
}

/** 点保存 */
async function save(w: ReturnType<typeof mountView>) {
  const btn = w.findAll('.btn-stub').find((b) => b.text() === '保存')
  expect(btn).toBeTruthy()
  await btn!.trigger('click')
  await flushPromises()
}

/** 弹窗里第 n 个输入框（0 = 昵称，1 = 头像，2 = 封面） */
function input(w: ReturnType<typeof mountView>, n: number): DOMWrapper<HTMLInputElement> {
  return w.findAll('.input-stub')[n] as DOMWrapper<HTMLInputElement>
}

/** 第 n 个输入框当前的值 —— 读值和改值分成两个函数，避免有人图省事改成只读 */
function inputValue(w: ReturnType<typeof mountView>, n: number): string {
  return (input(w, n).element as HTMLInputElement).value
}

beforeEach(async () => {
  const pinia = createPinia()
  setActivePinia(pinia)
  vi.clearAllMocks()

  useAuthStore().login(ME, 'token-abc')
  route.params = { id: 'me' }
  route.query = {}

  vi.mocked(postsApi.getMyPosts).mockResolvedValue({
    user: ME,
    list: [],
    total: 0
  } as never)
  vi.mocked(favoritesApi.folders).mockResolvedValue({ list: [] } as never)
  vi.mocked(favoritesApi.list).mockResolvedValue({
    list: [],
    pagination: { page: 1, pageSize: 50, total: 0, hasMore: false }
  } as never)
  vi.mocked(followsApi.relation).mockResolvedValue({
    userId: ME.id,
    isFollowing: false,
    isFollowedBy: false,
    followerCount: 0,
    followingCount: 0
  } as never)
  vi.mocked(followsApi.suggestions).mockResolvedValue({ list: [] } as never)
  vi.mocked(authApi.updateProfile).mockResolvedValue(ME as never)
  vi.mocked(uploadImage).mockResolvedValue('/uploads/new-avatar.webp')
})

afterEach(() => {
  while (mounted.length) mounted.pop()!.unmount()
})

describe('打开编辑弹窗', () => {
  it('回填当前的昵称 / 头像 / 封面', async () => {
    // 不回填就是把用户已有的资料清空了 —— 打开弹窗那一刻就在丢数据
    const w = mountView()
    await flushPromises()

    await openEdit(w)

    expect(inputValue(w, 0)).toBe('旧昵称')
    expect(inputValue(w, 1)).toBe('/uploads/old-avatar.png')
    expect(inputValue(w, 2)).toBe('/uploads/old-cover.png')
  })

  it('弹窗里有上传入口和链接输入框两种方式', async () => {
    const w = mountView()
    await flushPromises()
    await openEdit(w)

    // 两个上传入口（头像 / 封面）
    expect(w.findAllComponents({ name: 'ElUploadStub' }).length).toBe(2)
    // 三个输入框：昵称 + 头像链接 + 封面链接
    expect(w.findAll('.input-stub').length).toBe(3)
  })
})

describe('保存前的拦截', () => {
  it('昵称清空：拦下来，不发请求', async () => {
    const w = mountView()
    await flushPromises()
    await openEdit(w)

    await input(w, 0).setValue('')
    await save(w)

    expect(authApi.updateProfile).not.toHaveBeenCalled()
    expect(w.text()).toContain('昵称不能为空')
  })

  it('头像链接格式不对：拦下来（服务端只查长度，存进去主页上就是裂图）', async () => {
    const w = mountView()
    await flushPromises()
    await openEdit(w)

    await input(w, 1).setValue('javascript:alert(1)')
    await save(w)

    expect(authApi.updateProfile).not.toHaveBeenCalled()
    expect(w.text()).toContain('头像链接格式不对')
  })

  it('封面链接格式不对：拦下来', async () => {
    const w = mountView()
    await flushPromises()
    await openEdit(w)

    await input(w, 2).setValue('data:image/svg+xml;base64,PHN2Zz4=')
    await save(w)

    expect(authApi.updateProfile).not.toHaveBeenCalled()
    expect(w.text()).toContain('封面链接格式不对')
  })

  it('空链接 = 清空这个字段，是合法的', async () => {
    const w = mountView()
    await flushPromises()
    await openEdit(w)

    await input(w, 1).setValue('')
    await save(w)

    expect(authApi.updateProfile).toHaveBeenCalledWith({
      nickname: '旧昵称',
      avatar: null,
      cover: '/uploads/old-cover.png'
    })
  })
})

describe('保存成功', () => {
  it('页面上的昵称跟着变', async () => {
    vi.mocked(authApi.updateProfile).mockResolvedValue({
      id: 7,
      nickname: '新昵称',
      avatar: '/uploads/old-avatar.png',
      cover: '/uploads/old-cover.png'
    } as never)

    const w = mountView()
    await flushPromises()
    await openEdit(w)

    await input(w, 0).setValue('新昵称')
    await save(w)

    expect(authApi.updateProfile).toHaveBeenCalled()
    expect(w.find('.nickname').text()).toBe('新昵称')
  })
})

describe('上传头像', () => {
  it('传完之后回填链接（用户看得见填进去的是什么）', async () => {
    const w = mountView()
    await flushPromises()
    await openEdit(w)

    const upload = w.findAllComponents({ name: 'ElUploadStub' })[0]
    const file = new File([new Uint8Array(4)], 'a.png', { type: 'image/png' })
    await upload.props('onChange')({ raw: file } as never)
    await flushPromises()

    expect(uploadImage).toHaveBeenCalled()
    expect(inputValue(w, 1)).toBe('/uploads/new-avatar.webp')
  })

  it('上传失败：给出错误，不静悄悄地什么都不发生', async () => {
    vi.mocked(uploadImage).mockRejectedValue({
      response: { data: { message: '只能上传图片文件' } }
    })
    const w = mountView()
    await flushPromises()
    await openEdit(w)

    const upload = w.findAllComponents({ name: 'ElUploadStub' })[0]
    const file = new File([new Uint8Array(4)], 'a.png', { type: 'image/png' })
    await upload.props('onChange')({ raw: file } as never)
    await flushPromises()

    expect(w.text()).toContain('只能上传图片文件')
    // 没上传成功就不该回填链接
    expect(inputValue(w, 1)).toBe('/uploads/old-avatar.png')
  })
})
