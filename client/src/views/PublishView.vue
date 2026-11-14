<script setup lang="ts">
/**
 * 发布笔记页（桌面端）
 *
 * 组件替换：
 * - 手写 label + textarea / input  → ElForm + ElFormItem + ElInput
 * - 手写拖拽区 + 隐藏 file input  → ElUpload（自带的 drag 样式与拖高亮）
 * - 手写上传进度条               → ElProgress
 * - window.confirm               → ElMessageBox
 *
 * 上传本身仍然走手写 XHR（没有换成 ElUpload 的 http-request）：
 * 现有逻辑绕开了 axios 1.x 把 FormData 转成 JSON 的坑，
 * 并且要按张单独上报进度，没必要为此重写。
 */
import { ref, reactive, computed, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import type { UploadFile } from '@/utils/element'
import { ElMessage, ElMessageBox } from '@/utils/element'
import { PictureFilled, UploadFilled, VideoCameraFilled } from '@element-plus/icons-vue'
import { useAuthStore } from '@/stores/auth'
import { useToastStore } from '@/stores/toast'
import { postsApi, type PostVisibility, type PostMediaType } from '@/api/posts'
import { topicsApi, type TopicSummary } from '@/api/topics'
import {
  POST_CONTENT_MAX_LENGTH,
  UPLOAD_MAX_IMAGES,
  UPLOAD_MAX_SIZE_MB,
  UPLOAD_MAX_SIZE_BYTES,
  UPLOAD_TIMEOUT_MS,
  VIDEO_MAX_SIZE_MB,
  VIDEO_MAX_SIZE_BYTES,
  VIDEO_UPLOAD_TIMEOUT_MS,
  IMAGE_MAX_EDGE,
  IMAGE_QUALITY,
  IMAGE_THUMB_MAX_EDGE,
  DEFAULT_API_BASE
} from '@/constants'
import { compressImage, compressSeries } from '@/utils/imageCompress'
import { formatBytes, describeSavings } from '@/utils/image'
import { validateVideoFile, captureVideoPoster } from '@/utils/video'

const router = useRouter()
const auth = useAuthStore()
const toast = useToastStore()

// ===== 表单状态 =====
const content = ref('')
const topicTag = ref('')
/**
 * 谁可以看。默认公开 —— 大多数笔记就是要给人看的，
 * 默认私密会让「发了但没人看到」变成一个需要排查的谜。
 */
const visibility = ref<PostVisibility>('public')
/** 热门话题快捷选择：空着的输入框等于劝退 */
const hotTopics = ref<TopicSummary[]>([])
const submitting = ref(false)
const errorMsg = ref('')

// 待上传的图片
interface PendingImage {
  id: number
  file: File
  previewUrl: string // 本地预览（URL.createObjectURL）
  uploadedUrl: string | null // 上传成功后服务器返回的 URL
  /**
   * 列表缩略图的本地 Blob。和主图在**同一次请求**里一起发出去。
   * null = 这张图生成不出缩略图（GIF / SVG，或原图本来就够小），
   * 此时只传主图，服务端会自动拿原图当缩略图。
   */
  thumbBlob: Blob | null
  /** 缩略图上传后的 URL。null = 没有缩略图（服务端会拿原图兜底） */
  thumbUrl: string | null
  status: 'pending' | 'compressing' | 'uploading' | 'done' | 'error'
  progress: number // 0-100 上传进度
  errorMsg?: string // 上传失败时的提示
  /** 压缩前的原始体积；0 = 没压过（GIF/SVG 等） */
  originalSize: number
  /** 压缩收益文案，例如「3.2 MB → 380 KB（-88%）」 */
  savings?: string
}
const images = ref<PendingImage[]>([])
let nextImgId = 1

// ===== 视频笔记 =====
//
// 一条笔记要么图文要么视频（服务端也这么卡），切换时把另一边清掉 ——
// 「图和视频都留着，提交时二选一」会造出「我选了图怎么发出去是视频」的客服工单。
interface PendingVideo {
  file: File
  previewUrl: string
  /** 视频本体上传后的 URL */
  uploadedUrl: string | null
  /** 前端抽帧的封面，上传图片通道后的 URL；null = 抽帧失败，播放器黑底兜底 */
  posterUrl: string | null
  posterBlob: Blob | null
  status: 'pending' | 'uploading' | 'done' | 'error'
  progress: number
  errorMsg?: string
}
const mediaKind = ref<PostMediaType>('image')
const videoItem = ref<PendingVideo | null>(null)

/** 切媒体类型：清掉另一侧的已选内容（预览 URL 一并释放） */
function switchMediaKind(kind: PostMediaType) {
  if (kind === mediaKind.value) return
  mediaKind.value = kind
  if (kind === 'video') {
    images.value.forEach((img) => URL.revokeObjectURL(img.previewUrl))
    images.value = []
  } else if (videoItem.value) {
    URL.revokeObjectURL(videoItem.value.previewUrl)
    videoItem.value = null
  }
  errorMsg.value = ''
}

// 上传限制（client + server 防御性校验；值在 src/constants.ts）
const MAX_IMAGES = UPLOAD_MAX_IMAGES
const MAX_SIZE_MB = UPLOAD_MAX_SIZE_MB

/** 本次发布一共省了多少 */
const totalSavings = computed(() => {
  const saved = images.value.reduce((sum, i) => sum + (i.originalSize - i.file.size), 0)
  return saved > 0 ? formatBytes(saved) : ''
})

const allUploaded = computed(
  () => images.value.length === 0 || images.value.every((i) => i.status === 'done')
)

const canSubmit = computed(
  () =>
    content.value.trim().length > 0 &&
    content.value.trim().length <= POST_CONTENT_MAX_LENGTH &&
    !submitting.value &&
    (mediaKind.value === 'video'
      ? videoItem.value !== null && videoItem.value.status === 'done'
      : allUploaded.value)
)

// ===== 校验：登录 + 自动重定向 =====
onMounted(() => {
  if (!auth.isLoggedIn) {
    router.push('/login')
    return
  }
  // 热门话题拉不到就让输入框空着，不影响发布
  topicsApi
    .list({ limit: 8 })
    .then((res) => {
      hotTopics.value = res.list
    })
    .catch(() => {
      hotTopics.value = []
    })
})

// 组件卸载时清理所有 ObjectURL 防内存泄漏
onUnmounted(() => {
  images.value.forEach((img) => URL.revokeObjectURL(img.previewUrl))
})

// ===== 文件选择 =====
// ElUpload 关闭了自动上传（auto-upload=false），
// 所以这里在 on-change 阶段自己走校验 + 触发上传。
function handleUploadChange(uploadFile: UploadFile) {
  const file = uploadFile.raw
  if (!file) return
  // 压缩是异步的，但不需要等它 —— 队列状态由 images 自己驱动，
  // 用户看到的是「压缩中 → 上传中 → 已上传」这条进度链
  void addFiles([file])
}

/** 异步：先全部入队，再串行压缩 + 上传 */
async function addFiles(files: File[]) {
  errorMsg.value = ''
  const remaining = MAX_IMAGES - images.value.length
  if (remaining <= 0) {
    ElMessage.warning(`最多上传 ${MAX_IMAGES} 张图片`)
    return
  }

  const accepted = files.slice(0, remaining)
  if (files.length > remaining) {
    ElMessage.warning(`超出额度，已截取前 ${remaining} 张`)
  }

  for (const file of accepted) {
    // 类型校验
    if (!file.type.startsWith('image/')) {
      ElMessage.error(`已跳过非图片文件：${file.name}`)
      continue
    }
    // 大小校验
    if (file.size > UPLOAD_MAX_SIZE_BYTES) {
      ElMessage.error(`已跳过超大文件（>${MAX_SIZE_MB}MB）：${file.name}`)
      continue
    }

    // 用 reactive() 包一层 —— Vue 3 的 ref()/reactive() 不会自动 proxy
    // push 进去的对象，直接 mutate 闭包里的 plain object 不会触发 UI 更新
    // （XHR onload 后 img.status='done' 但徽章永远卡在 uploading）。
    const img = reactive<PendingImage>({
      id: nextImgId++,
      file,
      previewUrl: URL.createObjectURL(file),
      uploadedUrl: null,
      thumbBlob: null,
      thumbUrl: null,
      status: 'pending',
      progress: 0,
      originalSize: 0
    })
    images.value.push(img)
  }

  // 全部塞进列表之后再串行处理。
  // ⚠️ 必须「先全部入队、再串行跑」，不能边选边压：
  // 一次选 9 张图时，每张解码成 RGBA 约 48MB，
  // 并发跑就是 432MB，移动端会在解码阶段直接崩（表现为「选完什么都没发生」）。
  await compressSeries(images.value.slice(), (img) => prepareAndUpload(img))
}

/**
 * 给缩略图起个名字。
 *
 * 名字本身不参与识别（服务端按**内容魔数**定扩展名），但还是给个带
 * thumb 标记的名字：出问题时（比如去 uploads 目录里翻文件），
 * `1234-abcd_thumb.webp` 一眼就知道是缩略图，
 * 而 `1234-abcd.webp` 只能靠猜。
 */
function thumbName(original: string): string {
  const dot = original.lastIndexOf('.')
  const stem = dot > 0 ? original.slice(0, dot) : original
  return `${stem}_thumb.webp`
}

/**
 * 压缩 → 上传。
 *
 * 分两段而不是合成一步，是为了让用户看得见「到底卡在哪」：
 * 一张 4000×3000 的照片压缩要几百毫秒，没有单独一段的话
 * 进度条会先停在 0，用户以为没点上又选了一遍。
 */
async function prepareAndUpload(img: PendingImage) {
  img.status = 'compressing'
  img.errorMsg = undefined

  try {
    const result = await compressImage(img.file, {
      maxEdge: IMAGE_MAX_EDGE,
      quality: IMAGE_QUALITY,
      thumbMaxEdge: IMAGE_THUMB_MAX_EDGE
    })
    if (result.strategy === 'resized' || result.strategy === 'reencode') {
      img.originalSize = result.originalSize
      img.savings = describeSavings(result.originalSize, result.finalSize)
      // 换了内容，预览图必须跟着换，否则用户看到的是「压缩前的图」
      const oldUrl = img.previewUrl
      img.file = new File([result.blob], img.file.name, { type: result.type })
      img.previewUrl = URL.createObjectURL(result.blob)
      URL.revokeObjectURL(oldUrl)
    }
    // 缩略图和主图在同一次请求里发出去，不额外发第二次 —— 每多一个 HTTP 请求
    // 就多一次往返，而弱网下往返本身是要计时的
    img.thumbBlob = result.thumb
  } catch {
    // compressImage 内部已经保证不抛，这里只是最后一道保险：
    // 压缩失败绝不能阻断发布。thumbBlob 留 null，服务端会拿原图当缩略图。
  }

  await uploadImage(img)
}

async function uploadImage(img: PendingImage) {
  img.status = 'uploading'
  img.progress = 0
  img.errorMsg = undefined
  const formData = new FormData()
  formData.append('files', img.file)
  // 缩略图紧跟主图，同一个请求发出。顺序即约定：
  // 服务端按 files[0] / files[1] 取主图和缩略图，不做任何配对推断。
  if (img.thumbBlob) formData.append('files', img.thumbBlob, thumbName(img.file.name))

  // 用 XHR 直接上传，绕开 axios 1.x 的 FormData/Content-Type 处理 bug
  // （axios 1.x 在 instance 默认 Content-Type 是 'application/json' 时，
  //  会把 FormData 转成 JSON 字符串发出去，multer 收不到文件）
  return new Promise<void>((resolve) => {
    const xhr = new XMLHttpRequest()

    // 进度
    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable && e.total > 0) {
        img.progress = Math.min(100, Math.round((e.loaded / e.total) * 100))
      }
    })

    // 超时
    xhr.timeout = UPLOAD_TIMEOUT_MS
    xhr.addEventListener('timeout', () => {
      img.status = 'error'
      img.errorMsg = `上传超时（>${UPLOAD_TIMEOUT_MS / 1000}s）`
      resolve()
    })

    // 完成
    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const data = JSON.parse(xhr.responseText)
          const uploaded = data.files?.[0]
          if (uploaded) {
            img.uploadedUrl = uploaded.url
            // files[1] 只在确实发了缩略图时才是缩略图。
            // 用「有没有发」来判断而不是「服务器返回几项」——
            // 万一服务端将来调整了返回结构，这里不会静默拿到别人的图。
            img.thumbUrl = img.thumbBlob ? (data.files?.[1]?.url ?? null) : null
            img.progress = 100
            img.status = 'done'
          } else {
            img.status = 'error'
            img.errorMsg = '服务器返回为空'
          }
        } catch {
          img.status = 'error'
          img.errorMsg = '响应解析失败'
        }
      } else {
        // 4xx/5xx — 尝试读 body 拿具体 message
        let serverMsg = ''
        try {
          const body = JSON.parse(xhr.responseText)
          serverMsg = body.message || ''
        } catch {
          /* ignore */
        }
        img.status = 'error'
        img.errorMsg = serverMsg || `HTTP ${xhr.status}`
      }
      resolve()
    })

    // 网络错误
    xhr.addEventListener('error', () => {
      img.status = 'error'
      img.errorMsg = '网络错误'
      resolve()
    })

    // 请求被中止
    xhr.addEventListener('abort', () => {
      resolve()
    })

    // API base 用 DEFAULT_API_BASE：dev 下是绝对 URL http://localhost:3000/api
    // （XHR 相对路径会指向 5173，被 Vite SPA fallback 返 404）；
    // prod 下是同源相对路径 /api（见 constants.ts 的事故注释）。
    const API_BASE = (import.meta.env.VITE_API_BASE as string) || DEFAULT_API_BASE

    xhr.open('POST', `${API_BASE}/uploads`)
    // 必须在 open() 之后才能 setRequestHeader
    xhr.setRequestHeader('Authorization', `Bearer ${auth.token}`)
    xhr.send(formData)
  })
}

