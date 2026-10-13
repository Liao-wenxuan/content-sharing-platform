<script setup lang="ts">
/**
 * 切换账号
 *
 * 解决的场景：一个人既要运营主号，又要点开小号看私信。
 * 没有这个功能只能「退出 → 登录」来回，每次都要输密码。
 *
 * ⚠️ **切换要重新输密码**，这看起来很烦，但它是必须的：
 * 服务端只存了 token 的**哈希**，拿到哈希算不出原 token。
 * 这是为了「数据库泄漏 ≠ 账号被接管」付出的代价 ——
 * 一个登录态切换功能不值得用可被直接复用的凭据来换。
 *
 * 另一个刻意的设计：**不显示 token、不显示完整邮箱**。
 * 列表里只给昵称和头像，因为这一屏可能被人看到。
 */
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { accountsApi, type DeviceAccount } from '@/api/accounts'
import { authApi } from '@/api/auth'
import { useAuthStore } from '@/stores/auth'
import { useToastStore } from '@/stores/toast'
import { formatRelative } from '@/utils/format'

const router = useRouter()
const auth = useAuthStore()
const toast = useToastStore()

const accounts = ref<DeviceAccount[]>([])
const loading = ref(true)
const errorMsg = ref('')

/** 正在切换的那个账号 id */
const switching = ref<number | null>(null)

onMounted(load)

async function load() {
  loading.value = true
  errorMsg.value = ''
  try {
    accounts.value = await accountsApi.list()
  } catch (e: any) {
    errorMsg.value = e?.response?.data?.message || '读取账号列表失败'
  } finally {
    loading.value = false
  }
}

async function switchTo(acc: DeviceAccount) {
  let input: { value: string } | null = null
  try {
    // 先问邮箱：用户往往记的是「小号是哪个邮箱」而不是「昵称叫啥」
    const { value } = await ElMessageBox.prompt(
      `切到「${acc.nickname}」需要重新登录。请输入这个账号的邮箱和密码。`,
      '切换账号',
      {
        confirmButtonText: '下一步',
        cancelButtonText: '取消',
        inputType: 'text',
        inputPlaceholder: '邮箱',
        inputValidator: (v) => {
          if (!v || !v.includes('@')) return '请输入邮箱'
          return true
        }
      }
    )
    input = { value }
  } catch {
    return // 取消了
  }

  let password: string
  try {
    const { value } = await ElMessageBox.prompt('再输入这个账号的密码', '切换账号', {
      confirmButtonText: '切换',
      cancelButtonText: '取消',
      inputType: 'password',
      inputValidator: (v) => (v && v.length >= 6 ? true : '密码至少 6 位')
    })
    password = value
  } catch {
    return
  }

  switching.value = acc.id
  try {
    const res = await authApi.login({ email: input.value, password })
    // 登录成功才替换登录态。反过来的话，
    // 用户输错密码就已经被踢出当前账号了
    auth.login(res.userInfo, res.accessToken)
    toast.show(`已切到「${res.userInfo.nickname}」`, 'success')
    router.push('/')
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.message || '切换失败：邮箱或密码错误')
  } finally {
    switching.value = null
  }
}

async function forget(acc: DeviceAccount) {
  let password: string
  try {
    const { value } = await ElMessageBox.prompt(
      `把「${acc.nickname}」从这台设备移除需要它的密码。`,
      '移除账号',
      {
        confirmButtonText: '移除',
        cancelButtonText: '取消',
        inputType: 'password',
        inputValidator: (v) => (v ? true : '请输入密码')
      }
    )
    password = value
  } catch {
    return
  }

  try {
    await accountsApi.remove(acc.id, password)
    await load()
    ElMessage.success('已从这台设备移除')
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.message || '移除失败')
  }
}
</script>

<template>
  <div class="panel">
    <p class="intro">
      这台设备登录过的账号。切换时需要重新输入密码 ——
      原因是服务端只保存了登录凭据的<b>哈希</b>，拿不到原凭据，
      换句话说即使数据库泄漏，攻击者也拿不到可直接使用的 token。
    </p>

    <el-alert v-if="errorMsg" type="error" :title="errorMsg" :closable="false" show-icon />

    <div v-loading="loading" class="list">
      <template v-if="!loading && accounts.length === 0">
        <p class="empty">这台设备还没有登录过任何账号。</p>
      </template>

      <div
        v-for="acc in accounts"
        :key="acc.id"
        class="acc"
        :class="{ current: acc.id === auth.user?.id }"
      >
        <el-avatar :size="34" class="acc-avatar">
          {{ acc.nickname?.slice(0, 1) || '?' }}
        </el-avatar>

        <div class="acc-text">
          <div class="acc-name">
            {{ acc.nickname }}
            <el-tag v-if="acc.id === auth.user?.id" size="small" effect="plain">当前</el-tag>
          </div>
          <div class="acc-meta">上次使用 {{ formatRelative(acc.lastUsedAt) }}</div>
        </div>

        <div class="acc-actions">
          <el-button
            v-if="acc.id !== auth.user?.id"
            size="small"
            :loading="switching === acc.id"
            @click="switchTo(acc)"
          >
            切换
          </el-button>
          <el-button v-if="acc.id !== auth.user?.id" size="small" text @click="forget(acc)">
            移除
          </el-button>
        </div>
      </div>
    </div>

    <p class="note">
      这里的「移除」只是让这台设备忘掉这个账号，<b>不会删除账号本身</b> ——
      它的笔记、订单和设置都不受影响。 真的要注销账号，那是一个需要单独确认的破坏性操作，
      而这个项目目前没有做（没做就不做成能点的按钮）。
    </p>
  </div>
</template>

<style scoped>
.intro {
  font-size: var(--fs-sm);
  color: var(--text-2);
  line-height: 1.8;
  margin: 0 0 16px;
  padding: 12px 14px;
  border-left: 2px solid var(--accent);
  background: var(--surface-2);
  border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
}

.intro b {
  color: var(--text-1);
}

.list {
  min-height: 80px;
  margin-bottom: 18px;
}

.acc {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 11px 12px;
  border: 1px solid var(--border-soft);
  border-radius: var(--radius-sm);
  margin-bottom: 8px;
}

.acc.current {
  border-color: var(--accent);
  background: var(--accent-muted);
}

.acc-avatar {
  flex-shrink: 0;
}

.acc-text {
  flex: 1;
  min-width: 0;
}

.acc-name {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: var(--fs-base);
  color: var(--text-1);
}

.acc-meta {
  font-size: var(--fs-xs);
  color: var(--text-3);
  margin-top: 2px;
}

.acc-actions {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
}

.empty {
  font-size: var(--fs-sm);
  color: var(--text-3);
  text-align: center;
  padding: 24px 0;
}

.note {
  font-size: var(--fs-xs);
  color: var(--text-3);
  line-height: 1.8;
  margin: 0;
}

.note b {
  color: var(--text-2);
}
</style>
