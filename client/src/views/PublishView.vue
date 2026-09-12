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

// 页面加载时检查登录
onMounted(() => {
  if (!auth.isLoggedIn) {
    router.push('/login')
  }
})

async function handleSubmit() {
  // 1. 客户端预校验
  const text = content.value.trim()
  if (!text) {
    errorMsg.value = '内容不能为空'
    return
  }
  if (text.length > 500) {
    errorMsg.value = '内容不能超过 500 字'
    return
  }

  // 2. 解析图片 URL（逗号或换行分隔）
  const imageUrls = imageUrlsText.value
    .split(/[\n,]/)
    .map(s => s.trim())
    .filter(s => s.length > 0)

  // 3. 提交
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
        <label>内容（必填，500 字以内）</label>
        <textarea
          v-model="content"
          rows="6"
          maxlength="500"
          placeholder="说点什么吧..."
        />
        <div class="counter">{{ content.length }} / 500</div>
      </div>

      <div class="field">
        <label>话题标签（可选）</label>
        <input
          v-model="topicTag"
          placeholder="例如：前端开发"
          maxlength="20"
        />
      </div>

      <div class="field">
        <label>图片 URL（可选，多个用逗号或换行分隔）</label>
        <textarea
          v-model="imageUrlsText"
          rows="3"
          placeholder="https://example.com/img1.jpg&#10;https://example.com/img2.jpg"
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
  padding: 30px 20px;
}

h1 {
  margin-bottom: 24px;
  color: #333;
}

.field {
  margin-bottom: 20px;
}

.field label {
  display: block;
  margin-bottom: 8px;
  font-weight: 600;
  color: #333;
  font-size: 14px;
}

.field input,
.field textarea {
  width: 100%;
  padding: 10px 12px;
  border: 1px solid #ddd;
  border-radius: 6px;
  font-size: 14px;
  font-family: inherit;
  box-sizing: border-box;
  outline: none;
  transition: border-color 0.2s;
}

.field input:focus,
.field textarea:focus {
  border-color: #ff2442;
}

.field textarea {
  resize: vertical;
}

.counter {
  text-align: right;
  font-size: 12px;
  color: #999;
  margin-top: 4px;
}

.error {
  color: #e74c3c;
  margin-bottom: 12px;
  font-size: 14px;
  background: #fff5f5;
  padding: 8px 12px;
  border-radius: 4px;
}

button {
  background: #ff2442;
  color: white;
  border: none;
  padding: 12px 24px;
  border-radius: 6px;
  font-size: 16px;
  font-weight: 600;
  cursor: pointer;
  width: 100%;
  transition: background 0.2s;
}

button:hover:not(:disabled) {
  background: #e0203a;
}

button:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
</style>