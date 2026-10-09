<script setup lang="ts">
/**
 * 商品详情 /market/product/:id
 *
 * 一页两副面孔，靠 `isMine` 切换：
 * - 别人的商品：看图、加购
 * - 自己的商品：改价 / 改库存 / 上下架
 *
 * 「自己的」判断用 `product.sellerId === auth.user?.id`，
 * **不用**「进详情页时是不是登录了」——
 * 那样会漏掉「未登录但其实是自己的商品」（比如清了 token 又逛回来），
 * 更会错把别人的商品当成自己的给出发货按钮。
 */
import { ref, computed, onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { ShoppingCart, ArrowLeft } from '@element-plus/icons-vue'
import { productsApi, type Product } from '@/api/products'
import { formatYuan, yuanToCents } from '@/utils/money'
import { useAuthStore } from '@/stores/auth'
import { useToastStore } from '@/stores/toast'
import { useCart } from '@/composables/useCart'
import MarketTabs from '@/components/MarketTabs.vue'
import EmptyState from '@/components/EmptyState.vue'

const props = defineProps<{ id: string }>()

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const toast = useToastStore()
const { add, load: loadCart } = useCart()

const product = ref<Product | null>(null)
const loading = ref(false)
const errorMsg = ref('')
const quantity = ref(1)
const adding = ref(false)

const isMine = computed(() => !!product.value && product.value.sellerId === auth.user?.id)
const soldOut = computed(() => !product.value || product.value.stock <= 0)
const offShelf = computed(() => product.value?.status === 'off_shelf')
const canBuy = computed(() => !soldOut.value && !offShelf.value)

async function load() {
  loading.value = true
  errorMsg.value = ''
  quantity.value = 1
  try {
    product.value = await productsApi.detail(Number(props.id))
  } catch (err: any) {
    // 404 在这里不是「临时失败」，是「这件商品不存在或对你不可见」，
    // 所以给一个能明确引导的空态，而不是重试按钮
    const status = err?.response?.status
    errorMsg.value =
      status === 404
        ? '这件商品不存在，或者已被卖家下架'
        : err?.response?.data?.message || '加载失败'
  } finally {
    loading.value = false
  }
}

async function onAddToCart() {
  const p = product.value
  if (!p) return
  if (!auth.isLoggedIn) {
    router.push({ name: 'login', query: { redirect: route.fullPath } })
    return
  }
  adding.value = true
  try {
    const ok = await add(p.id, quantity.value)
    if (ok) toast.show(`已加入购物车 · ${p.title}`, 'success')
    else toast.show('加入购物车失败', 'error')
  } finally {
    adding.value = false
  }
}

async function buyNow() {
  const p = product.value
  if (!p) return
  if (!auth.isLoggedIn) {
    router.push({ name: 'login', query: { redirect: route.fullPath } })
    return
  }
  adding.value = true
  try {
    const ok = await add(p.id, quantity.value)
    // 直购也是先加车再结算，而不是直接下单：
    // 服务端只认购物车（POST /api/orders 是按 sellerId 从车里取货的），
    // 想要「立即购买」就得先把它放进去
    if (ok) router.push('/market/cart')
    else toast.show('下单失败，请稍后重试', 'error')
  } finally {
    adding.value = false
  }
}

// ===== 卖家操作 =====

async function toggleShelf() {
  const p = product.value
  if (!p) return
  try {
    if (p.status === 'on_sale') {
      await productsApi.offShelf(p.id)
      ElMessage.success('已下架')
    } else {
      await productsApi.onShelf(p.id)
      ElMessage.success('已上架')
    }
    await load()
    await loadCart()
  } catch (err: any) {
    ElMessage.error(err?.response?.data?.message || '操作失败')
  }
}

const editVisible = ref(false)
const editError = ref('')
const saving = ref(false)
const editForm = ref({ title: '', priceYuan: '', stock: 0, description: '' })

function openEdit() {
  const p = product.value
  if (!p) return
  editForm.value = {
    title: p.title,
    // 回填时格式化成「元」，避免直接把 8990 显示在输入框里
    priceYuan: (p.priceCents / 100).toFixed(2),
    stock: p.stock,
    description: p.description || ''
  }
  editError.value = ''
  editVisible.value = true
}

async function saveEdit() {
  const p = product.value
  if (!p) return
  const title = editForm.value.title.trim()
  if (!title) {
    editError.value = '商品名称不能为空'
    return
  }
  const priceCents = yuanToCents(editForm.value.priceYuan)
  if (priceCents === null) {
    editError.value = '价格最多两位小数'
    return
  }

  saving.value = true
  editError.value = ''
  try {
    product.value = await productsApi.update(p.id, {
      title,
      priceCents,
      stock: Number(editForm.value.stock) || 0,
      description: editForm.value.description.trim()
    })
    editVisible.value = false
    ElMessage.success('已保存')
  } catch (err: any) {
    editError.value = err?.response?.data?.message || '保存失败'
  } finally {
    saving.value = false
  }
}

onMounted(load)
// 在列表和详情之间来回时，props.id 会变，得重新拉 —— 不然显示的还是上一件
watch(() => props.id, load)
</script>

<template>
  <div class="product-detail">
    <MarketTabs />

    <el-button text :icon="ArrowLeft" class="back" @click="router.back()">返回</el-button>

    <EmptyState v-if="loading && !product" variant="loading" title="正在加载商品..." />

    <EmptyState
      v-else-if="errorMsg"
      variant="error"
      :title="errorMsg"
      action="回橱窗"
      @action="router.push('/market')"
    />

    <div v-else-if="product" class="layout">
      <section class="gallery">
        <div class="main-cover">
          <img
            v-if="product.coverImage || product.images?.[0]"
            :src="product.coverImage || product.images[0]"
            :alt="product.title"
          />
          <span v-else class="fallback">{{ product.title.slice(0, 1) }}</span>
        </div>
        <ul v-if="product.images?.length > 1" class="thumbs">
          <li v-for="(img, i) in product.images" :key="img">
            <img :src="img" :alt="`${product.title} 图 ${i + 1}`" />
          </li>
        </ul>
      </section>

      <section class="info">
        <div class="tags">
          <el-tag v-if="offShelf" type="info" size="small" effect="plain">已下架</el-tag>
          <el-tag v-if="soldOut" type="danger" size="small" effect="plain">已售罄</el-tag>
          <el-tag v-else-if="product.stock <= 3" type="warning" size="small" effect="plain">
            仅剩 {{ product.stock }} 件
          </el-tag>
        </div>

        <h1 class="title">{{ product.title }}</h1>

        <p class="price">{{ formatYuan(product.priceCents) }}</p>

        <p class="stock-line">库存 {{ product.stock }} 件</p>

        <RouterLink class="seller-line" :to="`/profile/${product.seller.id}`">
          <span class="seller-avatar">{{ product.seller.nickname.slice(0, 1) }}</span>
          <span>{{ product.seller.nickname }}</span>
        </RouterLink>

        <p v-if="product.description" class="desc">{{ product.description }}</p>

        <!-- 卖家视角 -->
        <div v-if="isMine" class="owner-panel">
          <p class="owner-hint">这是你发布的商品</p>
          <div class="owner-actions">
            <el-button @click="openEdit">改价 / 改库存</el-button>
            <el-button :type="offShelf ? 'success' : 'warning'" plain @click="toggleShelf">
              {{ offShelf ? '重新上架' : '下架' }}
            </el-button>
          </div>
        </div>

        <!-- 买家视角 -->
        <div v-else class="buy-row">
          <el-input-number
            v-model="quantity"
            :min="1"
            :max="Math.max(1, Math.min(product.stock, 99))"
            :disabled="!canBuy"
            controls-position="right"
          />
          <el-button
            type="primary"
            :icon="ShoppingCart"
            :loading="adding"
            :disabled="!canBuy"
            @click="onAddToCart"
          >
            加入购物车
          </el-button>
          <el-button :disabled="!canBuy" @click="buyNow">立即购买</el-button>
        </div>

        <p v-if="offShelf" class="notice">这件商品已下架，买不了也加不进购物车。</p>
        <p v-else-if="soldOut" class="notice">卖完了，可以看看别的。</p>
      </section>
    </div>

    <el-dialog v-model="editVisible" title="修改商品" width="440px">
      <el-form label-position="top" @submit.prevent="saveEdit">
        <el-form-item label="商品名称" required>
          <el-input v-model="editForm.title" maxlength="60" />
        </el-form-item>
        <div class="edit-row">
          <el-form-item label="价格（元）" class="grow">
            <el-input v-model="editForm.priceYuan" />
          </el-form-item>
          <el-form-item label="库存" class="grow">
            <el-input-number
              v-model="editForm.stock"
              :min="0"
              :max="9999"
              controls-position="right"
            />
          </el-form-item>
        </div>
        <el-form-item label="商品描述">
          <el-input v-model="editForm.description" type="textarea" :rows="3" maxlength="1000" />
        </el-form-item>
        <p v-if="editError" class="form-error">{{ editError }}</p>
      </el-form>
      <template #footer>
        <el-button @click="editVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="saveEdit">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.product-detail {
  max-width: 1000px;
  margin: 0 auto;
  padding: 24px 0 48px;
}

