import request from './request'

/**
 * 图片上传
 *
 * 走 axios 而不是裸 XMLHttpRequest：token 由 request.ts 的请求拦截器注入，
 * 错误由响应拦截器统一处理，这里只剩「传文件 + 读 URL」这一件事。
 *
 * ⚠️ 绝对不要手动设 Content-Type。
 * 设了它 axios 会保留这个默认值，不给 FormData 补 multipart 的 boundary，
 * multer 找不到 boundary 就把整个 body 当空（见 request.ts 的注释）。
 */
export interface UploadedFile {
  url: string
  filename: string
  size: number
  mimetype: string
}

/**
 * 上传一张图片。
 * @param onProgress 0-100，用于进度条。不传就不做进度上报
 * @returns 相对 URL（形如 /uploads/xxx.jpg），展示时拼 baseURL
 */
export function uploadImage(file: File, onProgress?: (percent: number) => void): Promise<string> {
  const form = new FormData()
  form.append('files', file)

  return request
    .post<{ files: UploadedFile[] }>('/uploads', form, {
      onUploadProgress: (e: { loaded: number; total?: number }) => {
        if (!onProgress || !e.total) return
        onProgress(Math.min(100, Math.round((e.loaded / e.total) * 100)))
      }
    })
    .then((res) => {
      const uploaded = res?.files?.[0]
      if (!uploaded) throw new Error('上传失败：服务端没返回文件')
      return uploaded.url
    })
}
