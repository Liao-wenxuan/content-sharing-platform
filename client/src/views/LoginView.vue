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
import { ElMessage } from '@/utils/element'
import { User, Message, Lock, EditPen, ArrowLeft } from '@element-plus/icons-vue'
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

/**
 * 登录页是独立全屏布局（App.vue 不套三栏壳），窄屏下连底栏都没有。
 * 从底栏「发布 / 消息 / 关注」跳进来的游客如果没有账号又不给出口，
 * 就只能靠浏览器返回键 —— 手机上这一步几乎不可发现。
 * 所以给一条明确的「返回」，再给一条不用登录也能继续逛的入口。
 */
function goBack() {
  if (window.history.length > 1) router.back()
  else router.push('/')
}

function skipLogin() {
  router.push('/')
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
    <button type="button" class="auth-back" @click="goBack">
      <el-icon><ArrowLeft /></el-icon>
      <span>返回</span>
    </button>
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

      <button type="button" class="guest-skip" @click="skipLogin">不登录，先去逛逛</button>
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
  /* 必须显式 auto 外边距：.login-page 是整宽的 flex 子项，
     只写 max-width 的话卡片会贴左边而不是居中 */
  margin: 0 auto;
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
  border-radius: var(--radius-lg);
  background: var(--accent);
  color: #fff;
  font-weight: 700;
  font-size: var(--fs-xl);
  margin-bottom: 12px;
}

.brand-name {
  margin: 0 0 4px;
  font-size: var(--fs-xl);
  font-weight: 700;
  letter-spacing: -0.02em;
}

.brand-slogan {
  margin: 0;
  font-size: var(--fs-sm);
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
  font-size: var(--fs-sm);
  font-weight: 500;
}

.submit-btn {
  width: 100%;
  margin-top: 8px;
  font-weight: 600;
}

/*
 * 这两个出口只在窄屏出现：桌面端登录页保持原来的整屏构图，
 * 不动截图门禁里的桌面截图。窄屏没有侧栏也没有底栏，必须有显式出口。
 */
.auth-back,
.guest-skip {
  display: none;
}

@media (max-width: 768px) {
  .auth-back {
    position: fixed;
    top: calc(14px + env(safe-area-inset-top, 0px));
    left: 14px;
    z-index: 20;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 8px 12px;
    border: 1px solid var(--border);
    border-radius: var(--radius-full);
    background: var(--background);
    color: var(--foreground);
    font-family: inherit;
    font-size: var(--fs-sm);
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
  }

  .guest-skip {
    display: block;
    width: 100%;
    margin-top: 16px;
    padding: 10px;
    border: none;
    background: transparent;
    color: var(--text-2);
    font-family: inherit;
    font-size: var(--fs-sm);
    cursor: pointer;
  }
}
</style>