.back {
  margin-bottom: 8px;
  padding-left: 0;
}

.layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 340px;
  gap: 32px;
  align-items: start;
}

.main-cover {
  aspect-ratio: 1;
  border-radius: 12px;
  overflow: hidden;
  background: var(--muted);
  display: flex;
  align-items: center;
  justify-content: center;
}

.main-cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.fallback {
  font-size: 72px;
  font-weight: 700;
  color: var(--muted-foreground);
  opacity: 0.5;
}

.thumbs {
  list-style: none;
  display: flex;
  gap: 8px;
  margin: 10px 0 0;
  padding: 0;
}

.thumbs img {
  width: 64px;
  height: 64px;
  object-fit: cover;
  border-radius: 6px;
  cursor: pointer;
}

.tags {
  display: flex;
  gap: 6px;
  margin-bottom: 8px;
  min-height: 24px;
}

.title {
  margin: 0 0 10px;
  font-size: 22px;
  font-weight: 600;
  color: var(--foreground);
  line-height: 1.4;
}

.price {
  margin: 0 0 4px;
  font-size: 28px;
  font-weight: 700;
  color: var(--accent);
  font-variant-numeric: tabular-nums;
}

.stock-line {
  margin: 0 0 12px;
  font-size: 13px;
  color: var(--muted-foreground);
}

.seller-line {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  color: var(--foreground);
  text-decoration: none;
  margin-bottom: 14px;
}

.seller-avatar {
  width: 26px;
  height: 26px;
  border-radius: 50%;
  background: var(--muted);
  color: var(--muted-foreground);
  font-size: 12px;
  font-weight: 600;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.desc {
  margin: 0 0 18px;
  font-size: 14px;
  line-height: 1.7;
  color: var(--foreground);
  white-space: pre-wrap;
}

.buy-row {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  align-items: center;
}

.owner-panel {
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 14px;
  background: var(--muted);
}

.owner-hint {
  margin: 0 0 10px;
  font-size: 13px;
  color: var(--muted-foreground);
}

.owner-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.notice {
  margin: 10px 0 0;
  font-size: 13px;
  color: var(--muted-foreground);
}

.edit-row {
  display: flex;
  gap: 12px;
}

.grow {
  flex: 1;
  min-width: 0;
}

.form-error {
  margin: 0;
  font-size: 13px;
  color: var(--el-color-danger);
}

@media (max-width: 900px) {
  .layout {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