async function retryImage(id: number) {
  const img = images.value.find((i) => i.id === id)
  if (img) await uploadImage(img)
}

function removeImage(id: number) {
  const idx = images.value.findIndex((i) => i.id === id)
  if (idx === -1) return
  // 释放 ObjectURL
  URL.revokeObjectURL(images.value[idx].previewUrl)
  images.value.splice(idx, 1)
}

// ===== 视频上传 =====

function handleVideoChange(uploadFile: UploadFile) {
  const file = uploadFile.raw
  if (!file) return

  const v = validateVideoFile(file, VIDEO_MAX_SIZE_BYTES)
  if (!v.ok) {
    ElMessage.error(`${v.reason}（≤ ${VIDEO_MAX_SIZE_MB}MB）`)
    return
  }

  // 换视频要先把旧预览释放掉 —— ObjectURL 不还就是泄漏
  if (videoItem.value) URL.revokeObjectURL(videoItem.value.previewUrl)
  videoItem.value = reactive<PendingVideo>({
    file,
    previewUrl: URL.createObjectURL(file),
    uploadedUrl: null,
    posterUrl: null,
    posterBlob: null,
    status: 'pending',
    progress: 0
  })
  void uploadVideo()
}

/**
 * 视频上传 = 三步：抽封面 → 传视频 → 传封面。
 * 顺序刻意如此：封面只有几百 KB，先抽好等着，
 * 视频传完封面立刻就能跟上，用户不用多等一个往返。
 */
