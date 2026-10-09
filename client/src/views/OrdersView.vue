<script setup lang="ts">
/**
 * 订单 /market/orders
 *
 * 两个 tab，两种身份：
 * - 我买的：付钱、取消、确认收货、申请退款
 * - 我卖的：发货
 *
 * 按钮渲染完全由 api/orders.ts 的 ORDER_ACTIONS 决定，
 * 模板里**不写 `if (order.status === 'x')`**——
 * 服务端那边也有一张 ALLOWED_TRANSITIONS，两边都各写一份 if 的话，
 * 规则一定会有一处对不上（已经错过一次：漏了 /follows/* 的高亮分支）。
 */
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { formatYuan } from '@/utils/money'
import { ordersApi, ORDER_ACTIONS, type Order, type OrderStatus } from '@/api/orders'
import { useCart } from '@/composables/useCart'
import { useToastStore } from '@/stores/toast'
import MarketTabs from '@/components/MarketTabs.vue'
import EmptyState from '@/components/EmptyState.vue'

const router = useRouter()
const toast = useToastStore()
const { load: refreshCart } = useCart()

const tab = ref<'buy' | 'sell'>('buy')

const buyOrders = ref<Order[]>([])
const sellOrders = ref<Order[]>([])
const total = ref(0)
const hasMore = ref(false)
const page = ref(1)

const loading = ref(false)
const loadingMore = ref(false)
const busy = ref(false)
const errorMsg = ref('')

/** 状态筛选：'' = 全部 */
const statusFilter = ref<OrderStatus | ''>('')
const FILTERS: { value: OrderStatus | ''; label: string }[] = [
  { value: '', label: '全部' },
  { value: 'pending', label: '待支付' },
  { value: 'paid', label: '待发货' },
  { value: 'shipped', label: '待收货' },
  { value: 'completed', label: '已完成' },
  { value: 'cancelled', label: '已取消' },
  { value: 'refunded', label: '已退款' }
]

async function load() {
  loading.value = true
  errorMsg.value = ''
  try {
    if (tab.value === 'buy') {
      const res = await ordersApi.list({
        page: 1,
        pageSize: 20,
        status: statusFilter.value || undefined
      })
      buyOrders.value = res.list
      total.value = res.pagination.total
      hasMore.value = res.pagination.hasMore
    } else {
      const res = await ordersApi.selling()
      sellOrders.value = res.list
      // 卖家视角服务端没分页，这里自己按筛选过一遍
      sellOrders.value = res.list.filter(
        (o) => !statusFilter.value || o.status === statusFilter.value
      )
      total.value = sellOrders.value.length
      hasMore.value = false
    }
    page.value = 1
  } catch (err: any) {
    errorMsg.value = err?.response?.data?.message || '加载订单失败'
  } finally {
    loading.value = false
  }
}

async function loadMore() {
  if (loadingMore.value || !hasMore.value) return
  loadingMore.value = true
  try {
    const next = page.value + 1
    const res = await ordersApi.list({
      page: next,
      pageSize: 20,
      status: statusFilter.value || undefined
    })
    const seen = new Set(buyOrders.value.map((o) => o.id))
    buyOrders.value = [...buyOrders.value, ...res.list.filter((o) => !seen.has(o.id))]
    page.value = next
    hasMore.value = res.pagination.hasMore
    total.value = res.pagination.total
  } catch {
    /* 停在当前页 */
  } finally {
    loadingMore.value = false
  }
}

const TAB_ACTION_LABEL: Record<string, string> = {
  pay: '立即支付',
  cancel: '取消订单',
  ship: '发货',
  confirm: '确认收货',
  refund: '申请退款'
}

/** 需要二次确认的动作 */
const NEED_CONFIRM: Record<string, string> = {
  cancel: '取消后库存会退回去，确定取消这笔订单？',
  refund: '退款会把钱退回余额，货也会退回库存。确定退款？'
}

async function onAction(order: Order, action: string) {
  if (NEED_CONFIRM[action]) {
    try {
      await ElMessageBox.confirm(NEED_CONFIRM[action], '确认操作', {
        type: 'warning',
        confirmButtonText: '确定',
        cancelButtonText: '取消'
      })
    } catch {
      return
    }
  }

  busy.value = true
  try {
    if (action === 'pay') {
      const paid = await ordersApi.pay(order.id)
      ElMessage.success(`支付成功，余额 ${formatYuan(paid.balanceCents)}`)
    } else if (action === 'cancel') {
      await ordersApi.cancel(order.id)
      ElMessage.success('订单已取消')
    } else if (action === 'ship') {
      await ordersApi.ship(order.id)
      ElMessage.success('已发货')
    } else if (action === 'confirm') {
      await ordersApi.confirm(order.id)
      ElMessage.success('已确认收货')
    } else if (action === 'refund') {
      await ordersApi.refund(order.id)
      ElMessage.success('已退款，钱已退回余额')
    }
    // 订单一变，购物车角标可能就不对了（下单会清车、取消会退库存）
    await refreshCart()
    await load()
  } catch (err: any) {
    toast.show(err?.response?.data?.message || '操作失败', 'error')
  } finally {
    busy.value = false
  }
}

const currentList = computed(() => (tab.value === 'buy' ? buyOrders.value : sellOrders.value))

/** 按 ORDER_ACTIONS 取按钮；没有可做的动作就一个都不渲染 */
function actionsFor(order: Order): string[] {
  const rule = ORDER_ACTIONS[order.status]
  return tab.value === 'buy' ? rule.buyer : rule.seller
}

