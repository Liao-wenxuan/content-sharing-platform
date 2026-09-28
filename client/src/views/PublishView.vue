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
import type { UploadFile } from 'element-plus'
import { ElMessage, ElMessageBox } from 'element-plus'
import { PictureFilled, UploadFilled } from '@element-plus/icons-vue'
import { useAuthStore } from '@/stores/auth'
import { useToastStore } from '@/stores/toast'
import { postsApi } from '@/api/posts'
import {
  POST_CONTENT_MAX_LENGTH,
  UPLOAD_MAX_IMAGES,
  UPLOAD_MAX_SIZE_MB,
  UPLOAD_MAX_SIZE_BYTES,
  UPLOAD_TIMEOUT_MS,
  DEFAULT_API_BASE
} from '@/constants'

const router = useRouter()
const auth = useAuthStore()
const toast = useToastStore()

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

// ===== 文件选择 =====
// ElUpload 关闭了自动上传（auto-upload=false），
// 所以这里在 on-change 阶段自己走校验 + 触发上传。
function handleUploadChange(uploadFile: UploadFile) {
  const file = uploadFile.raw
  if (!file) return
  addFiles([file])
}

function addFiles(files: File[]) {
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
      status: 'pending',
      progress: 0
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

// ===== 取消 =====
async function onCancel() {
  // 有内容时给提示确认；否则直接返回
  if (content.value.trim() || topicTag.value.trim() || images.value.length > 0) {
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
      <h1 class="page-title">发布笔记</h1>
      <p class="page-subtitle">记录当下，分享你的生活与想法</p>
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

          <el-form-item label="话题标签">
            <el-input v-model="topicTag" placeholder="例如：前端开发" :maxlength="20" clearable />
          </el-form-item>

          <el-form-item>
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
                    <el-tag v-else type="info" size="small" effect="plain">
                      {{ img.progress }}%
                    </el-tag>
                  </div>
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
          <ul class="tips-list">
            <li>正文最多 {{ POST_CONTENT_MAX_LENGTH }} 字，说清楚一件事就够了。</li>
            <li>最多上传 {{ MAX_IMAGES }} 张图片，单张不超过 {{ MAX_SIZE_MB }}MB。</li>
            <li>图片会在选择后立即上传，全部上传完成才能发布。</li>
            <li>话题标签建议只填一个，太多反而没人点。</li>
          </ul>
        </el-card>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.publish {
  max-width: var(--content-max-width);
  margin: 0 auto;
}

.page-header {
  margin-bottom: 20px;
}

.page-title {
  font-size: 28px;
  font-weight: 700;
  letter-spacing: -0.02em;
  margin: 0;
  color: var(--foreground);
}

.page-subtitle {
  margin: 6px 0 0;
  font-size: 14px;
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
  font-size: 14px;
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
  font-size: 12px;
  font-weight: 400;
  color: var(--muted-foreground);
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
  font-size: 14px;
  color: var(--foreground);
}

.upload-text em {
  color: var(--accent);
  font-style: normal;
}

.upload-hint {
  margin: 6px 0 0;
  font-size: 12px;
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
  border-radius: 8px;
}

.image-preview {
  width: 56px;
  height: 56px;
  object-fit: cover;
  border-radius: 6px;
  flex-shrink: 0;
  background: var(--muted);
}

.image-info {
  flex: 1;
  min-width: 0;
}

.image-name {
  display: block;
  font-size: 13px;
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
}

.tips-title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-weight: 600;
  font-size: 14px;
}

.tips-list {
  margin: 0;
  padding-left: 18px;
  font-size: 13px;
  line-height: 1.9;
  color: var(--muted-foreground);
}
</style>
