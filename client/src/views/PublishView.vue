<script setup lang="ts">
import { ref, reactive, computed, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { postsApi } from '@/api/posts'
import request from '@/api/request'
import {
  POST_CONTENT_MAX_LENGTH,
  NICKNAME_MAX_LENGTH,
  UPLOAD_MAX_IMAGES,
  UPLOAD_MAX_SIZE_MB,
  UPLOAD_MAX_SIZE_BYTES,
  UPLOAD_TIMEOUT_MS,
  DEFAULT_API_BASE
} from '@/constants'

const router = useRouter()
const auth = useAuthStore()

// ===== 表单状态 =====
const content = ref('')
const topicTag = ref('')
const submitting = ref(false)
const errorMsg = ref('')

// 待上传的图片：{ id, file, previewUrl, uploadedUrl, status, progress }
interface PendingImage {
  id: number
  file: File
  previewUrl: string // 本地预览（URL.createObjectURL）
  uploadedUrl: string | null // 上传成功后服务器返回的 URL
  status: 'pending' | 'uploading' | 'done' | 'error'
  progress: number // 0-100 上传进度
  errorMsg?: string // 上传失败时的提示
}
const images = ref<PendingImage[]>([])
let nextImgId = 1

// 上传限制（client + server 防御性校验；值在 src/constants.ts）
const MAX_IMAGES = UPLOAD_MAX_IMAGES
const MAX_SIZE_MB = UPLOAD_MAX_SIZE_MB

// ===== 拖拽状态 =====
const isDragOver = ref(false)
const fileInput = ref<HTMLInputElement | null>(null)

const allUploaded = computed(
  () => images.value.length === 0 || images.value.every((i) => i.status === 'done')
)

const canSubmit = computed(
  () =>
    content.value.trim().length > 0 &&
    content.value.trim().length <= POST_CONTENT_MAX_LENGTH &&
    allUploaded.value &&
    !submitting.value
)

// ===== 校验：登录 + 自动重定向 =====
onMounted(() => {
  if (!auth.isLoggedIn) {
    router.push('/login')
  }
})

// 组件卸载时清理所有 ObjectURL 防内存泄漏
onUnmounted(() => {
  images.value.forEach((img) => URL.revokeObjectURL(img.previewUrl))
})

// ===== 文件选择 / 拖拽 =====
function triggerFilePicker() {
  fileInput.value?.click()
}

function onFilePicked(e: Event) {
  const input = e.target as HTMLInputElement
  if (input.files) addFiles(Array.from(input.files))
  // 清空 value 允许同一文件再次选择
  input.value = ''
}

function onDrop(e: DragEvent) {
  e.preventDefault()
  isDragOver.value = false
  const files = e.dataTransfer?.files
  if (files && files.length > 0) addFiles(Array.from(files))
}

function onDragOver(e: DragEvent) {
  e.preventDefault()
  isDragOver.value = true
}

function onDragLeave() {
  isDragOver.value = false
}

function addFiles(files: File[]) {
  errorMsg.value = ''
  const remaining = MAX_IMAGES - images.value.length
  if (remaining <= 0) {
    errorMsg.value = `最多上传 ${MAX_IMAGES} 张图片`
    return
  }

  const accepted = files.slice(0, remaining)
  if (files.length > remaining) {
    errorMsg.value = `已选 ${files.length} 张，超出 ${remaining} 张额度，已截取前 ${remaining} 张`
  }

  for (const file of accepted) {
    // 类型校验
    if (!file.type.startsWith('image/')) {
      errorMsg.value = `已跳过非图片文件：${file.name}`
      continue
    }
    // 大小校验
    if (file.size > UPLOAD_MAX_SIZE_BYTES) {
      errorMsg.value = `已跳过超大文件（>${MAX_SIZE_MB}MB）：${file.name}`
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
      status: 'pending'
    })
    images.value.push(img)
    // 选完立即上传（不等点发布按钮）
    uploadImage(img)
  }
}

