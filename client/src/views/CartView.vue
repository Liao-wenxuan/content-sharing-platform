<script setup lang="ts">
/**
 * 购物车 /market/cart
 *
 * 页面结构不是「一堆行 + 一个总合计」，而是**按卖家分组的若干块**，
 * 每块一个结算按钮。这不是界面偏好，是服务端约束的直接后果：
 * 一笔订单只能包含一个卖家的商品（POST /api/orders 要传 sellerId，
 * 从车里按卖家取货），所以购物车里混着三个卖家的货时，
 * 根本没有「一起结算」这个动作 —— 点了也不知道该发给谁。
 *
 * 不可结算的行（已下架 / 库存不够）仍然显示，但不参与合计，
 * 并明确告诉用户为什么不能结算 —— 静默隐藏会让用户以为购物车被吞了。
 */
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Delete } from '@element-plus/icons-vue'
import { formatYuan } from '@/utils/money'
import { useCart } from '@/composables/useCart'
import { ordersApi } from '@/api/orders'
import { walletApi } from '@/api/wallet'
import { useToastStore } from '@/stores/toast'
import MarketTabs from '@/components/MarketTabs.vue'
import EmptyState from '@/components/EmptyState.vue'

const router = useRouter()
const toast = useToastStore()
const { list, totalCents, groups, load, setQuantity, remove, clear } = useCart()

const loading = ref(false)
const busy = ref(false)

async function refresh() {
  loading.value = true
  await load()
  loading.value = false
}

async function onQuantityChange(productId: number, quantity: number) {
  if (quantity < 1) return
  busy.value = true
  const ok = await setQuantity(productId, quantity)
  busy.value = false
  if (!ok) {
    toast.show('修改数量失败', 'error')
    await refresh()
  }
}

async function onRemove(productId: number, title: string) {
  try {
    await ElMessageBox.confirm(`把「${title}」从购物车移除？`, '移除商品', {
      type: 'warning',
      confirmButtonText: '移除',
      cancelButtonText: '取消'
    })
  } catch {
    return
  }
  busy.value = true
  const ok = await remove(productId)
  busy.value = false
  if (ok) toast.show('已移除', 'success')
  else toast.show('移除失败', 'error')
}

async function onClearAll() {
  try {
    await ElMessageBox.confirm('清空购物车里的全部商品？其他卖家的也会一起清掉。', '清空购物车', {
      type: 'warning',
      confirmButtonText: '清空',
      cancelButtonText: '取消'
    })
  } catch {
    return
  }
  busy.value = true
  const ok = await clear()
  busy.value = false
  if (ok) ElMessage.success('已清空')
  else ElMessage.error('清空失败')
}

// ===== 结算 =====
// 顺序是「先下单拿到 order，再支付」：
// POST /orders 里就扣了库存并生成待支付订单，POST /orders/:id/pay 才动钱。
// 两步之间订单是可以取消的（库存会退回去），这就是「待支付」这个状态存在的意义。
const payVisible = ref(false)
const paying = ref(false)
const payError = ref('')
const activeSellerId = ref(0)
const activeSellerName = ref('')
const activeAmount = ref(0)
const orderId = ref(0)
/** 打开结算框时读一次余额，用来提示「余额不够」 */
const balanceAtOpen = ref(0)

const activeGroup = computed(() => groups.value.find((g) => g.sellerId === activeSellerId.value))

async function openPay(sellerId: number, sellerNickname: string, amountCents: number) {
  if (amountCents <= 0) return
  payError.value = ''
  orderId.value = 0
  activeSellerId.value = sellerId
  activeSellerName.value = sellerNickname
  activeAmount.value = amountCents
  try {
    const w = await walletApi.info({ page: 1, pageSize: 1 })
    balanceAtOpen.value = w.balanceCents
  } catch {
    balanceAtOpen.value = 0
  }
  payVisible.value = true
}

