<script setup lang="ts">
/**
 * 市集橱窗 /market
 *
 * 三件事：看看有什么、按条件筛选、发布自己的商品。
 *
 * 关于「发布商品」放在这里而不是单独一个页面：
 * 卖货是个高频动作，藏在二级页面里等于让作者每次都要找入口。
 * 对话框里就能发完，比「跳到 /market/publish → 填表 → 提交 → 跳回橱窗」短得多。
 *
 * 金额：**只显示服务端给的整数分**，自己不做任何加减。
 * 筛选的排序也交给服务端的 ORDER BY（带白名单），不在前端排。
 */
import { ref, computed, onMounted, watch } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { Plus, Search } from '@element-plus/icons-vue'
import { productsApi, type Product, type ProductSort } from '@/api/products'
import { uploadImage } from '@/api/uploads'
import { yuanToCents, formatYuan } from '@/utils/money'
import { useAuthStore } from '@/stores/auth'
import MarketTabs from '@/components/MarketTabs.vue'
import EmptyState from '@/components/EmptyState.vue'

const router = useRouter()
const auth = useAuthStore()

// ===== 列表 =====
const products = ref<Product[]>([])
const total = ref(0)
const page = ref(1)
const pageSize = 20
const hasMore = ref(false)

const loading = ref(false)
const loadingMore = ref(false)
const errorMsg = ref('')
const keyword = ref('')
const sort = ref<ProductSort>('new')

async function load() {
  loading.value = true
  errorMsg.value = ''
  try {
    const res = await productsApi.list({
      page: 1,
      pageSize,
      q: keyword.value.trim() || undefined,
      sort: sort.value
    })
    products.value = res.list
    total.value = res.pagination.total
    hasMore.value = res.pagination.hasMore
    page.value = 1
  } catch (err: any) {
    errorMsg.value = err?.response?.data?.message || '加载商品失败'
  } finally {
    loading.value = false
  }
}

async function loadMore() {
  if (loadingMore.value || !hasMore.value) return
  loadingMore.value = true
  try {
    const next = page.value + 1
    const res = await productsApi.list({
      page: next,
      pageSize,
      q: keyword.value.trim() || undefined,
      sort: sort.value
    })
    // 按 id 去重：翻页期间新发布的商品会把后面的挤走，可能出现重复
    const seen = new Set(products.value.map((p) => p.id))
    products.value = [...products.value, ...res.list.filter((p) => !seen.has(p.id))]
    page.value = next
    hasMore.value = res.pagination.hasMore
    total.value = res.pagination.total
  } catch {
    /* 翻页失败停在当前页，不清空 */
  } finally {
    loadingMore.value = false
  }
}

// 换排序条件要重置到第一页 —— 保留第 3 页再换排序，看到的会是完全不相干的一段
watch(sort, () => load())

function onSearch() {
  load()
}

// ===== 发布商品 =====
const dialogVisible = ref(false)
const submitting = ref(false)
const formError = ref('')
const form = ref({ title: '', priceYuan: '', stock: 10, description: '', coverImage: '' })
const coverUploading = ref(false)
const coverProgress = ref(0)

function openPublish() {
  if (!auth.isLoggedIn) {
    router.push({ name: 'login', query: { redirect: '/market' } })
    return
  }
  form.value = { title: '', priceYuan: '', stock: 10, description: '', coverImage: '' }
  formError.value = ''
  dialogVisible.value = true
}

async function onCoverChange(uploadFile: { raw?: File }) {
  const file = uploadFile?.raw
  if (!file) return
  coverUploading.value = true
  coverProgress.value = 0
  formError.value = ''
  try {
    form.value.coverImage = await uploadImage(file, (p) => (coverProgress.value = p))
  } catch (err: any) {
    formError.value = err?.response?.data?.message || '图片上传失败'
  } finally {
    coverUploading.value = false
  }
}