async function uploadImage(img: PendingImage) {
  img.status = 'uploading'
  img.progress = 0
  img.errorMsg = undefined
  const formData = new FormData()
  formData.append('files', img.file)

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

    // 用绝对 URL 而不是相对路径 — XHR 用相对路径会指向 5173（Vite dev），
    // 必须直接打 3000 后端，否则 Vite SPA 会返 404 index.html
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
  // 图全部上传完才能发布
  if (!allUploaded.value) {
    errorMsg.value = '请等待图片上传完成'
    return
  }

  errorMsg.value = ''
  submitting.value = true

  try {
    // 图片在选完时已经各自上传完毕，直接拿 URL 创建 post
    const imageUrls = images.value.map((i) => i.uploadedUrl).filter((u): u is string => !!u)

    await postsApi.createPost({
      content: text,
      imageUrls: imageUrls.length > 0 ? imageUrls : undefined,
      topicTag: topicTag.value.trim() || undefined
    })

    router.push('/')
  } catch (err: any) {
    errorMsg.value = err.response?.data?.message || '发布失败，请稍后再试'
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <div class="publish">
    <h1>发布笔记</h1>

    <form @submit.prevent="handleSubmit">
      <!-- 内容 -->
      <div class="field">
        <label>内容 <span class="required">*</span></label>
        <textarea
          v-model="content"
          rows="5"
          :maxlength="POST_CONTENT_MAX_LENGTH"
          placeholder="说点什么吧..."
        />
        <div class="counter">{{ content.length }} / {{ POST_CONTENT_MAX_LENGTH }}</div>
      </div>

      <!-- 话题 -->
      <div class="field">
        <label>话题标签</label>
        <input v-model="topicTag" placeholder="例如：前端开发" maxlength="20" />
      </div>

      <!-- 图片上传 -->
      <div class="field">
        <label>
          图片
          <span class="hint"
            >（{{ images.length }} / {{ MAX_IMAGES }}，单张 ≤ {{ MAX_SIZE_MB }}MB）</span
          >
        </label>

        <!-- 上传区（拖拽 / 点击） -->
        <div
          class="dropzone"
          :class="{ active: isDragOver }"
          @click="triggerFilePicker"
          @drop="onDrop"
          @dragover="onDragOver"
          @dragleave="onDragLeave"
        >
          <svg viewBox="0 0 24 24" class="upload-icon" aria-hidden="true">
            <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z" fill="currentColor" />
          </svg>
          <p class="dropzone-text">点击或拖拽图片到此处上传</p>
          <p class="dropzone-hint">支持 JPG / PNG / GIF / WebP</p>
        </div>
        <input
          ref="fileInput"
          type="file"
          multiple
          accept="image/*"
          hidden
          @change="onFilePicked"
        />

        <!-- 预览网格 -->
        <div v-if="images.length > 0" class="preview-grid">
          <div v-for="img in images" :key="img.id" class="preview-item">
            <img :src="img.previewUrl" :alt="img.file.name" />

            <!-- 状态徽章（点击重试 or 显示错误） -->
            <button v-if="img.status === 'pending'" type="button" class="badge pending" disabled>
              待上传
            </button>
            <button
              v-else-if="img.status === 'uploading'"
              type="button"
              class="badge uploading with-progress"
              :style="{ '--progress': img.progress + '%' }"
              disabled
            >
              {{ img.progress }}%
            </button>
            <div v-else-if="img.status === 'done'" class="badge done">✓</div>
            <button
              v-else-if="img.status === 'error'"
              type="button"
              class="badge error"
              :title="img.errorMsg"
              @click="retryImage(img.id)"
            >
              重试
            </button>

            <!-- 删除按钮 -->
            <button
              type="button"
              class="remove-btn"
              aria-label="删除图片"
              @click="removeImage(img.id)"
            >
              ×
            </button>
          </div>
        </div>
      </div>

      <div v-if="errorMsg" class="error">{{ errorMsg }}</div>

      <button type="submit" class="submit-btn" :disabled="!canSubmit">
        {{ submitting ? '发布中...' : '发布' }}
      </button>
    </form>
  </div>
</template>

<style scoped>
.publish {
  max-width: 600px;
  margin: 0 auto;
  padding: 24px 20px;
}

h1 {
  margin-bottom: 24px;
  font-size: 24px;
  font-weight: 600;
  color: var(--foreground);
}

.field {
  margin-bottom: 20px;
}

.field label {
  display: block;
  margin-bottom: 8px;
  font-weight: 500;
  color: var(--foreground);
  font-size: 14px;
}

.required {
  color: var(--destructive);
}

.hint {
  font-weight: 400;
  font-size: 12px;
  color: var(--muted-foreground);
  margin-left: 4px;
}

.field input,
.field textarea {
  width: 100%;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  font-size: 14px;
  font-family: inherit;
  background: var(--background);
  color: var(--foreground);
  outline: none;
  transition:
    border-color 0.15s,
    box-shadow 0.15s;
  box-sizing: border-box;
}

.field input:focus,
.field textarea:focus {
  border-color: var(--ring);
  box-shadow: 0 0 0 3px rgb(0 0 0 / 0.05);
}

:global(.dark) .field input:focus,
:global(.dark) .field textarea:focus {
  box-shadow: 0 0 0 3px rgb(255 255 255 / 0.06);
}

.field input::placeholder,
.field textarea::placeholder {
  color: var(--muted-foreground);
}

.field textarea {
  resize: vertical;
  min-height: 100px;
}

.counter {
  text-align: right;
  font-size: 12px;
  color: var(--muted-foreground);
  margin-top: 4px;
  font-variant-numeric: tabular-nums;
}

/* ===== 上传区（dropzone） ===== */
.dropzone {
  border: 2px dashed var(--border);
  border-radius: var(--radius);
  padding: 32px 16px;
  text-align: center;
  cursor: pointer;
  background: var(--muted);
  transition: all 0.15s;
  user-select: none;
}

.dropzone:hover {
  border-color: var(--muted-foreground);
  background: var(--glass-bg-strong);
}

.dropzone.active {
  border-color: var(--primary);
  background: var(--glass-bg-strong);
  transform: scale(1.01);
}

.upload-icon {
  width: 32px;
  height: 32px;
  color: var(--muted-foreground);
  margin-bottom: 8px;
}

.dropzone-text {
  margin: 0 0 4px;
  font-size: 14px;
  font-weight: 500;
  color: var(--foreground);
}

.dropzone-hint {
  margin: 0;
  font-size: 12px;
  color: var(--muted-foreground);
}

/* ===== 预览网格 ===== */
.preview-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
  margin-top: 12px;
}

.preview-item {
  position: relative;
  aspect-ratio: 1;
  border-radius: var(--radius);
  overflow: hidden;
  background: var(--muted);
  border: 1px solid var(--border);
}

.preview-item img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.badge {
  position: absolute;
  left: 6px;
  bottom: 6px;
  font-size: 10px;
  padding: 2px 6px;
  border-radius: 4px;
  font-weight: 500;
  background: rgba(0, 0, 0, 0.7);
  color: white;
  backdrop-filter: blur(4px);
  border: none;
  font-family: inherit;
  cursor: default;
}

button.badge.error {
  cursor: pointer;
}

button.badge.error:hover {
  background: rgba(239, 68, 68, 1);
}

/* 上传中：渐变进度条（背景进度从 0% 到 var(--progress)） */
.badge.with-progress {
  background: linear-gradient(
    to right,
    rgba(59, 130, 246, 0.95) 0%,
    rgba(59, 130, 246, 0.95) var(--progress, 0%),
    rgba(0, 0, 0, 0.55) var(--progress, 0%),
    rgba(0, 0, 0, 0.55) 100%
  );
  min-width: 48px;
  font-variant-numeric: tabular-nums;
  padding: 2px 8px;
}

.badge.done {
  background: rgba(16, 185, 129, 0.9);
}

.badge.error {
  background: rgba(239, 68, 68, 0.9);
}

.badge.uploading {
  background: rgba(59, 130, 246, 0.9);
}

.remove-btn {
  position: absolute;
  top: 4px;
  right: 4px;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  border: none;
  background: rgba(0, 0, 0, 0.7);
  color: white;
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  font-family: inherit;
  transition:
    background 0.15s,
    transform 0.1s;
  padding: 0;
}

.remove-btn:hover {
  background: rgba(0, 0, 0, 0.9);
  transform: scale(1.1);
}

/* ===== 错误提示 + 提交 ===== */
.error {
  color: var(--destructive);
  margin-bottom: 12px;
  font-size: 13px;
  /* 玻璃错误条 */
  background: rgba(239, 68, 68, 0.1);
  backdrop-filter: blur(12px);
  padding: 8px 12px;
  border-radius: var(--radius);
  border: 1px solid rgba(239, 68, 68, 0.3);
}

.submit-btn {
  background: var(--primary);
  color: var(--primary-foreground);
  border: none;
  padding: 12px 24px;
  border-radius: var(--radius);
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  width: 100%;
  font-family: inherit;
  transition: opacity 0.15s;
}

.submit-btn:hover:not(:disabled) {
  opacity: 0.9;
}

.submit-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
</style>
