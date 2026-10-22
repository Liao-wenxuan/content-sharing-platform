<script setup lang="ts">
/**
 * 我的商品 /market/mine
 *
 * 卖家管理自己商品的地方。
 *
 * 之前没有这个页面，卖家想改一件商品的价或把它下架，
 * 只能先在橱窗里找到它、点进详情 —— 而橱窗只显示在售的，
 * 所以**已经下架的商品根本找不回来**，也就再也上不了架。
 * 那个洞比「多一个页面」严重：一个商品下架之后它就永远停在那儿了。
 *
 * 这里用列表而不是网格：管理场景里要对比的是「状态 / 库存 / 价格」，
 * 网格把每张卡片摊开反而让这些字段更难横向比较。
 *
 * 接口不用改：`GET /api/products?sellerId=<我的 id>`
 * 在服务端就已经是「自己的商品全给（含下架），别人的只给在售」。
 */
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from '@/utils/element'
import { formatYuan } from '@/utils/money'
import { productsApi, type Product } from '@/api/products'
import { useAuthStore } from '@/stores/auth'
import { useToastStore } from '@/stores/toast'
import MarketTabs from '@/components/MarketTabs.vue'
import EmptyState from '@/components/EmptyState.vue'

const router = useRouter()
const auth = useAuthStore()
const toast = useToastStore()

const products = ref<Product[]>([])
const total = ref(0)
const loading = ref(false)
const errorMsg = ref('')
const busyId = ref(0)

/** 一次拉 50 条：卖家的商品通常不超过这个数，够用且不用做分页 */
const PAGE_SIZE = 50

/** 状态筛选。'' = 全部（含下架） */
const filter = ref<'' | 'on_sale' | 'off_shelf'>('')
const FILTERS: { value: '' | 'on_sale' | 'off_shelf'; label: string }[] = [
  { value: '', label: '全部' },
  { value: 'on_sale', label: '在售' },
  { value: 'off_shelf', label: '已下架' }
]

async function load() {
  const myId = auth.user?.id
  if (typeof myId !== 'number') {
    errorMsg.value = '请先登录'
    return
  }
  loading.value = true
  errorMsg.value = ''
  try {
    const res = await productsApi.list({ sellerId: myId, page: 1, pageSize: PAGE_SIZE })
    products.value = res.list
    total.value = res.pagination.total
  } catch (err: any) {
    errorMsg.value = err?.response?.data?.message || '加载商品失败'
  } finally {
    loading.value = false
  }
}

onMounted(load)

const visible = computed(() =>
  filter.value ? products.value.filter((p) => p.status === filter.value) : products.value
)

/**
 * 上架 / 下架。
 *
 * 调的是两个独立方法而不是 toggle —— 那样调用方就分不清
 * 「本来就已经下架」和「我刚把它下架了」。
 */
async function toggleShelf(p: Product) {
  busyId.value = p.id
  try {
    if (p.status === 'on_sale') {
      await productsApi.offShelf(p.id)
      ElMessage.success('已下架')
    } else {
      await productsApi.onShelf(p.id)
      ElMessage.success('已重新上架')
    }
    await load()
  } catch (err: any) {
    toast.show(err?.response?.data?.message || '操作失败', 'error')
  } finally {
    busyId.value = 0
  }
}

/** 改价 / 改库存在详情页里做 —— 那里已经有编辑对话框和上传预览 */
function openEdit(p: Product) {
  router.push(`/market/product/${p.id}`)
}

function goPublish() {
  router.push({ path: '/market', query: { publish: '1' } })
}

function coverOf(p: Product): string | null {
  return p.coverImage || p.images[0] || null
}
</script>