async function submitProduct() {
  const f = form.value
  const title = f.title.trim()
  if (!title) {
    formError.value = '请填写商品名称'
    return
  }

  // 元 → 分。这里返回 null 就直接报错，**绝不猜一个值**
  const priceCents = yuanToCents(f.priceYuan)
  if (priceCents === null) {
    formError.value = '价格最多两位小数，且不能是 0.00 元以外的非数字'
    return
  }

  submitting.value = true
  formError.value = ''
  try {
    const created = await productsApi.create({
      title,
      priceCents,
      stock: Number(f.stock) || 0,
      description: f.description.trim() || undefined,
      coverImage: f.coverImage || null,
      images: f.coverImage ? [f.coverImage] : []
    })
    dialogVisible.value = false
    ElMessage.success('商品已上架')
    // 跳到详情而不是留在列表：让作者确认一下长什么样，
    // 也顺便能改价 / 下架
    router.push(`/market/product/${created.id}`)
  } catch (err: any) {
    formError.value = err?.response?.data?.message || '发布失败'
  } finally {
    submitting.value = false
  }
}

/** 空图时用标题首字占位，比一个灰色方块更容易扫 */
function coverOf(p: Product): string {
  return p.coverImage || p.images?.[0] || ''
}

const isEmpty = computed(() => !loading.value && !errorMsg.value && products.value.length === 0)

onMounted(load)
</script>

<template>
  <div class="market">
    <MarketTabs />

    <header class="head">
      <div>
        <h1 class="title">市集</h1>
        <p class="subtitle">别人挂出来的东西，也能挂自己的 · 共 {{ total }} 件</p>
      </div>
      <el-button type="primary" :icon="Plus" @click="openPublish">发布商品</el-button>
    </header>

    <div class="toolbar">
      <el-input
        v-model="keyword"
        placeholder="搜商品名或描述"
        clearable
        :prefix-icon="Search"
        class="search"
        @keyup.enter="onSearch"
        @clear="onSearch"
      />
      <el-radio-group v-model="sort" size="default">
        <el-radio-button value="new">最新</el-radio-button>
        <el-radio-button value="price_asc">价格低到高</el-radio-button>
        <el-radio-button value="price_desc">价格高到低</el-radio-button>
      </el-radio-group>
      <el-button :disabled="loading" @click="onSearch">搜索</el-button>
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
      v-else-if="isEmpty"
      icon="🛒"
      :title="keyword ? `没有匹配「${keyword}」的商品` : '市集还什么都没有'"
      :hint="keyword ? '换个词试试，或者清空搜索看全部' : '你也可以是第一个挂东西的人'"
      :action="keyword ? '清空搜索' : '发布商品'"
      @action="keyword ? ((keyword = ''), onSearch()) : openPublish()"
    />

    <template v-else>
      <ul class="grid">
        <li
          v-for="p in products"
          :key="p.id"
          class="card"
          @click="router.push(`/market/product/${p.id}`)"
        >
          <div class="cover">
            <img v-if="coverOf(p)" :src="coverOf(p)" :alt="p.title" loading="lazy" />
            <span v-else class="cover-fallback">{{ p.title.slice(0, 1) }}</span>
          </div>

          <div class="body">
            <h3 class="card-title">{{ p.title }}</h3>

            <div class="price-row">
              <span class="price">{{ formatYuan(p.priceCents) }}</span>
              <span v-if="p.stock <= 0" class="sold-out">已售罄</span>
              <span v-else-if="p.stock <= 3" class="low-stock">仅剩 {{ p.stock }} 件</span>
            </div>

            <p class="seller">
              <span>{{ p.seller.nickname }}</span>
              <span class="dot">·</span>
              <span>{{ p.status === 'off_shelf' ? '已下架' : `${p.stock} 件在售` }}</span>
            </p>
          </div>
        </li>
      </ul>

      <div class="pager">
        <el-button v-if="hasMore" :loading="loadingMore" @click="loadMore">加载更多</el-button>
        <span v-else class="no-more">— 已经到底了 —</span>
      </div>
    </template>

    <!-- 发布商品 -->
    <el-dialog v-model="dialogVisible" title="发布商品" width="480px">
      <el-form label-position="top" @submit.prevent="submitProduct">
        <el-form-item label="商品名称" required>
          <el-input
            v-model="form.title"
            maxlength="60"
            show-word-limit
            placeholder="例如：手冲咖啡壶"
          />
        </el-form-item>

        <div class="form-row">
          <el-form-item label="价格（元）" required class="grow">
            <el-input v-model="form.priceYuan" placeholder="0.00">
              <template #prepend>¥</template>
            </el-input>
          </el-form-item>
          <el-form-item label="库存" class="grow">
            <el-input-number v-model="form.stock" :min="0" :max="9999" controls-position="right" />
          </el-form-item>
        </div>

        <el-form-item label="封面图（可留空）">
          <el-upload
            :auto-upload="false"
            :show-file-list="false"
            accept="image/*"
            :on-change="onCoverChange"
          >
            <div class="cover-upload">
              <img v-if="form.coverImage" :src="form.coverImage" alt="封面预览" />
              <span v-else>点击选择图片</span>
            </div>
          </el-upload>
          <el-progress
            v-if="coverUploading"
            :percentage="coverProgress"
            :stroke-width="4"
            class="upload-progress"
          />
        </el-form-item>

        <el-form-item label="商品描述（可留空）">
          <el-input
            v-model="form.description"
            type="textarea"
            :rows="3"
            maxlength="1000"
            show-word-limit
            placeholder="成色、新旧、为什么出手 —— 写清楚能少很多来回问"
          />
        </el-form-item>

        <p v-if="formError" class="form-error">{{ formError }}</p>
      </el-form>

      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submitProduct">发布</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.market {
  max-width: 1080px;
  margin: 0 auto;
  padding: 24px 0 48px;
}

