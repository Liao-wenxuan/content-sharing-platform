import { ref } from 'vue'
import { uploadImage } from '@/api/uploads'
import { compressImage } from '@/utils/imageCompress'
import { UPLOAD_MAX_SIZE_BYTES, UPLOAD_MAX_SIZE_MB } from '@/constants'

/**
 * 一个图片字段（头像 / 封面）的上传流程
 *
 * 为什么不直接把文件丢给上传接口：手机拍一张照片是 3~5MB，
 * 而头像在主页上只显示 72px —— 原样上传就是为了一张 72px 的图
 * 传 5MB 流量。压缩放在上传前面，省的是流量、磁盘和时间。
 *
 * 压缩参数按用途给：头像是方的、封面是宽的，
 * 用同一个上限要么头像太大，要么封面不够清晰。
 *
 * 压缩失败**不阻断上传** —— 拿不到小图总比传不上去好。
 * （compressImage 内部本身也保证永远返回一个可用的 Blob，
 * 这里的兜底是最后一道保险。）
 */
export function useImageField(options: {
  /** 压缩后的长边上限 */
  maxEdge: number
  /** 压缩画质 */
  quality: number
  /** 字段名，只用于错误文案：「头像」「封面」 */
  label: string
}) {
  const uploading = ref(false)
  /** 0-100，只在上传阶段有意义（压缩阶段给不出精确进度） */
  const progress = ref(0)
  const error = ref('')
  /** 预览图加载失败 —— 链接填错了，或者图已经没了 */
  const previewBroken = ref(false)

  function reset() {
    error.value = ''
    progress.value = 0
    uploading.value = false
    previewBroken.value = false
  }

  /**
   * 处理选中的文件。
   *
   * @returns 上传后的图片地址；失败返回 null
   */
  async function upload(file: File): Promise<string | null> {
    reset()

    if (!file.type.startsWith('image/')) {
      error.value = '只能上传图片文件'
      return null
    }
    if (file.size > UPLOAD_MAX_SIZE_BYTES) {
      error.value = `图片不能超过 ${UPLOAD_MAX_SIZE_MB} MB`
      return null
    }

    uploading.value = true
    try {
      // 1. 压缩
      let payload = file
      try {
        const result = await compressImage(file, {
          maxEdge: options.maxEdge,
          quality: options.quality
        })
        // 换了内容，扩展名可能也变了（jpg → webp），所以按新类型造 File
        payload = new File([result.blob], file.name, { type: result.type })
      } catch {
        // 压缩失败就用原图，别让用户什么都传不了
      }

      // 2. 上传
      const url = await uploadImage(payload, (p) => {
        progress.value = p
      })
      previewBroken.value = false
      return url
    } catch (err: any) {
      error.value = err?.response?.data?.message || `${options.label}上传失败`
      return null
    } finally {
      uploading.value = false
    }
  }

  return { uploading, progress, error, previewBroken, reset, upload }
}
