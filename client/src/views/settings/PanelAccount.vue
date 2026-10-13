<script setup lang="ts">
/**
 * 账号与安全：改密码
 *
 * 这一栏之前是一个点了只会弹「即将上线」的死按钮。
 * 现在它做的是**这件事唯一该做的事**：改密码。
 *
 * 流程上有两个容易被忽略的点：
 * 1. 改完密码服务端会让所有已签发的 token 失效，所以前端必须
 *    主动把用户送回登录页 —— 否则他手上的 token 已经废了，
 *    界面上却还显示「已登录」，下一次请求才 401，而报错信息
 *    会指向一个他刚做完的动作
 * 2. 密码输入框**不能回显当前密码**，也不用「显示密码」按钮 ——
 *    让用户确认自己新密码的输入错误是应该的，
 *    但让他读出旧密码没有必要
 */
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { settingsApi } from '@/api/settings'
import { useAuthStore } from '@/stores/auth'

const router = useRouter()
const auth = useAuthStore()

const currentPassword = ref('')
const newPassword = ref('')
const confirmPassword = ref('')
const submitting = ref(false)
const errorMsg = ref('')

async function submit() {
  errorMsg.value = ''

  if (!currentPassword.value) {
    errorMsg.value = '请输入当前密码'
    return
  }
  if (newPassword.value.length < 6) {
    errorMsg.value = '新密码至少 6 位'
    return
  }
  if (newPassword.value !== confirmPassword.value) {
    // 两次不一致是纯前端就能判的，不该白发一次请求
    errorMsg.value = '两次输入的新密码不一致'
    return
  }
  if (newPassword.value === currentPassword.value) {
    errorMsg.value = '新密码不能与当前密码相同'
    return
  }

  submitting.value = true
  try {
    await settingsApi.changePassword(currentPassword.value, newPassword.value)
    ElMessage.success('密码已修改，请重新登录')
    // 服务端已经让这个 token 失效了，继续留在页面上只会让下一次
    // 请求突然 401，而用户会以为是自己刚改密码改坏了
    auth.logout()
    router.push('/login')
  } catch (e: any) {
    errorMsg.value = e?.response?.data?.message || '修改失败，请稍后再试'
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <div class="panel">
    <section class="block">
      <h3 class="block-title">修改密码</h3>
      <p class="block-desc">
        修改后当前设备上的登录会失效，需要用新密码重新登录。
        这是刻意的：如果密码泄漏了，「改密码」必须真的能把它挡在外面。
      </p>

      <el-form label-position="top" class="form" @submit.prevent="submit">
        <el-form-item label="当前密码">
          <el-input
            v-model="currentPassword"
            type="password"
            placeholder="输入当前使用的密码"
            autocomplete="current-password"
          />
        </el-form-item>
        <el-form-item label="新密码">
          <el-input
            v-model="newPassword"
            type="password"
            placeholder="至少 6 位"
            autocomplete="new-password"
          />
        </el-form-item>
        <el-form-item label="确认新密码">
          <el-input
            v-model="confirmPassword"
            type="password"
            placeholder="再输入一次"
            autocomplete="new-password"
            @keyup.enter="submit"
          />
        </el-form-item>

        <el-alert
          v-if="errorMsg"
          type="error"
          :title="errorMsg"
          :closable="false"
          show-icon
          class="err"
        />

        <el-button type="primary" :loading="submitting" @click="submit">确认修改</el-button>
      </el-form>
    </section>

    <section class="block">
      <h3 class="block-title">这个账号的现状</h3>
      <ul class="facts">
        <li>
          昵称<b>{{ auth.user?.nickname || '-' }}</b>
        </li>
        <li>
          用户 ID<b class="tnum">{{ auth.user?.id ?? '-' }}</b>
        </li>
        <li>登录方式<b>邮箱 + 密码</b></li>
        <li>第三方绑定<b>未接入</b></li>
      </ul>
      <p class="note">
        「第三方绑定」写「未接入」而不是做成能点的按钮：
        这个项目没有接任何第三方登录，做成能点的话点了只能弹一句「即将上线」——
        而那正是这一页要消灭的东西。
      </p>
    </section>
  </div>
</template>

<style scoped>
.block {
  margin-bottom: 28px;
}

.block-title {
  font-size: var(--fs-md);
  font-weight: 600;
  color: var(--text-1);
  margin: 0 0 6px;
}

.block-desc {
  font-size: var(--fs-sm);
  color: var(--text-2);
  line-height: 1.7;
  margin: 0 0 14px;
}

.form :deep(.el-form-item) {
  margin-bottom: 14px;
}

.err {
  margin-bottom: 14px;
}

.facts {
  list-style: none;
  margin: 0;
  padding: 0;
}

.facts li {
  display: flex;
  justify-content: space-between;
  padding: 9px 0;
  border-bottom: 1px solid var(--border-soft);
  font-size: var(--fs-sm);
  color: var(--text-2);
}

.facts b {
  color: var(--text-1);
  font-weight: 500;
}

.note {
  margin: 12px 0 0;
  font-size: var(--fs-xs);
  color: var(--text-3);
  line-height: 1.7;
}
</style>
