<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { authApi } from '@/api/auth'

const router = useRouter()
const auth = useAuthStore()

const email = ref('')
const password = ref('')
const nickname = ref('')
const isRegister = ref(false)
const loading = ref(false)
const errorMsg = ref('')

async function handleSubmit() {
  if (!email.value || !password.value) {
    errorMsg.value = '请输入邮箱和密码'
    return
  }
  if (isRegister.value && !nickname.value) {
    errorMsg.value = '请输入昵称'
    return
  }

  loading.value = true
  errorMsg.value = ''

  try {
    const res = isRegister.value
      ? await authApi.register({
          email: email.value,
          password: password.value,
          nickname: nickname.value
        })
      : await authApi.login({
          email: email.value,
          password: password.value
        })

    auth.login(res.userInfo, res.accessToken)
    router.push('/')
  } catch (err: any) {
    console.error('登录失败', err)
    errorMsg.value = err.response?.data?.message || '请求失败，请检查后端是否启动'
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="login-page">
    <div class="card">
      <h1>{{ isRegister ? '注册' : '登录' }}</h1>

      <form @submit.prevent="handleSubmit">
        <input
          v-model="email"
          type="email"
          placeholder="邮箱"
          class="input"
        />
        <input
          v-model="password"
          type="password"
          placeholder="密码"
          class="input"
        />
        <input
          v-if="isRegister"
          v-model="nickname"
          placeholder="昵称"
          class="input"
        />

        <p v-if="errorMsg" class="error">{{ errorMsg }}</p>

        <button
          type="submit"
          :disabled="loading"
          class="btn"
        >
          {{ loading ? '处理中...' : (isRegister ? '注册' : '登录') }}
        </button>

        <button
          type="button"
          @click="isRegister = !isRegister"
          class="toggle-btn"
        >
          切换到{{ isRegister ? '登录' : '注册' }}
        </button>
      </form>
    </div>
  </div>
</template>

<style scoped>
.login-page {
  display: flex;
  justify-content: center;
  padding: 60px 20px;
}

.card {
  width: 100%;
  max-width: 380px;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 32px;
  box-shadow: var(--shadow-sm);
}

h1 {
  margin: 0 0 24px;
  font-size: 24px;
  font-weight: 600;
  color: var(--foreground);
  text-align: center;
}

form {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.input {
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
  box-sizing: border-box;
}

.input:focus {
  border-color: var(--ring);
  box-shadow: 0 0 0 3px rgb(0 0 0 / 0.05);
}

.input::placeholder {
  color: var(--muted-foreground);
}

.error {
  color: var(--destructive);
  font-size: 13px;
  margin: 0;
  background: #fef2f2;
  padding: 8px 12px;
  border-radius: var(--radius);
  border: 1px solid #fecaca;
}

.btn {
  width: 100%;
  padding: 10px 16px;
  background: var(--primary);
  color: var(--primary-foreground);
  border: none;
  border-radius: var(--radius);
  cursor: pointer;
  font-size: 14px;
  font-weight: 500;
  font-family: inherit;
  margin-top: 8px;
  transition: opacity 0.15s;
}

.btn:hover:not(:disabled) {
  opacity: 0.9;
}

.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.toggle-btn {
  width: 100%;
  padding: 8px 16px;
  background: transparent;
  color: var(--muted-foreground);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  cursor: pointer;
  font-size: 13px;
  font-family: inherit;
  transition: all 0.15s;
}

.toggle-btn:hover {
  background: var(--muted);
  color: var(--foreground);
  border-color: var(--foreground);
}
</style>