.head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 16px;
}

.title {
  margin: 0;
  font-size: 20px;
  font-weight: 600;
  color: var(--foreground);
}

.subtitle {
  margin: 6px 0 0;
  font-size: 13px;
  color: var(--muted-foreground);
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 20px;
  flex-wrap: wrap;
}

.search {
  max-width: 300px;
}

/* ===== 卡片网格 ===== */
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 16px;
  list-style: none;
  margin: 0;
  padding: 0;
}

.card {
  border: 1px solid var(--border);
  border-radius: 10px;
  overflow: hidden;
  cursor: pointer;
  background: var(--background);
  transition:
    transform 0.15s ease,
    box-shadow 0.15s ease;
}

.card:hover {
  transform: translateY(-2px);
  box-shadow: 0 6px 18px rgb(0 0 0 / 8%);
}

.cover {
  aspect-ratio: 4 / 3;
  background: var(--muted);
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}

.cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.cover-fallback {
  font-size: 40px;
  font-weight: 700;
  color: var(--muted-foreground);
  opacity: 0.5;
}

.body {
  padding: 10px 12px 12px;
}

.card-title {
  margin: 0 0 6px;
  font-size: 14px;
  font-weight: 500;
  color: var(--foreground);
  line-height: 1.4;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  min-height: 2.8em;
}

.price-row {
  display: flex;
  align-items: baseline;
  gap: 6px;
}

.price {
  font-size: 17px;
  font-weight: 700;
  color: var(--accent);
  font-variant-numeric: tabular-nums;
}

.sold-out {
  font-size: 11px;
  color: var(--muted-foreground);
}

.low-stock {
  font-size: 11px;
  color: #b45309;
}

.seller {
  margin: 6px 0 0;
  font-size: 12px;
  color: var(--muted-foreground);
  display: flex;
  gap: 4px;
  align-items: center;
}

.dot {
  opacity: 0.5;
}

.pager {
  display: flex;
  justify-content: center;
  padding-top: 24px;
}

.no-more {
  font-size: 13px;
  color: var(--muted-foreground);
}

/* ===== 发布对话框 ===== */
.form-row {
  display: flex;
  gap: 12px;
}

.grow {
  flex: 1;
  min-width: 0;
}

.cover-upload {
  width: 120px;
  height: 90px;
  border: 1px dashed var(--border);
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  cursor: pointer;
  color: var(--muted-foreground);
  font-size: 12px;
}

.cover-upload img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.upload-progress {
  margin-top: 8px;
}

.form-error {
  margin: 0;
  font-size: 13px;
  color: var(--el-color-danger);
}

@media (prefers-reduced-motion: reduce) {
  .card {
    transition: none;
  }

  .card:hover {
    transform: none;
  }
}
</style>
