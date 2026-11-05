/**
 * 视频笔记的客户端工具
 *
 * 两件事：
 * 1. 选文件时的即时校验（类型 / 大小）—— 纯函数，可以单测；
 * 2. **在前端抽视频首帧当封面**。
 *
 * 为什么封面在前端抽而不是服务端：
 *   - 服务端抽帧要 ffmpeg，部署从一个「node + sqlite」变成「node + sqlite + ffmpeg」，
 *     docker 镜像、CI、线上机器全要跟着动 —— 一个封面不值得；
 *   - 浏览器本来就解码得了这个视频（放不出来的是用户自己也不会传），
 *     <video> + canvas 三行代码的事，结果和用户看到的第一帧完全一致；
 *   - 抽出来的 JPEG 走**现有的**图片上传通道，服务端不用新增任何「封面」概念。
 *
 * 抽帧失败的兜底：返回 null，封面就是播放器自己的黑底 ——
 * 功能照常，只是列表页少一张好看的封面，不值得为它阻塞发布。
 */

export const VIDEO_ALLOWED_TYPES = ['video/mp4', 'video/webm'] as const

export interface VideoValidation {
  ok: boolean
  /** ok = false 时的用户可读原因 */
  reason?: string
}

/** 选文件时的同步校验：类型白名单 + 大小上限 */
export function validateVideoFile(file: File, maxBytes: number): VideoValidation {
  if (!(VIDEO_ALLOWED_TYPES as readonly string[]).includes(file.type)) {
    return { ok: false, reason: '只支持 MP4 / WebM 视频' }
  }
  if (file.size > maxBytes) {
    return { ok: false, reason: '视频太大' }
  }
  if (file.size === 0) {
    return { ok: false, reason: '这是一个空文件' }
  }
  return { ok: true }
}

/**
 * 抽视频首帧转 JPEG Blob。
 *
 * seek 到 `min(0.5s, 时长的 10%)` 而不是 0 —— 不少视频第 0 帧是纯黑，
 * 0.5 秒处一般已经进正片了。canvas 长边压到 800：封面只出现在
 * 列表卡和播放器海报位，800 已经超过两者的实际显示尺寸。
 */
export async function captureVideoPoster(file: File): Promise<Blob | null> {
  const url = URL.createObjectURL(file)
  const video = document.createElement('video')

  try {
    const frame = await new Promise<HTMLCanvasElement | null>((resolve) => {
      const fail = () => resolve(null)
      // 不同浏览器的 loadedmetadata / loadeddata 触发顺序不一样，
      // 监听 loadeddata（首帧真的可用了）最稳
      video.addEventListener('loadeddata', onReady, { once: true })
      video.addEventListener('error', fail, { once: true })
      // 8 秒还没就绪就放弃 —— 封面不值得等
      const timer = setTimeout(fail, 8000)

      function onReady() {
        clearTimeout(timer)
        const target = Math.min(0.5, (video.duration || 1) * 0.1)
        video.addEventListener('seeked', onSeeked, { once: true })
        video.currentTime = Number.isFinite(target) ? target : 0
      }
      function onSeeked() {
        try {
          const scale = Math.min(1, 800 / Math.max(video.videoWidth, video.videoHeight, 1))
          const canvas = document.createElement('canvas')
          canvas.width = Math.max(1, Math.round(video.videoWidth * scale))
          canvas.height = Math.max(1, Math.round(video.videoHeight * scale))
          const ctx = canvas.getContext('2d')
          if (!ctx) return resolve(null)
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
          resolve(canvas)
        } catch {
          // drawImage 可能因跨域/解码错误抛异常 —— 封面失败不阻塞发布
          resolve(null)
        }
      }

      video.muted = true
      video.preload = 'auto'
      video.src = url
    })

    if (!frame) return null
    return await new Promise<Blob | null>((resolve) =>
      frame.toBlob((b) => resolve(b), 'image/jpeg', 0.82)
    )
  } finally {
    URL.revokeObjectURL(url)
  }
}
