<script setup lang="ts">
/**
 * 钱包 /market/wallet
 *
 * 余额 + 流水 + 充值。
 *
 * 这一页存在的意义是**可核对**：余额是一个缓存值（O(1) 查出来方便），
 * 真正的权威是 wallet_transactions —— 每一行都能求和算回当前余额。
 * 所以流水里必须带「变动后余额」这一列，用户（和面试官）能自己验。
 *
 * 充值是假的：真实场景这一步是第三方支付回调验签之后才加钱。
 * 这里就是「点了就加」，但走的结构和支付完全一样，
 * 换成真网关时只需要把「加钱」那段挪进回调里。
 */
import { ref, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import { Plus } from '@element-plus/icons-vue'
import { walletApi } from '@/api/wallet'
import { formatYuan, yuanToCents } from '@/utils/money'
import { useCart } from '@/composables/useCart'
import MarketTabs from '@/components/MarketTabs.vue'
import EmptyState from '@/components/EmptyState.vue'

const { load: refreshCart } = useCart()

const balanceCents = ref(0)
const transactions = ref<Awaited<ReturnType<typeof walletApi.info>>['list']>([])
const total = ref(0)
const hasMore = ref(false)
const page = ref(1)

const loading = ref(false)
const loadingMore = ref(false)
const errorMsg = ref('')

async function load() {
  loading.value = true
  errorMsg.value = ''
  try {
    const res = await walletApi.info({ page: 1, pageSize: 20 })
    balanceCents.value = res.balanceCents
    transactions.value = res.list
    total.value = res.pagination.total
    hasMore.value = res.pagination.hasMore
    page.value = 1
  } catch (err: any) {
    errorMsg.value = err?.response?.data?.message || '加载钱包失败'
  } finally {
    loading.value = false
  }
}

async function loadMore() {
  if (loadingMore.value || !hasMore.value) return
  loadingMore.value = true
  try {
    const next = page.value + 1
    const res = await walletApi.info({ page: next, pageSize: 20 })
    const seen = new Set(transactions.value.map((t) => t.id))
    transactions.value = [...transactions.value, ...res.list.filter((t) => !seen.has(t.id))]
    page.value = next
    hasMore.value = res.pagination.hasMore
    total.value = res.pagination.total
  } catch {
    /* 停在当前页 */
  } finally {
    loadingMore.value = false
  }
}

// ===== 充值 =====
const topupVisible = ref(false)
const topupYuan = ref('')
const topupError = ref('')
const toppingUp = ref(false)

const PRESETS = [10, 50, 100, 500]

function openTopup(amount?: number) {
  topupYuan.value = amount ? String(amount) : ''
  topupError.value = ''
  topupVisible.value = true
}

async function submitTopup() {
  const cents = yuanToCents(topupYuan.value)
  if (cents === null) {
    topupError.value = '金额最多两位小数，且不能为空'
    return
  }
  toppingUp.value = true
  topupError.value = ''
  try {
    const res = await walletApi.topUp(cents)
    balanceCents.value = res.balanceCents
    topupVisible.value = false
    ElMessage.success(`充值成功，余额 ${formatYuan(res.balanceCents)}`)
    await load()
    // 余额变了，购物车里那个「余额不够」的判断也得跟着变
    await refreshCart()
  } catch (err: any) {
    topupError.value = err?.response?.data?.message || '充值失败'
  } finally {
    toppingUp.value = false
  }
}

onMounted(load)
</script>

<template>
  <div class="wallet">
    <MarketTabs />

    <header class="head">
      <h1 class="title">钱包</h1>
      <el-button type="primary" :icon="Plus" @click="openTopup()">充值</el-button>
    </header>

    <section class="balance-card">
      <p class="balance-label">余额</p>
      <p class="balance-value">{{ formatYuan(balanceCents) }}</p>
      <p class="balance-note">站内余额就是本站唯一的支付方式。每一笔支付都会写一条可核对的流水。</p>
    </section>

    <h2 class="section-title">流水 · 共 {{ total }} 笔</h2>

    <EmptyState
      v-if="loading && transactions.length === 0"
      variant="loading"
      title="正在加载流水..."
    />

    <EmptyState
      v-else-if="errorMsg"
      variant="error"
      :title="errorMsg"
      action="重试"
      @action="load"
    />

    <EmptyState
      v-else-if="transactions.length === 0"
      icon="🧾"
      title="还没有流水"
      hint="充值、支付、退款都会在这里留下一条记录"
      action="充点试试"
      @action="openTopup()"
      compact
    />

    <template v-else>
      <table class="tx-table">
        <thead>
          <tr>
            <th>时间</th>
            <th>事由</th>
            <th class="num">变动</th>
            <th class="num">变动后余额</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="tx in transactions" :key="tx.id">
            <td class="time">{{ new Date(tx.createdAt).toLocaleString('zh-CN') }}</td>
            <td>
              {{ tx.reasonText }}
              <RouterLink v-if="tx.refOrderId" class="ref" :to="`/market/orders`">
                #{{ tx.refOrderId }}
              </RouterLink>
            </td>
            <td class="num" :class="tx.deltaCents >= 0 ? 'plus' : 'minus'">
              {{ tx.deltaCents >= 0 ? '+' : '' }}{{ formatYuan(tx.deltaCents) }}
            </td>
            <td class="num muted">{{ formatYuan(tx.balanceAfterCents) }}</td>
          </tr>
        </tbody>
      </table>

      <div class="pager">
        <el-button v-if="hasMore" :loading="loadingMore" @click="loadMore">加载更多</el-button>
        <span v-else class="no-more">— 已经到底了 —</span>
      </div>
    </template>

    <el-dialog v-model="topupVisible" title="充值" width="380px">
      <div class="presets">
        <el-button
          v-for="amount in PRESETS"
          :key="amount"
          size="small"
          :type="topupYuan === String(amount) ? 'primary' : 'default'"
          @click="openTopup(amount)"
        >
          ¥{{ amount }}
        </el-button>
      </div>

      <el-input v-model="topupYuan" placeholder="输入金额" size="large">
        <template #prepend>¥</template>
      </el-input>

      <p class="topup-note">
        演示环境直接加余额，没有接第三方支付。走的是和下单支付完全一样的 「加余额 + 写流水」事务。
      </p>

      <p v-if="topupError" class="topup-error">{{ topupError }}</p>

      <template #footer>
        <el-button @click="topupVisible = false">取消</el-button>
        <el-button type="primary" :loading="toppingUp" @click="submitTopup">确认充值</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.wallet {
  max-width: 780px;
  margin: 0 auto;
  padding: 24px 0 48px;
}

.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
}

