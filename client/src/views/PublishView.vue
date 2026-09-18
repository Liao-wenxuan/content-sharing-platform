<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { postsApi } from '@/api/posts'

const router = useRouter()
const auth = useAuthStore()

const content = ref('')
const topicTag = ref('')
const imageUrlsText = ref('')
const submitting = ref(false)
const errorMsg = ref('')

onMounted(() => {
  if (!auth.isLoggedIn) {
    router.push('/login')
  }
})

async function handleSubmit() {
  const text = content.value.trim()
  if (!text) {
    errorMsg.value = '内容不能为空'
    return
  }
  if (text.length > 500) {
    errorMsg.value = '内容不能超过 500 字'
    return
  }

  const imageUrls = imageUrlsText.value
    .split(/[\n,]/)
    .map(s => s.trim())
    .filter(s => s.length > 0)

  submitting.value = true
  errorMsg.value = ''

  try {
    await postsApi.createPost({
      content: text,
      imageUrls: imageUrls.length > 0 ? imageUrls : undefined,
      topicTag: topicTag.value.trim() || undefined
    })

    alert('发布成功！')
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
      <div class="field">
        <label>内容 <span class="required">*</span></label>
        <textarea
          v-model="content"
          rows="6"
          maxlength="500"
          placeholder="说点什么吧..."
        />
        <div class="counter">{{ content.length }} / 500</div>
      </div>

      <div class="field">
        <label>话题标签</label>
        <input
          v-model="topicTag"
          placeholder="例如：前端开发"
          maxlength="20"
        />
      </div>

      <div class="field">
        <label>图片 URL</label>
        <textarea
          v-model="imageUrlsText"
          rows="3"
          placeholder="多个 URL 用逗号或换行分隔"
        />
      </div>

      <div v-if="errorMsg" class="error">{{ errorMsg }}</div>

      <button type="submit" :disabled="submitting">
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
  transition: border-color 0.15s, box-shadow 0.15s;
}

.field input:focus,
.field textarea:focus {
  border-color: var(--ring);
  box-shadow: 0 0 0 3px rgb(0 0 0 / 0.05);
}

.field input::placeholder,
.field textarea::placeholder {
  color: var(--muted-foreground);
}

.field textarea {
  resize: vertical;
}

.counter {
  text-align: right;
  font-size: 12px;
  color: var(--muted-foreground);
  margin-top: 4px;
}

.error {
  color: var(--destructive);
  margin-bottom: 12px;
  font-size: 14px;
  background: #fef2f2;
  padding: 8px 12px;
  border-radius: var(--radius);
  border: 1px solid #fecaca;
}

button {
  background: var(--primary);
  color: var(--primary-foreground);
  border: none;
  padding: 10px 24px;
  border-radius: var(--radius);
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  width: 100%;
  font-family: inherit;
  transition: opacity 0.15s;
}

button:hover:not(:disabled) {
  opacity: 0.9;
}

button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>