async function uploadVideo() {
  const item = videoItem.value
  if (!item) return
  item.status = 'uploading'
  item.progress = 0
  item.errorMsg = undefined

  // 1. 抽帧（失败不阻塞：posterUrl 留 null，播放器黑底兜底）
  if (!item.posterBlob) {
    item.posterBlob = await captureVideoPoster(item.file).catch(() => null)
  }

  // 2. 传视频本体（独立端点：限额 50MB、魔数只认 MP4/WebM）
  const uploaded = await xhrUpload(
    `${apiBase()}/uploads/video`,
    (fd) => {
      fd.append('video', item.file)
    },
    VIDEO_UPLOAD_TIMEOUT_MS,
    (p) => (item.progress = p)
  )
  if (!uploaded.ok) {
    item.status = 'error'
    item.errorMsg = uploaded.message
    return
  }
  item.uploadedUrl = uploaded.url!

  // 3. 封面走现有图片通道（compressImage 那套服务端校验原样生效）
  if (item.posterBlob) {
    const posterFile = new File([item.posterBlob], 'poster.jpg', { type: 'image/jpeg' })
    const posterRes = await xhrUpload(
      `${apiBase()}/uploads`,
      (fd) => {
        fd.append('files', posterFile)
      },
      UPLOAD_TIMEOUT_MS
    )
    item.posterUrl = posterRes.ok ? posterRes.url! : null
  }

  item.status = 'done'
}

