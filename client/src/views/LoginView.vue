<script setup lang="ts">
/**
 * 登录 / 注册页
 *
 * 桌面端改造：手写 input / button → ElForm + ElInput + ElButton，
 * 登录与注册用 ElSegmented 切换（比两个互相 toggle 的按钮更清楚当前态）。
 * 页面本身是「独立全屏布局」（App.vue 不套三栏壳）。
 */
import { ref, computed } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { ElMessage } from 'element-plus'
import { User, Message, Lock, EditPen } from '@element-plus/icons-vue'
import { useAuthStore } from '@/stores/auth'
import { authApi } from '@/api/auth'

const router = useRouter()
const route = useRoute()
const auth = useAuthStore()

// 登录/注册成功后跳转目标：优先 ?redirect，否则首页
// 防御：redirect 只接受站内路径（避免开放重定向）
function resolveRedirect(): string {
  const r = route.query.redirect
  if (typeof r === 'string' && r.startsWith('/') && !r.startsWith('//')) {
    return r
  }
  return '/'
}

const mode = ref<'login' | 'register'>('login')
const email = ref('')
const password = ref('')
const nickname = ref('')
const loading = ref(false)
const errorMsg = ref('')

const isRegister = computed(() => mode.value === 'register')

const submitText = computed(() => {
  if (loading.value) return '处理中...'
  return isRegister.value ? '注册并登录' : '登录'
})

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
    ElMessage.success(
      isRegister.value ? '注册成功，欢迎加入' : `欢迎回来，${res.userInfo.nickname}`
    )
    router.push(resolveRedirect())
  } catch (err: any) {
    console.error('登录失败', err)
    errorMsg.value = err?.response?.data?.message || '请求失败，请检查后端是否启动'
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="login-page">
    <el-card shadow="never" class="login-card">
      <!-- 品牌 -->
      <div class="brand">
        <span class="brand-mark">拾</span>
        <h1 class="brand-name">内容社区</h1>
        <p class="brand-slogan">发现、分享、记录</p>
      </div>

      <el-segmented
        v-model="mode"
        class="mode-switch"
        :options="[
          { label: '登录', value: 'login' },
          { label: '注册', value: 'register' }
        ]"
      />

      <el-form label-position="top" class="login-form" @submit.prevent="handleSubmit">
        <el-form-item v-if="isRegister" label="昵称">
          <el-input
            v-model="nickname"
            size="large"
            placeholder="给自己起个名字"
            :prefix-icon="User"
          />
        </el-form-item>

        <el-form-item label="邮箱">
          <el-input
            v-model="email"
            type="email"
            size="large"
            placeholder="you@example.com"
            :prefix-icon="Message"
          />
        </el-form-item>

        <el-form-item label="密码">
          <el-input
            v-model="password"
            type="password"
            size="large"
            show-password
            placeholder="请输入密码"
            :prefix-icon="Lock"
            @keyup.enter="handleSubmit"
          />
        </el-form-item>

        <el-alert v-if="errorMsg" :title="errorMsg" type="error" show-icon :closable="false" />

        <el-button
          class="submit-btn"
          type="primary"
          size="large"
          :loading="loading"
          :icon="EditPen"
          @click="handleSubmit"
        >
          {{ submitText }}
        </el-button>
      </el-form>
    </el-card>
  </div>
</template>

<style scoped>
.login-page {
  width: 100%;
  padding: 24px;
}

.login-card {
  width: 100%;
  max-width: 400px;
}

.login-card :deep(.el-card__body) {
  padding: 32px 32px 28px;
}

/* ===== 品牌 ===== */
.brand {
  text-align: center;
  margin-bottom: 24px;
}

.brand-mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  border-radius: 12px;
  background: var(--accent);
  color: #fff;
  font-weight: 700;
  font-size: 22px;
  margin-bottom: 12px;
}

.brand-name {
  margin: 0 0 4px;
  font-size: 22px;
  font-weight: 700;
  letter-spacing: -0.02em;
}

.brand-slogan {
  margin: 0;
  font-size: 13px;
  color: var(--muted-foreground);
}

/* ===== 登录 / 注册切换 ===== */
.mode-switch {
  width: 100%;
  margin-bottom: 24px;
}

.mode-switch :deep(.el-segmented__item) {
  flex: 1;
  text-align: center;
}

/* ===== 表单 ===== */
.login-form :deep(.el-form-item) {
  margin-bottom: 18px;
}

.login-form :deep(.el-form-item__label) {
  font-size: 13px;
  font-weight: 500;
}

.submit-btn {
  width: 100%;
  margin-top: 8px;
  font-weight: 600;
}
</style>