async function doPay() {
  if (!orderId.value) return
  paying.value = true
  payError.value = ''
  try {
    await ordersApi.pay(orderId.value)
    payVisible.value = false
    ElMessage.success('支付成功')
    router.push('/market/orders')
  } catch (err: any) {
    payError.value = err?.response?.data?.message || '支付失败'
  } finally {
    paying.value = false
  }
}

async function createOrder() {
  paying.value = true
  payError.value = ''
  try {
    const order = await ordersApi.create(activeSellerId.value)
    orderId.value = order.id
    // 服务端下单时会清掉这位卖家在车里的行，客户端必须跟着刷新。
    // 不刷的话用户关掉对话框会看到还在车里的商品，再点一次结算就是
    // 「购物车里没有这位卖家的商品」409 —— 一个自己制造、自己又不解释的错。
    await load()
  } catch (err: any) {
    payError.value = err?.response?.data?.message || '下单失败'
    // 下单失败多半是库存被别人买走了，服务端已经把车里的行留着，
    // 刷新一下让用户看到最新的库存数
    await refresh()
  } finally {
    paying.value = false
  }
}

const notEnough = computed(() => balanceAtOpen.value < activeAmount.value)

onMounted(refresh)
</script>

<template>
  <div class="cart-view">
    <MarketTabs />

    <header class="head">
      <div>
        <h1 class="title">
          购物车 <span class="count">{{ list.length }} 件商品</span>
        </h1>
        <p class="subtitle">一次只能结算一位卖家的商品，所以按卖家分开结算</p>
      </div>
      <el-button
        v-if="list.length > 0"
        type="danger"
        plain
        size="small"
        :loading="busy"
        @click="onClearAll"
      >
        清空
      </el-button>
    </header>

    <EmptyState v-if="loading && list.length === 0" variant="loading" title="正在加载购物车..." />

    <EmptyState
      v-else-if="list.length === 0"
      icon="🛒"
      title="购物车还是空的"
      hint="看中什么就加进来，一笔订单只能有一位卖家，所以同类商品也会分开结算"
      action="去逛逛"
      @action="router.push('/market')"
    />

    <template v-else>
      <section v-for="group in groups" :key="group.sellerId" class="group">
        <header class="group-head">
          <RouterLink class="seller-name" :to="`/profile/${group.sellerId}`">
            {{ group.sellerNickname }}
          </RouterLink>
          <span class="group-meta">{{ group.items.length }} 件</span>
        </header>

        <ul class="rows">
          <li
            v-for="item in group.items"
            :key="item.productId"
            class="row"
            :class="{ dim: item.unavailable }"
          >
            <RouterLink class="thumb" :to="`/market/product/${item.productId}`">
              <img v-if="item.coverImage" :src="item.coverImage" :alt="item.title" />
              <span v-else class="thumb-fallback">{{ item.title.slice(0, 1) }}</span>
            </RouterLink>

            <div class="row-info">
              <RouterLink class="row-title" :to="`/market/product/${item.productId}`">
                {{ item.title }}
              </RouterLink>
              <p class="row-price">{{ formatYuan(item.priceCents) }} × {{ item.quantity }}</p>

              <!-- 为什么不能结算要说出来。静默禁用会让用户以为东西被吞了 -->
              <p v-if="item.status === 'off_shelf'" class="row-warn">卖家已下架</p>
              <p v-else-if="item.stock < item.quantity" class="row-warn">
                库存只剩 {{ item.stock }} 件，减一件才能结算
              </p>
            </div>

            <div class="row-ops">
              <span class="subtotal">{{ formatYuan(item.subtotalCents) }}</span>
              <el-input-number
                :model-value="item.quantity"
                :min="1"
                :max="99"
                :disabled="busy || item.status === 'off_shelf'"
                size="small"
                controls-position="right"
                @change="(v: number | undefined) => v && onQuantityChange(item.productId, v)"
              />
              <el-button
                text
                :icon="Delete"
                size="small"
                :disabled="busy"
                aria-label="移除"
                @click="onRemove(item.productId, item.title)"
              />
            </div>
          </li>
        </ul>

        <footer class="group-foot">
          <span class="foot-note">
            <template v-if="group.payableCount === 0">这家的货都还不能结算</template>
            <template v-else-if="group.payableCount < group.items.length">
              只结算可用的 {{ group.payableCount }} 件
            </template>
          </span>
          <span class="foot-total">
            合计 <strong>{{ formatYuan(group.subtotalCents) }}</strong>
          </span>
          <el-button
            type="primary"
            :disabled="group.payableCount === 0 || busy"
            @click="openPay(group.sellerId, group.sellerNickname, group.subtotalCents)"
          >
            结算这一家
          </el-button>
        </footer>
      </section>

      <p class="grand-total">
        全车合计 <strong>{{ formatYuan(totalCents) }}</strong>
        <span class="hint">（实际要付的是各家的合计，因为分次结算）</span>
      </p>
    </template>

    <!-- 结算：站内余额支付 -->
    <el-dialog v-model="payVisible" title="结算" width="420px">
      <div v-if="!orderId" class="pay-confirm">
        <p class="pay-row">
          <span>卖家</span><strong>{{ activeSellerName }}</strong>
        </p>
        <p class="pay-row">
          <span>商品</span>
          <strong>{{ activeGroup?.payableCount ?? 0 }} 件</strong>
        </p>
        <p class="pay-row big">
          <span>应付</span><strong class="amount">{{ formatYuan(activeAmount) }}</strong>
        </p>

        <!-- 支付方式：只有一个真的实现了 -->
        <div class="pay-methods">
          <div class="method active">
            <span class="method-name">站内余额</span>
            <span class="method-tag">已接入</span>
          </div>
          <!-- 微信/支付宝没接 SDK，置灰且写明原因。
               做成可点的话，点了只能弹一句「模拟成功」，那比没有更糟 -->
          <div class="method disabled">
            <span class="method-name">微信支付</span>
            <span class="method-tag off">未接入</span>
          </div>
          <div class="method disabled">
            <span class="method-name">支付宝</span>
            <span class="method-tag off">未接入</span>
          </div>
        </div>

        <p class="pay-balance">当前余额 {{ formatYuan(balanceAtOpen) }}</p>
        <p v-if="notEnough" class="pay-warn">余额不够，先去钱包充值再来。</p>

        <p v-if="payError" class="pay-error">{{ payError }}</p>
      </div>

      <div v-else class="pay-confirm">
        <p class="pay-row">
          <span>订单</span><strong>#{{ orderId }}</strong>
        </p>
        <p class="pay-row big">
          <span>应付</span><strong class="amount">{{ formatYuan(activeAmount) }}</strong>
        </p>
        <p class="pay-note">
          订单已创建，库存已经占用。现在付款会真的从站内余额扣款并写一条账本流水。
        </p>
        <p v-if="payError" class="pay-error">{{ payError }}</p>
      </div>

      <template #footer>
        <el-button @click="payVisible = false">{{ orderId ? '稍后支付' : '取消' }}</el-button>
        <el-button
          v-if="!orderId"
          type="primary"
          :loading="paying"
          :disabled="notEnough"
          @click="createOrder"
        >
          {{ notEnough ? '余额不足' : '确认下单' }}
        </el-button>
        <el-button v-else type="primary" :loading="paying" @click="doPay">立即支付</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.cart-view {
  max-width: 900px;
  margin: 0 auto;
  padding: 24px 0 48px;
}