function retryVideo() {
  void uploadVideo()
}

function removeVideo() {
  if (videoItem.value) URL.revokeObjectURL(videoItem.value.previewUrl)
  videoItem.value = null
}

function apiBase(): string {
  return (import.meta.env.VITE_API_BASE as string) || DEFAULT_API_BASE
}

/**
 * 视频用的通用 XHR 上传。图片那套 xhrUpload 逻辑和 PendingImage 耦合太深
 * （进度写回 img、缩略图配对），单独抽一个小的不动原函数 ——
 * 原 uploader 是全仓库最经不起回归的一段（axios FormData 坑都在那）。
 */
function xhrUpload(
  url: string,
  fill: (fd: FormData) => void,
  timeoutMs: number,
  onProgress?: (pct: number) => void
): Promise<{ ok: boolean; url?: string; message?: string }> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest()
    xhr.timeout = timeoutMs
    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable && e.total > 0 && onProgress) {
        onProgress(Math.min(100, Math.round((e.loaded / e.total) * 100)))
      }
    })
    xhr.addEventListener('timeout', () =>
      resolve({ ok: false, message: `上传超时（>${timeoutMs / 1000}s）` })
    )
    xhr.addEventListener('error', () => resolve({ ok: false, message: '网络错误' }))
    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const data = JSON.parse(xhr.responseText)
          const first = data.file?.url ?? data.files?.[0]?.url
          if (first) return resolve({ ok: true, url: first })
          return resolve({ ok: false, message: '服务器返回为空' })
        } catch {
          return resolve({ ok: false, message: '响应解析失败' })
        }
      }
      let serverMsg = ''
      try {
        serverMsg = JSON.parse(xhr.responseText).message || ''
      } catch {
        /* ignore */
      }
      resolve({ ok: false, message: serverMsg || `HTTP ${xhr.status}` })
    })
    xhr.open('POST', url)
    xhr.setRequestHeader('Authorization', `Bearer ${auth.token}`)
    const fd = new FormData()
    fill(fd)
    xhr.send(fd)
  })
}

// ===== 取消 =====
async function onCancel() {
  // 有内容时给提示确认；否则直接返回
  if (content.value.trim() || topicTag.value.trim() || images.value.length > 0 || videoItem.value) {
    try {
      await ElMessageBox.confirm('放弃当前编辑？已填写的内容将丢失。', '确认放弃', {
        confirmButtonText: '放弃',
        cancelButtonText: '继续编辑',
        type: 'warning'
      })
    } catch {
      return // 用户点了「继续编辑」
    }
  }
  router.push('/')
}

