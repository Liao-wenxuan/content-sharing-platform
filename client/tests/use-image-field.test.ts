/**
 * useImageField：头像 / 封面这类「一个图片字段」的上传流程
 *
 * 这个 composable 存在的理由是**顺序**：压缩必须在前，上传在后。
 * 手机拍一张照片 3~5MB，而头像在主页上只显示 72px ——
 * 原样上传就是为了一张 72px 的图传 5MB。
 *
 * 三条边界必须钉死：
 * - 非图片 / 超大文件**在压缩之前**就拒掉（别白压一次）
 * - 压缩失败**不能阻断上传**（拿不到小图总比传不上去好）
 * - 上传失败要有能给人看的话，不能静悄悄地什么都不发生
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { uploadImage } from '@/api/uploads'
import { compressImage } from '@/utils/imageCompress'
import { useImageField } from '@/composables/useImageField'

vi.mock('@/api/uploads', () => ({ uploadImage: vi.fn() }))
vi.mock('@/utils/imageCompress', () => ({ compressImage: vi.fn() }))

const MAX = 10 * 1024 * 1024

function makeFile(name = 'a.png', type = 'image/png', size = 1024) {
  const file = new File([new Uint8Array(1)], name, { type })
  // 造一个指定大小的 File（构造器给的 size 是 1）
  Object.defineProperty(file, 'size', { value: size })
  return file
}

/** compressImage 的返回形状（只需要这几个字段） */
function fakeCompression(type = 'image/webp') {
  return {
    blob: new Blob([new Uint8Array(8)], { type }),
    type,
    originalSize: 1024,
    finalSize: 256,
    width: 100,
    height: 100,
    orientation: 1,
    strategy: 'resized',
    thumb: null,
    thumbWidth: 0,
    thumbHeight: 0
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(compressImage).mockResolvedValue(fakeCompression() as never)
  vi.mocked(uploadImage).mockResolvedValue('/uploads/1755-abc.webp')
})

describe('文件校验', () => {
  it('不是图片：直接拒，连压缩都不做', async () => {
    const field = useImageField({ maxEdge: 400, quality: 0.85, label: '头像' })

    const url = await field.upload(makeFile('a.txt', 'text/plain'))

    expect(url).toBeNull()
    expect(field.error.value).toBe('只能上传图片文件')
    expect(compressImage).not.toHaveBeenCalled()
    expect(uploadImage).not.toHaveBeenCalled()
  })

  it('超过 10MB：直接拒（压缩之前就拒，别白压一次）', async () => {
    const field = useImageField({ maxEdge: 400, quality: 0.85, label: '头像' })

    const url = await field.upload(makeFile('big.png', 'image/png', MAX + 1))

    expect(url).toBeNull()
    expect(field.error.value).toContain('10 MB')
    expect(compressImage).not.toHaveBeenCalled()
    expect(uploadImage).not.toHaveBeenCalled()
  })
})

describe('压缩 → 上传', () => {
  it('按给的参数压缩，上传压缩后的东西', async () => {
    const field = useImageField({ maxEdge: 400, quality: 0.85, label: '头像' })
    const original = makeFile()

    const url = await field.upload(original)

    expect(compressImage).toHaveBeenCalledWith(expect.any(File), {
      maxEdge: 400,
      quality: 0.85
    })
    // 上传的不是原图那个 File，而是压缩后按新类型重造的一个
    const uploaded = vi.mocked(uploadImage).mock.calls[0][0]
    expect(uploaded).not.toBe(original)
    expect(uploaded.type).toBe('image/webp')
    expect(url).toBe('/uploads/1755-abc.webp')
    expect(field.error.value).toBe('')
  })

  it('压缩失败也不能阻断上传：拿原图继续传', async () => {
    vi.mocked(compressImage).mockRejectedValue(new Error('canvas 炸了'))
    const field = useImageField({ maxEdge: 400, quality: 0.85, label: '头像' })

    const url = await field.upload(makeFile())

    expect(url).toBe('/uploads/1755-abc.webp')
    expect(uploadImage).toHaveBeenCalledTimes(1)
  })

  it('上传进度要能报出去（不然用户不知道卡在哪）', async () => {
    vi.mocked(uploadImage).mockImplementation(async (_f, onProgress) => {
      onProgress?.(42)
      onProgress?.(100)
      return '/uploads/x.webp'
    })
    const field = useImageField({ maxEdge: 400, quality: 0.85, label: '头像' })

    await field.upload(makeFile())

    expect(field.progress.value).toBe(100)
  })

  it('上传失败：给出能看懂的错误，不静悄悄地什么都不发生', async () => {
    vi.mocked(uploadImage).mockRejectedValue({
      response: { data: { message: '只能上传图片文件' } }
    })
    const field = useImageField({ maxEdge: 400, quality: 0.85, label: '头像' })

    const url = await field.upload(makeFile())

    expect(url).toBeNull()
    expect(field.error.value).toBe('只能上传图片文件')
  })

  it('上传失败且后端没给原因：退回带字段名的兜底文案', async () => {
    vi.mocked(uploadImage).mockRejectedValue(new Error('network'))
    const field = useImageField({ maxEdge: 1600, quality: 0.82, label: '封面' })

    await field.upload(makeFile())

    expect(field.error.value).toBe('封面上传失败')
  })

  it('上传期间 uploading 为 true，结束后回到 false', async () => {
    let seen = false
    vi.mocked(uploadImage).mockImplementation(async () => {
      seen = true
      return '/uploads/x.webp'
    })
    const field = useImageField({ maxEdge: 400, quality: 0.85, label: '头像' })

    const pending = field.upload(makeFile())
    expect(field.uploading.value).toBe(true)

    await pending
    expect(seen).toBe(true)
    expect(field.uploading.value).toBe(false)
  })

  it('reset 把上一次的错误和进度清干净', async () => {
    vi.mocked(uploadImage).mockRejectedValue(new Error('network'))
    const field = useImageField({ maxEdge: 400, quality: 0.85, label: '头像' })
    await field.upload(makeFile())
    expect(field.error.value).not.toBe('')

    field.reset()

    expect(field.error.value).toBe('')
    expect(field.progress.value).toBe(0)
  })
})