.head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 18px;
}

.title {
  margin: 0;
  font-size: 20px;
  font-weight: 600;
  color: var(--foreground);
}

.count {
  font-size: 14px;
  font-weight: 400;
  color: var(--muted-foreground);
}

.subtitle {
  margin: 6px 0 0;
  font-size: 13px;
  color: var(--muted-foreground);
}

/* ===== 卖家分组 ===== */
.group {
  border: 1px solid var(--border);
  border-radius: 12px;
  margin-bottom: 16px;
  overflow: hidden;
}

.group-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  background: var(--muted);
}

.seller-name {
  font-size: 14px;
  font-weight: 600;
  color: var(--foreground);
  text-decoration: none;
}

.group-meta {
  font-size: 12px;
  color: var(--muted-foreground);
}

.rows {
  list-style: none;
  margin: 0;
  padding: 0;
}

.row {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 14px 16px;
  border-top: 1px solid var(--border);
}

/* 不能结算的行压暗，但不隐藏 —— 隐藏等于让用户以为商品不见了 */
.row.dim {
  opacity: 0.55;
}

.thumb {
  width: 68px;
  height: 68px;
  flex-shrink: 0;
  border-radius: 8px;
  overflow: hidden;
  background: var(--muted);
  display: flex;
  align-items: center;
  justify-content: center;
}

.thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.thumb-fallback {
  font-size: 24px;
  font-weight: 700;
  color: var(--muted-foreground);
  opacity: 0.6;
}

.row-info {
  flex: 1;
  min-width: 0;
}

.row-title {
  font-size: 14px;
  color: var(--foreground);
  text-decoration: none;
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row-price {
  margin: 4px 0 0;
  font-size: 13px;
  color: var(--muted-foreground);
  font-variant-numeric: tabular-nums;
}

.row-warn {
  margin: 4px 0 0;
  font-size: 12px;
  color: var(--el-color-danger);
}

.row-ops {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
}

.subtotal {
  font-size: 15px;
  font-weight: 600;
  color: var(--accent);
  font-variant-numeric: tabular-nums;
  min-width: 70px;
  text-align: right;
}

.group-foot {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 14px;
  padding: 12px 16px;
  border-top: 1px solid var(--border);
  background: var(--muted);
}

.foot-note {
  margin-right: auto;
  font-size: 12px;
  color: var(--muted-foreground);
}

.foot-total {
  font-size: 13px;
  color: var(--muted-foreground);
}

.foot-total strong {
  font-size: 18px;
  color: var(--accent);
  font-variant-numeric: tabular-nums;
}

.grand-total {
  margin: 8px 0 0;
  font-size: 13px;
  color: var(--muted-foreground);
  text-align: right;
}

.grand-total strong {
  font-size: 16px;
  color: var(--foreground);
  font-variant-numeric: tabular-nums;
}

.hint {
  margin-left: 6px;
  font-size: 12px;
}

/* ===== 结算对话框 ===== */
.pay-row {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  margin: 0 0 8px;
  font-size: 14px;
  color: var(--muted-foreground);
}

.pay-row strong {
  color: var(--foreground);
}

.pay-row.big {
  margin: 14px 0;
  padding-top: 12px;
  border-top: 1px solid var(--border);
}

.amount {
  font-size: 24px;
  font-weight: 700;
  color: var(--accent);
  font-variant-numeric: tabular-nums;
}

.pay-methods {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 12px;
}

.method {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  font-size: 14px;
}

.method.active {
  border-color: var(--accent);
  background: var(--muted);
}

.method.disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.method-tag {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 10px;
  background: var(--accent);
  color: #fff;
}

.method-tag.off {
  background: var(--muted-foreground);
}

.pay-balance {
  margin: 0;
  font-size: 13px;
  color: var(--muted-foreground);
}

.pay-warn {
  margin: 4px 0 0;
  font-size: 13px;
  color: var(--el-color-danger);
}

.pay-note {
  margin: 12px 0 0;
  font-size: 13px;
  line-height: 1.6;
  color: var(--muted-foreground);
}

.pay-error {
  margin: 8px 0 0;
  font-size: 13px;
  color: var(--el-color-danger);
}
</style>