// ===== 提交 =====
async function handleSubmit() {
  const text = content.value.trim()
  if (!text) {
    errorMsg.value = '内容不能为空'
    return
  }
  if (text.length > POST_CONTENT_MAX_LENGTH) {
    errorMsg.value = `内容不能超过 ${POST_CONTENT_MAX_LENGTH} 字`
    return
  }
  // 媒体都上传完才能发布
  if (!canSubmit.value) {
    errorMsg.value = mediaKind.value === 'video' ? '请等待视频上传完成' : '请等待图片上传完成'
    return
  }

  errorMsg.value = ''
  submitting.value = true

  try {
    // 图片在选完时已经各自上传完毕，直接拿 URL 创建 post
    const uploaded = images.value.filter(
      (i): i is PendingImage & { uploadedUrl: string } => !!i.uploadedUrl
    )
    const imageUrls = uploaded.map((i) => i.uploadedUrl)
    // 缩略图可能缺（GIF / SVG / 原图本来就够小），缺的**留 null 占位**而不是过滤掉 ——
    // 过滤会让后面所有缩略图前移一位，配到别人的主图上。
    // 服务端 parseThumbs 也做同样的兜底，两边都不靠「数据一定整齐」。
    const imageThumbs = uploaded.map((i) => i.thumbUrl ?? null)

    await postsApi.createPost({
      content: text,
      imageUrls: mediaKind.value === 'image' && imageUrls.length > 0 ? imageUrls : undefined,
      imageThumbs: mediaKind.value === 'image' && imageThumbs.length > 0 ? imageThumbs : undefined,
      topicTag: topicTag.value.trim() || undefined,
      visibility: visibility.value,
      mediaType: mediaKind.value,
      videoUrl:
        mediaKind.value === 'video' ? (videoItem.value?.uploadedUrl ?? undefined) : undefined,
      videoPoster:
        mediaKind.value === 'video' ? (videoItem.value?.posterUrl ?? undefined) : undefined
    })

    toast.show('发布成功', 'success')
    router.push('/')
  } catch (err: any) {
    errorMsg.value = err?.response?.data?.message || '发布失败，请稍后再试'
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <div class="publish">
    <header class="page-header">
      <div class="head-line">
        <div>
          <h1 class="page-title">发布笔记</h1>
          <p class="page-subtitle">记录当下，分享你的生活与想法</p>
        </div>
        <!-- 统计锚点：字数 / 图片 / 话题不用滚到表单里数 -->
        <div class="head-stats">
          <span
            ><b>{{ content.length }}</b> / {{ POST_CONTENT_MAX_LENGTH }} 字</span
          >
          <span
            ><b>{{ images.length }}</b> / {{ MAX_IMAGES }} 张图</span
          >
          <span
            ><b>{{ topicTag.trim() ? 1 : 0 }}</b> 个话题</span
          >
        </div>
      </div>
    </header>

    <div class="publish-grid">
      <!-- ================= 表单 ================= -->
      <el-card shadow="never" class="form-card">
        <el-form label-position="top" @submit.prevent="handleSubmit">
          <el-form-item label="内容" required :error="errorMsg">
            <el-input
              v-model="content"
              type="textarea"
              :rows="6"
              :maxlength="POST_CONTENT_MAX_LENGTH"
              show-word-limit
              resize="none"
              placeholder="说点什么吧..."
            />
          </el-form-item>

          <!-- 话题是自由输入，但空着输入框等于劝退：给几个现成的热门话题，
               点一下就填上。既降低了门槛，也让新话题更容易被复用 -->
          <el-form-item label="话题标签">
            <el-input v-model="topicTag" placeholder="例如：前端开发" :maxlength="20" clearable />
            <div v-if="hotTopics.length > 0" class="hot-topics">
              <span class="hot-label">热门话题</span>
              <button
                v-for="t in hotTopics"
                :key="t.tag"
                type="button"
                class="hot-chip"
                :disabled="t.tag === topicTag"
                @click="topicTag = t.tag"
              >
                #{{ t.tag }}
                <span class="hot-count">{{ t.postCount }}</span>
              </button>
            </div>
          </el-form-item>

          <el-form-item label="媒体类型">
            <el-radio-group
              :model-value="mediaKind"
              size="small"
              @update:model-value="switchMediaKind($event as PostMediaType)"
            >
              <el-radio-button value="image">图文</el-radio-button>
              <el-radio-button value="video">视频</el-radio-button>
            </el-radio-group>
          </el-form-item>

          <!-- ===== 图文上传（mediaKind=image）===== -->
          <el-form-item v-if="mediaKind === 'image'">
            <div class="upload-label">
              <span>图片</span>
              <span class="upload-count">
                {{ images.length }} / {{ MAX_IMAGES }}，单张 ≤ {{ MAX_SIZE_MB }}MB
              </span>
            </div>

            <el-upload
              class="upload-dragger"
              drag
              multiple
              accept="image/*"
              :auto-upload="false"
              :limit="MAX_IMAGES"
              :show-file-list="false"
              :disabled="images.length >= MAX_IMAGES"
              :on-change="handleUploadChange"
            >
              <div class="upload-inner">
                <el-icon class="upload-icon"><component :is="UploadFilled" /></el-icon>
                <p class="upload-text">把图片拖到这儿，或<em>点击选择</em></p>
                <p class="upload-hint">支持 JPG / PNG / GIF / WebP</p>
              </div>
            </el-upload>

            <!-- 已选图片 -->
            <ul v-if="images.length > 0" class="image-list">
              <li v-for="img in images" :key="img.id" class="image-item">
                <img :src="img.previewUrl" class="image-preview" :alt="img.file.name" />

                <div class="image-info">
                  <span class="image-name" :title="img.file.name">{{ img.file.name }}</span>

                  <el-progress
                    v-if="img.status === 'uploading'"
                    :percentage="img.progress"
                    :stroke-width="4"
                    :show-text="false"
                    class="image-progress"
                  />
                  <!-- 压缩阶段没有可测的进度，所以用不确定态的进度条而不是假百分比 -->
                  <el-progress
                    v-else-if="img.status === 'compressing'"
                    :percentage="50"
                    :indeterminate="true"
                    :stroke-width="4"
                    :show-text="false"
                    class="image-progress"
                  />

                  <div class="image-status">
                    <el-tag v-if="img.status === 'done'" type="success" size="small" effect="plain">
                      已上传
                    </el-tag>
                    <el-tag
                      v-else-if="img.status === 'error'"
                      type="danger"
                      size="small"
                      effect="plain"
                    >
                      {{ img.errorMsg || '上传失败' }}
                    </el-tag>
                    <el-tag
                      v-else-if="img.status === 'compressing'"
                      type="info"
                      size="small"
                      effect="plain"
                    >
                      压缩中
                    </el-tag>
                    <el-tag
                      v-else-if="img.status === 'pending'"
                      type="info"
                      size="small"
                      effect="plain"
                    >
                      排队中
                    </el-tag>
                    <el-tag v-else type="info" size="small" effect="plain">
                      {{ img.progress }}%
                    </el-tag>
                  </div>

                  <!-- 压缩收益：给用户看「省了多少」，而不是默默压掉 -->
                  <span v-if="img.savings" class="image-savings">{{ img.savings }}</span>
                </div>

                <div class="image-actions">
                  <el-button
                    v-if="img.status === 'error'"
                    size="small"
                    type="primary"
                    plain
                    @click="retryImage(img.id)"
                  >
                    重试
                  </el-button>
                  <el-button size="small" text @click="removeImage(img.id)">移除</el-button>
                </div>
              </li>
            </ul>
          </el-form-item>

          <!-- ===== 视频上传（mediaKind=video）===== -->
          <el-form-item v-else>
            <div class="upload-label">
              <span>视频</span>
              <span class="upload-count">单个 ≤ {{ VIDEO_MAX_SIZE_MB }}MB，MP4 / WebM</span>
            </div>

            <el-upload
              v-if="!videoItem"
              class="upload-dragger"
              drag
              accept="video/mp4,video/webm"
              :auto-upload="false"
              :show-file-list="false"
              :on-change="handleVideoChange"
            >
              <div class="upload-inner">
                <el-icon class="upload-icon"><component :is="VideoCameraFilled" /></el-icon>
                <p class="upload-text">把视频拖到这儿，或<em>点击选择</em></p>
                <p class="upload-hint">封面会自动从视频里抽一帧</p>
              </div>
            </el-upload>

            <!-- 已选视频：预览播放器 + 封面 + 状态 -->
            <div v-else class="video-preview-box">
              <video
                class="video-preview"
                :src="videoItem.previewUrl"
                controls
                preload="metadata"
              ></video>

              <div class="video-side">
                <div class="poster-row">
                  <img
                    v-if="videoItem.posterUrl || videoItem.posterBlob"
                    :src="videoItem.posterUrl ?? videoItem.previewUrl"
                    class="poster-thumb"
                    alt="视频封面"
                  />
                  <div v-else class="poster-thumb poster-empty">封面待生成</div>
                  <div class="poster-meta">
                    <span class="poster-label">封面（自动抽帧）</span>
                    <span class="video-filename" :title="videoItem.file.name">
                      {{ videoItem.file.name }}
                    </span>
                  </div>
                </div>

                <el-progress
                  v-if="videoItem.status === 'uploading'"
                  :percentage="videoItem.progress"
                  :stroke-width="4"
                  :show-text="false"
                />

                <div class="video-status-row">
                  <el-tag
                    v-if="videoItem.status === 'done'"
                    type="success"
                    size="small"
                    effect="plain"
                  >
                    已上传
                  </el-tag>
                  <el-tag
                    v-else-if="videoItem.status === 'error'"
                    type="danger"
                    size="small"
                    effect="plain"
                  >
                    {{ videoItem.errorMsg || '上传失败' }}
                  </el-tag>
                  <el-tag v-else type="info" size="small" effect="plain">
                    {{ videoItem.status === 'pending' ? '排队中' : `${videoItem.progress}%` }}
                  </el-tag>

                  <div class="video-actions">
                    <el-button
                      v-if="videoItem.status === 'error'"
                      size="small"
                      type="primary"
                      plain
                      @click="retryVideo"
                    >
                      重试
                    </el-button>
                    <el-button size="small" text @click="removeVideo">移除</el-button>
                  </div>
                </div>
              </div>
            </div>
          </el-form-item>
          <!-- 可见性：两档，把后果直接写在下面 —— 用户点「仅自己可见」时
               最想知道的是「那它到底会不会出现在别人的首页」，不是这个开关叫什么 -->
          <el-form-item label="谁可以看">
            <el-radio-group v-model="visibility" size="small">
              <el-radio-button value="public">公开</el-radio-button>
              <el-radio-button value="private">仅自己可见</el-radio-button>
            </el-radio-group>
            <p class="visibility-hint">
              {{
                visibility === 'private'
                  ? '只出现在你主页的「私密」栏，不进推荐流、搜索结果和话题页。'
                  : '会出现在发现流、话题页和搜索结果里，所有人都能看到。'
              }}
            </p>
          </el-form-item>

          <div class="form-actions">
            <el-button @click="onCancel">取消</el-button>
            <el-button
              type="primary"
              :loading="submitting"
              :disabled="!canSubmit"
              @click="handleSubmit"
            >
              发布
            </el-button>
          </div>
        </el-form>
      </el-card>

      <!-- ================= 右侧说明 ================= -->
      <aside class="tips-col">
        <el-card shadow="never" class="tips-card">
          <template #header>
            <span class="tips-title"
              ><el-icon><component :is="PictureFilled" /></el-icon> 发布须知</span
            >
          </template>
          <template v-if="totalSavings">
            <p class="savings-line">已自动压缩，本次发布共节省 {{ totalSavings }}</p>
          </template>

          <ul class="tips-list">
            <li>正文最多 {{ POST_CONTENT_MAX_LENGTH }} 字，说清楚一件事就够了。</li>
            <li>最多上传 {{ MAX_IMAGES }} 张图片，单张不超过 {{ MAX_SIZE_MB }}MB。</li>
            <li>图片会在选择后立即压缩并上传；GIF 和 SVG 原样上传（动画和矢量图过不了压缩）。</li>
            <li>话题标签建议只填一个，太多反而没人点。</li>
          </ul>
        </el-card>

        <!-- 右栏原来只有一张 280px 高的须知卡，下面空 600px 纯黑。
             补一张随表单实时变化的摘要：两栏重心不再全压在左边。 -->
        <el-card shadow="never" class="summary-card">
          <template #header>
            <span class="tips-title">本次笔记</span>
          </template>
          <dl class="summary-list">
            <div>
              <dt>正文</dt>
              <dd>{{ content.length ? content.length + ' 字' : '还没写' }}</dd>
            </div>
            <div>
              <dt>话题</dt>
              <dd>{{ topicTag.trim() || '未填' }}</dd>
            </div>
            <div>
              <dt>媒体</dt>
              <dd>{{ mediaKind === 'image' ? '图文' : '视频' }}</dd>
            </div>
            <div>
              <dt>图片</dt>
              <dd>{{ images.length }} / {{ MAX_IMAGES }} 张</dd>
            </div>
            <div>
              <dt>可见性</dt>
              <dd>{{ visibility === 'public' ? '公开' : '仅自己可见' }}</dd>
            </div>
            <div>
              <dt>状态</dt>
              <dd :class="{ ready: canSubmit }">{{ canSubmit ? '可以发布了' : '还差一点' }}</dd>
            </div>
          </dl>
        </el-card>
      </aside>
    </div>

    <footer class="publish-foot">
      <span>发布前所有内容都可以修改 · 已经到底了</span>
    </footer>
  </div>
</template>

<style scoped>
.publish {
  max-width: var(--content-max-width);
  margin: 0 auto;
  padding-bottom: 48px;
}

.page-header {
  margin-bottom: 20px;
  padding-bottom: 16px;
  border-bottom: 1px solid var(--border-soft);
}

.head-line {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 24px;
}

.head-stats {
  display: flex;
  gap: 18px;
  flex-wrap: wrap;
  font-size: var(--fs-xs);
  color: var(--muted-foreground);
  white-space: nowrap;
}

.head-stats b {
  margin-right: 3px;
  font-size: var(--fs-md);
  font-weight: 700;
  color: var(--foreground);
  font-variant-numeric: tabular-nums;
}

.page-title {
  font-size: var(--fs-display);
  font-weight: 700;
  letter-spacing: -0.02em;
  margin: 0;
  color: var(--foreground);
}

.page-subtitle {
  margin: 6px 0 0;
  font-size: var(--fs-base);
  color: var(--muted-foreground);
}

/* ===== 双栏 ===== */
.publish-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 280px;
  gap: 24px;
  align-items: start;
}

/* 视口不够宽时右侧须知栏降级到下方，避免表单被压扁 */
@media (max-width: 1100px) {
  .publish-grid {
    grid-template-columns: minmax(0, 1fr);
  }

  .tips-col {
    position: static;
  }
}

.form-card :deep(.el-form-item) {
  margin-bottom: 22px;
}

.form-card :deep(.el-form-item__label) {
  font-weight: 600;
  font-size: var(--fs-base);
  color: var(--foreground);
}

/* ===== 上传区 ===== */
.upload-label {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  width: 100%;
}

.upload-count {
  font-size: var(--fs-xs);
  font-weight: 400;
  color: var(--muted-foreground);
}

/* 压缩收益：给正向反馈，而不是默默压掉 */
.image-savings {
  font-size: var(--fs-2xs);
  color: var(--el-color-success);
  font-variant-numeric: tabular-nums;
}

.savings-line {
  margin: 0 0 12px;
  font-size: var(--fs-xs);
  color: var(--el-color-success);
}

/* ===== 热门话题快捷选择 ===== */
.hot-topics {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  width: 100%;
  margin-top: 10px;
}

.hot-label {
  font-size: var(--fs-xs);
  color: var(--muted-foreground);
}

.hot-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 10px;
  font-size: var(--fs-xs);
  border: 1px solid var(--border);
  border-radius: var(--radius-full);
  background: transparent;
  color: var(--foreground);
  cursor: pointer;
  transition:
    border-color 0.15s,
    color 0.15s;
}