.title {
  margin: 0;
  font-size: 20px;
  font-weight: 600;
  color: var(--foreground);
}

.balance-card {
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 20px;
  background: var(--muted);
  margin-bottom: 24px;
}

.balance-label {
  margin: 0;
  font-size: 13px;
  color: var(--muted-foreground);
}

.balance-value {
  margin: 4px 0 8px;
  font-size: 32px;
  font-weight: 700;
  color: var(--foreground);
  font-variant-numeric: tabular-nums;
}

.balance-note {
  margin: 0;
  font-size: 12px;
  color: var(--muted-foreground);
  line-height: 1.6;
}

.section-title {
  margin: 0 0 12px;
  font-size: 15px;
  font-weight: 600;
  color: var(--foreground);
}

.tx-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

.tx-table th {
  text-align: left;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border);
  color: var(--muted-foreground);
  font-weight: 500;
}

.tx-table td {
  padding: 10px;
  border-bottom: 1px solid var(--border);
  color: var(--foreground);
}

.num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.plus {
  color: #16a34a;
}

.minus {
  color: var(--foreground);
}

.muted {
  color: var(--muted-foreground);
}

.time {
  color: var(--muted-foreground);
  white-space: nowrap;
}

.ref {
  margin-left: 4px;
  color: var(--accent);
  text-decoration: none;
  font-variant-numeric: tabular-nums;
}

.pager {
  display: flex;
  justify-content: center;
  padding-top: 18px;
}

.no-more {
  font-size: 13px;
  color: var(--muted-foreground);
}

.presets {
  display: flex;
  gap: 8px;
  margin-bottom: 12px;
}

.topup-note {
  margin: 10px 0 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--muted-foreground);
}

.topup-error {
  margin: 6px 0 0;
  font-size: 13px;
  color: var(--el-color-danger);
}
</style>