<template>
  <div class="my-products">
    <MarketTabs />

    <div class="head">
      <div>
        <h1 class="page-title">我的商品</h1>
        <p class="subtitle">共 {{ total }} 件 · 下架的商品这里还能找到，可以重新上架</p>
      </div>
      <div class="head-actions">
        <el-radio-group v-model="filter" size="small">
          <el-radio-button v-for="f in FILTERS" :key="f.value" :value="f.value">
            {{ f.label }}
          </el-radio-button>
        </el-radio-group>
        <el-button type="primary" @click="goPublish">发布商品</el-button>
      </div>
    </div>

    <EmptyState v-if="loading && products.length === 0" variant="loading" title="正在加载商品..." />

    <EmptyState
      v-else-if="errorMsg"
      variant="error"
      :title="errorMsg"
      action="重试"
      @action="load"
    />

    <EmptyState
      v-else-if="visible.length === 0"
      icon="📦"
      :title="filter ? '这个状态下没有商品' : '你还没有发布过商品'"
      :hint="filter ? '换个状态看看' : '在橱窗右上角就能发布'"
      :action="filter ? '看全部' : '去发布'"
      @action="filter ? (filter = '') : goPublish()"
    />

    <ul v-else class="rows">
      <li v-for="p in visible" :key="p.id" class="row">
        <router-link class="cover" :to="`/market/product/${p.id}`">
          <img v-if="coverOf(p)" :src="coverOf(p)!" :alt="p.title" loading="lazy" />
          <span v-else class="cover-fallback">{{ p.title.slice(0, 1) }}</span>
        </router-link>

        <div class="info">
          <router-link class="title" :to="`/market/product/${p.id}`">{{ p.title }}</router-link>
          <div class="meta">
            <el-tag v-if="p.category" size="small" effect="plain">{{ p.category }}</el-tag>
            <el-tag v-if="p.status === 'off_shelf'" type="info" size="small" effect="plain">
              已下架
            </el-tag>
            <el-tag v-else-if="p.stock <= 0" type="danger" size="small" effect="plain"
              >已售罄</el-tag
            >
            <el-tag v-else-if="p.stock <= 3" type="warning" size="small" effect="plain">
              仅剩 {{ p.stock }} 件
            </el-tag>
            <span v-else class="stock">{{ p.stock }} 件在售</span>
          </div>
        </div>

        <div class="price">{{ formatYuan(p.priceCents) }}</div>

        <div class="actions">
          <el-button size="small" @click="openEdit(p)">改价 / 改库存</el-button>
          <el-button
            size="small"
            :type="p.status === 'on_sale' ? 'warning' : 'success'"
            plain
            :loading="busyId === p.id"
            @click="toggleShelf(p)"
          >
            {{ p.status === 'on_sale' ? '下架' : '重新上架' }}
          </el-button>
        </div>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.my-products {
  max-width: var(--content-max-width);
  margin: 0 auto;
  padding: 24px 0 48px;
}

.head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 20px;
  flex-wrap: wrap;
}

.page-title {
  margin: 0;
  font-size: var(--fs-lg);
  font-weight: 600;
  color: var(--foreground);
}

.subtitle {
  margin: 6px 0 0;
  font-size: var(--fs-sm);
  color: var(--muted-foreground);
}

.head-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.rows {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.row {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 12px 16px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--background);
}

.cover {
  flex: 0 0 64px;
  width: 64px;
  height: 64px;
  border-radius: var(--radius-sm);
  overflow: hidden;
  background: var(--surface-2);
  display: flex;
  align-items: center;
  justify-content: center;
}

.cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.cover-fallback {
  font-size: var(--fs-lg);
  color: var(--text-3);
}

.info {
  flex: 1 1 auto;
  min-width: 0;
}

.title {
  display: block;
  font-size: var(--fs-base);
  color: var(--foreground);
  text-decoration: none;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.title:hover {
  color: var(--accent);
}

.meta {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 6px;
}

.stock {
  font-size: var(--fs-sm);
  color: var(--muted-foreground);
}

.price {
  flex: 0 0 auto;
  font-size: var(--fs-base);
  font-weight: 600;
  color: var(--foreground);
  font-variant-numeric: tabular-nums;
}

.actions {
  flex: 0 0 auto;
  display: flex;
  gap: 8px;
}
</style>