.hot-chip:hover:not(:disabled) {
  border-color: var(--accent);
  color: var(--accent);
}

.hot-chip:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

/* 已经选中的那个不用再点 */
.hot-chip:disabled {
  opacity: 0.5;
  cursor: default;
}

.hot-count {
  font-size: var(--fs-2xs);
  color: var(--muted-foreground);
  font-variant-numeric: tabular-nums;
}

.upload-dragger {
  width: 100%;
}

.upload-inner {
  padding: 28px 0;
}

.upload-icon {
  font-size: 46px;
  color: var(--muted-foreground);
  margin-bottom: 10px;
}

.upload-text {
  margin: 0;
  font-size: var(--fs-base);
  color: var(--foreground);
}

.upload-text em {
  color: var(--accent);
  font-style: normal;
}

.upload-hint {
  margin: 6px 0 0;
  font-size: var(--fs-xs);
  color: var(--muted-foreground);
}

/* ===== 图片列表 ===== */
.image-list {
  list-style: none;
  margin: 16px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.image-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
}

.image-preview {
  width: 56px;
  height: 56px;
  object-fit: cover;
  border-radius: var(--radius-sm);
  flex-shrink: 0;
  background: var(--muted);
}

.image-info {
  flex: 1;
  min-width: 0;
}