const TAG_TYPE: Record<OrderStatus, 'info' | 'warning' | 'success' | 'danger' | 'primary'> = {
  pending: 'warning',
  paid: 'primary',
  shipped: 'primary',
  completed: 'success',
  cancelled: 'info',
  refunded: 'danger'
}

function switchTab(next: 'buy' | 'sell') {
  if (tab.value === next) return
  tab.value = next
  load()
}

/**
 * 状态筛选。
 *
 * ⚠️ 必须把新值写回 statusFilter 再 load：
 * 筛选组用的是单向 `:model-value`（不是 v-model），change 事件只带值、
 * 不会自己同步回 ref。少写这一行的话，点「待支付」会重新请求一次
 * 但带的还是空 status —— 筛选看着能点，实际永远返回全部。
 */
function onFilterChange(value: OrderStatus | '') {
  statusFilter.value = value
  load()
}

onMounted(load)
</script>

<template>
  <div class="orders">
    <MarketTabs />

    <header class="head">
      <h1 class="title">订单</h1>
      <el-radio-group :model-value="tab" @change="(v: any) => switchTab(v)">
        <el-radio-button value="buy">我买的</el-radio-button>
        <el-radio-button value="sell">我卖的</el-radio-button>
      </el-radio-group>
    </header>

    <div class="filters">
      <el-radio-group :model-value="statusFilter" size="small" @change="onFilterChange">
        <el-radio-button v-for="f in FILTERS" :key="f.value" :value="f.value">
          {{ f.label }}
        </el-radio-button>
      </el-radio-group>
    </div>

    <EmptyState
      v-if="loading && currentList.length === 0"
      variant="loading"
      title="正在加载订单..."
    />

    <EmptyState
      v-else-if="errorMsg"
      variant="error"
      :title="errorMsg"
      action="重试"
      @action="load"
    />

    <EmptyState
      v-else-if="currentList.length === 0"
      icon="📦"
      :title="tab === 'buy' ? '还没有订单' : '还没有人买你的东西'"
      :hint="
        tab === 'buy'
          ? '去市集看看，结算之后订单会出现在这里'
          : '在市集发布商品，有人买走就会出现在这里'
      "
      :action="tab === 'buy' ? '去逛逛' : '去发布'"
      @action="router.push('/market')"
    />

    <template v-else>
      <p class="total-line">共 {{ total }} 笔</p>

      <ul class="list">
        <li v-for="order in currentList" :key="order.id" class="order">
          <header class="order-head">
            <span class="order-no">订单 #{{ order.id }}</span>
            <el-tag :type="TAG_TYPE[order.status]" size="small" effect="plain">
              {{ order.statusText }}
            </el-tag>
          </header>

          <ul class="items">
            <li v-for="item in order.items" :key="item.productId" class="item">
              <RouterLink class="item-title" :to="`/market/product/${item.productId}`">
                {{ item.title }}
              </RouterLink>
              <span class="item-qty">× {{ item.quantity }}</span>
              <span class="item-sub">{{ formatYuan(item.subtotalCents) }}</span>
            </li>
          </ul>

          <footer class="order-foot">
            <span class="time">{{ new Date(order.createdAt).toLocaleString('zh-CN') }}</span>
            <span class="amount">
              共 {{ order.items.reduce((s, i) => s + i.quantity, 0) }} 件 ·
              <strong>{{ formatYuan(order.totalCents) }}</strong>
            </span>
            <div class="ops">
              <el-button
                v-for="act in actionsFor(order)"
                :key="act"
                :type="act === 'pay' ? 'primary' : 'default'"
                :loading="busy"
                size="small"
                @click="onAction(order, act)"
              >
                {{ TAB_ACTION_LABEL[act] }}
              </el-button>
            </div>
          </footer>
        </li>
      </ul>

      <div class="pager">
        <el-button v-if="hasMore" :loading="loadingMore" @click="loadMore">加载更多</el-button>
      </div>
    </template>
  </div>
</template>

<style scoped>
.orders {
  max-width: 860px;
  margin: 0 auto;
  padding: 24px 0 48px;
}

.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 12px;
}

.title {
  margin: 0;
  font-size: 20px;
  font-weight: 600;
  color: var(--foreground);
}

.filters {
  margin-bottom: 16px;
  overflow-x: auto;
}

.total-line {
  margin: 0 0 10px;
  font-size: 13px;
  color: var(--muted-foreground);
}

.list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.order {
  border: 1px solid var(--border);
  border-radius: 12px;
  margin-bottom: 14px;
  overflow: hidden;
}

.order-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 16px;
  background: var(--muted);
}

.order-no {
  font-size: 13px;
  color: var(--muted-foreground);
  font-variant-numeric: tabular-nums;
}

.items {
  list-style: none;
  margin: 0;
  padding: 4px 16px;
}

.item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 0;
}

.item-title {
  flex: 1;
  min-width: 0;
  font-size: 14px;
  color: var(--foreground);
  text-decoration: none;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.item-qty {
  font-size: 13px;
  color: var(--muted-foreground);
}

.item-sub {
  font-size: 13px;
  color: var(--muted-foreground);
  font-variant-numeric: tabular-nums;
  min-width: 64px;
  text-align: right;
}

.order-foot {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 12px 16px;
  border-top: 1px solid var(--border);
  flex-wrap: wrap;
}

.time {
  font-size: 12px;
  color: var(--muted-foreground);
}

.amount {
  margin-right: auto;
  font-size: 13px;
  color: var(--muted-foreground);
}

.amount strong {
  font-size: 17px;
  color: var(--accent);
  font-variant-numeric: tabular-nums;
}

.ops {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.pager {
  display: flex;
  justify-content: center;
  padding-top: 8px;
}
</style>