.image-name {
  display: block;
  font-size: var(--fs-sm);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.image-progress {
  margin: 6px 0 4px;
}

.image-status {
  margin-top: 4px;
}

.image-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

/* ===== 提交 ===== */
.form-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  padding-top: 4px;
}

/* ===== 右侧须知 ===== */
.tips-col {
  position: sticky;
  top: calc(var(--top-bar-height) + 24px);
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.tips-title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-weight: 600;
  font-size: var(--fs-base);
}

.tips-list {
  margin: 0;
  padding-left: 18px;
  font-size: var(--fs-sm);
  line-height: 1.9;
  color: var(--muted-foreground);
}

/* 右栏实时摘要：一张表格式的清单，把 600px 空白换成有用的信息 */
.summary-list {
  margin: 0;
  font-size: var(--fs-sm);
}

.summary-list > div {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  padding: 9px 0;
  border-bottom: 1px solid var(--border-soft);
}

.summary-list > div:last-child {
  border-bottom: none;
}

.summary-list dt {
  font-size: var(--fs-xs);
  color: var(--muted-foreground);
}

.summary-list dd {
  margin: 0;
  color: var(--foreground);
  text-align: right;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.summary-list dd.ready {
  color: var(--accent);
  font-weight: 600;
}

.publish-foot {
  margin-top: 20px;
  padding-top: 14px;
  border-top: 1px solid var(--border-soft);
  text-align: center;
  font-size: var(--fs-xs);
  color: var(--text-2);
}

@media (max-width: 700px) {
  .head-line {
    flex-direction: column;
    align-items: flex-start;
    gap: 10px;
  }
}

/* 可见性说明：紧跟开关，用 muted 色 —— 它是解释不是警告 */
.visibility-hint {
  margin: 6px 0 0;
  font-size: var(--fs-sm);
  line-height: 1.6;
  color: var(--muted-foreground);
}

/* ===== 视频预览区 ===== */
.video-preview-box {
  display: flex;
  gap: 14px;
  width: 100%;
}

.video-preview {
  width: 320px;
  max-height: 240px;
  flex-shrink: 0;
  background: #000;
  border-radius: var(--radius-md);
  object-fit: contain;
}

.video-side {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.poster-row {
  display: flex;
  gap: 10px;
  align-items: flex-start;
}

.poster-thumb {
  width: 96px;
  height: 60px;
  object-fit: cover;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border);
  background: var(--muted);
  flex-shrink: 0;
}

.poster-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: var(--fs-2xs);
  color: var(--muted-foreground);
}

.poster-meta {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.poster-label {
  font-size: var(--fs-xs);
  color: var(--muted-foreground);
}

.video-filename {
  font-size: var(--fs-sm);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.video-status-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.video-actions {
  margin-left: auto;
}
</style>
