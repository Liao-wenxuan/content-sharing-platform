<script setup lang="ts">
/**
 * 收藏页 —— 「我收了一堆，怎么看、怎么翻、怎么扔掉一篇」
 *
 * 一页两栏：
 *   左：筛选（全部 / 未分类 / 每个收藏夹）+ 建夹
 *   右：当前筛选下的收藏卡片，可翻页、可单篇取消收藏、可进整理模式批量归夹
 *
 * 三个设计决定，都是为了避开收藏功能最常见的投诉：
 *
 * 1. **「未分类」是一个显式入口，不是藏在「全部」里的默认值**。
 *    用户点收藏之后，笔记落在未分类是默认行为，不是分类结果；
 *    不把它列出来，用户打开收藏页会以为收藏失败了。
 * 2. **空态分三种**：一条收藏都没有 / 这个夹是空的 / 未分类是空的。
 *    三种情况要做的事完全不同，用一句「暂无数据」打发等于什么都没说。
 * 3. **加载中不能闪空态**。列表逻辑全在 useFavoritesList 里，
 *    它用 `loaded` 区分「还没拉到」和「真的一条都没有」。
 *
 * 收藏夹的增删改只放在「选中某个夹」时才出现在右栏顶部 ——
 * 一进页面就摆三个按钮，等于让用户先学会管理再学会浏览。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from '@/utils/element'
import { Collection, Plus, Delete, EditPen, FolderOpened } from '@element-plus/icons-vue'
import { favoritesApi, type FavoriteFolder } from '@/api/favorites'
import { useFavoritesList } from '@/composables/useFavoritesList'
import { useRelativeTime } from '@/composables/useRelativeTime'
import EmptyState from '@/components/EmptyState.vue'

const router = useRouter()
const { formatTime } = useRelativeTime()

const FOLDER_NAME_MAX = 20

const {
  folders,
  unclassifiedCount,
  posts,
  filter,
  total,
  activeFolder,
  isAll,
  isUnclassified,
  hasMore,
  isEmpty,
  allCount,
  loading,
  loadingMore,
  loaded,
  error,
  removingId,
  reload,
  loadMore,
  setFilter,
  remove,
  moveTo,
  refreshFolders
} = useFavoritesList()

const newName = ref('')
const creating = ref(false)
const busyId = ref<number | null>(null)

// ===== 整理模式（批量归夹）=====
// 独立开关而不是常驻勾选框：平时列表就是用来看的，
// 满屏勾选框会让「点开看看」这件事变得有负担
const organizing = ref(false)
const selected = ref<number[]>([])

// 换筛选 / 重新加载都要清空勾选：留着上一轮的 id 去移动，
// 会把用户没看见的笔记也挪走
watch([filter, loaded], () => {
  selected.value = []
})

const selectedCount = computed(() => selected.value.length)

/** 只有「当前有内容」且「至少有一个夹」时，整理才有意义 */
const canOrganize = computed(() => posts.value.length > 0 && folders.value.length > 0)

const filterLabel = computed(() => {
  if (isAll.value) return '全部收藏'
  if (isUnclassified.value) return '未分类'
  return activeFolder.value?.name ?? '收藏'
})

/** 卡片封面：缩略图优先，视频用封面，纯文字不硬塞图 */
function coverOf(p: { imageThumbs?: string[]; imageUrls?: string[]; videoPoster?: string | null }) {
  return p.imageThumbs?.[0] || p.imageUrls?.[0] || p.videoPoster || ''
}

/** 纯文字笔记用正文当封面 —— 空白格子在网格里会显得像加载失败 */
function excerptOf(content: string): string {
  return content.length > 60 ? `${content.slice(0, 60)}…` : content
}

function toggleOrganize(): void {
  organizing.value = !organizing.value
  if (!organizing.value) selected.value = []
}

function toggleSelect(id: number): void {
  const i = selected.value.indexOf(id)
  if (i === -1) selected.value.push(id)
  else selected.value.splice(i, 1)
}

async function moveSelected(folderId: number): Promise<void> {
  if (selectedCount.value === 0 || busyId.value !== null) return
  busyId.value = folderId
  const moved = await moveTo(folderId, selected.value)
  busyId.value = null
  if (moved > 0) {
    selected.value = []
    organizing.value = false
  }
}

/**
 * 取消收藏：失败由 composable 负责放回原位并提示，
 * 这里只在成功后确认一次 —— 用户点的是「扔掉」，需要看到它真的没了
 */
async function removeOne(postId: number): Promise<void> {
  await remove(postId)
}

// ===== 收藏夹管理 =====

async function createFolder(): Promise<void> {
  const name = newName.value.trim()
  if (!name || creating.value) return
  if (name.length > FOLDER_NAME_MAX) {
    ElMessage.error(`收藏夹名不能超过 ${FOLDER_NAME_MAX} 字`)
    return
  }
  creating.value = true
  try {
    await favoritesApi.createFolder(name)
    newName.value = ''
    await refreshFolders()
    ElMessage.success('收藏夹已创建')
  } catch (err: any) {
    // 重名是 409，服务端给了人话文案，直接用；其它情况兜底
    ElMessage.error(err?.response?.data?.message || '创建失败')
  } finally {
    creating.value = false
  }
}

async function renameFolder(folder: FavoriteFolder): Promise<void> {
  try {
    const { value } = await ElMessageBox.prompt('新的收藏夹名称', '重命名', {
      inputValue: folder.name,
      inputPattern: /^.{1,20}$/,
      inputErrorMessage: `名称不能为空且不超过 ${FOLDER_NAME_MAX} 字`
    })
    const name = String(value).trim()
    if (!name || name === folder.name) return
    await favoritesApi.renameFolder(folder.id, name)
    await refreshFolders()
    ElMessage.success('已重命名')
  } catch (err: any) {
    if (err === 'cancel' || err === 'close') return
    ElMessage.error(err?.response?.data?.message || '重命名失败')
  }
}

async function deleteFolder(folder: FavoriteFolder): Promise<void> {
  const tip = folder.postCount
    ? `删除「${folder.name}」不会删掉里面的 ${folder.postCount} 篇笔记，它们会退回未分类。确定删除吗？`
    : `删除「${folder.name}」？这个夹里还没有笔记。`
  try {
    await ElMessageBox.confirm(tip, '删除收藏夹', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消'
    })
  } catch {
    return // 用户点了取消，不发请求
  }

  busyId.value = folder.id
  try {
    await favoritesApi.deleteFolder(folder.id)
    // 正在看的夹被删了：筛选条件已经失效，必须先退回「全部」，
    // 否则会拿着一个不存在的 folderId 去请求，拿到 400 显示成「加载失败」
    if (filter.value === folder.id) setFilter('all')
    else await Promise.all([refreshFolders(), reload()])
    ElMessage.success('收藏夹已删除')
  } catch (err: any) {
    ElMessage.error(err?.response?.data?.message || '删除失败')
  } finally {
    busyId.value = null
  }
}

onMounted(reload)
</script>

<template>
  <div class="fav-manage">
    <header class="head">
      <h1 class="title">收藏</h1>
      <p class="subtitle">
        共 {{ allCount }} 篇 · {{ folders.length }} 个收藏夹
        <span class="subtitle-hint">收藏只有自己可见，可以按主题归进收藏夹</span>
      </p>
    </header>

    <div class="layout">
      <!-- ================= 左：筛选 + 建夹 ================= -->
      <aside class="side">
        <nav class="side-block" aria-label="收藏筛选">
          <button
            type="button"
            class="side-item"
            :class="{ active: isAll }"
            :aria-current="isAll ? 'true' : undefined"
            @click="setFilter('all')"
          >
            <el-icon><component :is="Collection" /></el-icon>
            <span class="side-label">全部收藏</span>
            <span class="side-count">{{ allCount }}</span>
          </button>

          <button
            type="button"
            class="side-item"
            :class="{ active: isUnclassified }"
            :aria-current="isUnclassified ? 'true' : undefined"
            @click="setFilter('unclassified')"
          >
            <el-icon><component :is="FolderOpened" /></el-icon>
            <span class="side-label">未分类</span>
            <span class="side-count">{{ unclassifiedCount }}</span>
          </button>
        </nav>

        <div class="side-block">
          <div class="side-title">收藏夹</div>

          <p v-if="folders.length === 0" class="side-empty">还没有收藏夹</p>

          <button
            v-for="f in folders"
            :key="f.id"
            type="button"
            class="side-item folder-row"
            :class="{ active: filter === f.id }"
            :aria-current="filter === f.id ? 'true' : undefined"
            @click="setFilter(f.id)"
          >
            <el-icon><component :is="FolderOpened" /></el-icon>
            <span class="side-label folder-name">{{ f.name }}</span>
            <span class="side-count folder-count">{{ f.postCount }}</span>
          </button>
        </div>

        <div class="side-block create-block">
          <label class="side-title" for="new-folder-name">新建收藏夹</label>
          <div class="create-row">
            <el-input
              id="new-folder-name"
              v-model="newName"
              placeholder="最多 20 字"
              maxlength="20"
              @keyup.enter="createFolder"
            />
            <el-button type="primary" :loading="creating" @click="createFolder">
              <el-icon><component :is="Plus" /></el-icon>
              创建
            </el-button>
          </div>
        </div>
      </aside>

      <!-- ================= 右：内容 ================= -->
      <main class="main">
        <div class="main-head">
          <div class="main-title-row">
            <h2 class="main-title">{{ filterLabel }}</h2>
            <span v-if="loaded && !loading" class="main-count">{{ total }} 篇</span>
          </div>

          <div class="main-tools">
            <el-button
              v-if="canOrganize"
              text
              size="small"
              :type="organizing ? 'primary' : undefined"
              @click="toggleOrganize"
            >
              {{ organizing ? '退出整理' : '整理' }}
            </el-button>
            <template v-if="activeFolder">
              <el-button size="small" text @click="renameFolder(activeFolder)">
                <el-icon><component :is="EditPen" /></el-icon>
                重命名
              </el-button>
              <el-button
                size="small"
                text
                :loading="busyId === activeFolder.id"
                @click="deleteFolder(activeFolder)"
              >
                <el-icon><component :is="Delete" /></el-icon>
                删除
              </el-button>
            </template>
          </div>
        </div>

        <!-- 整理条：勾完点一个夹就移进去，比「选中 → 打开下拉 → 选夹 → 确定」少两步 -->
        <div v-if="organizing" class="organize-bar">
          <span class="organize-count">已选 {{ selectedCount }} 篇</span>
          <span class="organize-label">移入</span>
          <button
            v-for="f in folders"
            :key="f.id"
            type="button"
            class="organize-target"
            :disabled="selectedCount === 0 || busyId !== null"
            @click="moveSelected(f.id)"
          >
            {{ f.name }}
          </button>
          <button type="button" class="organize-done" @click="toggleOrganize">完成</button>
        </div>

        <EmptyState v-if="loading && !loaded" variant="loading" title="正在加载收藏..." compact />

        <EmptyState
          v-else-if="error"
          variant="error"
          :title="error"
          hint="可能是网络问题，重试一次通常就好了"
          action="重试"
          @action="reload"
        />

        <EmptyState
          v-else-if="isEmpty && isAll"
          icon="🔖"
          title="还没有收藏任何笔记"
          hint="看到喜欢的点一下收藏，之后在这里按主题回看"
          action="去发现好内容"
          @action="router.push('/')"
        />

        <EmptyState
          v-else-if="isEmpty && isUnclassified"
          icon="🗂"
          title="没有未分类的收藏"
          hint="你收藏的笔记都已经归进收藏夹了"
        />

        <EmptyState
          v-else-if="isEmpty"
          icon="📁"
          :title="`「${filterLabel}」还是空的`"
          hint="到「全部收藏」里勾几篇，再点「整理」移进来"
          action="看看全部收藏"
          @action="setFilter('all')"
        />

        <template v-else>
          <div class="fav-grid">
            <article
              v-for="p in posts"
              :key="p.id"
              class="fav-card"
              :class="{ selected: selected.includes(p.id) }"
            >
              <router-link class="fav-link" :to="`/post/${p.id}`">
                <div class="fav-cover">
                  <img
                    v-if="coverOf(p)"
                    :src="coverOf(p)"
                    :alt="`${p.author?.nickname ?? '作者'} 的笔记封面`"
                    loading="lazy"
                  />
                  <p v-else class="fav-cover-text">{{ excerptOf(p.content) }}</p>
                  <span v-if="p.mediaType === 'video'" class="fav-badge">视频</span>
                </div>
                <div class="fav-body">
                  <p class="fav-text">{{ p.content }}</p>
                  <div class="fav-meta">
                    <span class="fav-author">{{ p.author?.nickname ?? '未知作者' }}</span>
                    <span class="fav-time">{{ formatTime(p.favoritedAt) }}收藏</span>
                  </div>
                </div>
              </router-link>

              <!-- 勾选框和取消按钮是兄弟节点，不能嵌在 router-link 里：
                   链接套按钮在 HTML 里不合法，键盘用户也分不清点下去是跳转还是删除 -->
              <label v-if="organizing" class="fav-check">
                <el-checkbox
                  :model-value="selected.includes(p.id)"
                  :aria-label="`选择：${p.content}`"
                  @change="toggleSelect(p.id)"
                />
              </label>

              <button
                v-else
                type="button"
                class="fav-remove"
                :disabled="removingId === p.id"
                :aria-label="`取消收藏：${p.content}`"
                @click="removeOne(p.id)"
              >
                <el-icon><component :is="Delete" /></el-icon>
                <span class="fav-remove-text">取消收藏</span>
              </button>
            </article>
          </div>

          <div class="pager">
            <p v-if="!hasMore" class="pager-end">已经到底了 · 共 {{ posts.length }} 篇</p>
            <el-button v-else :loading="loadingMore" @click="loadMore">加载更多</el-button>
          </div>
        </template>
      </main>
    </div>
  </div>
</template>

<style scoped>
.fav-manage {
  max-width: var(--content-max-width);
  margin: 0 auto;
  padding: 24px 0 48px;
}

.head {
  margin-bottom: 18px;
}

.title {
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

.subtitle-hint {
  margin-left: 8px;
  color: var(--text-3);
}

/* ===== 两栏 ===== */
.layout {
  display: grid;
  grid-template-columns: 232px minmax(0, 1fr);
  gap: 24px;
  align-items: start;
}

.side {
  position: sticky;
  top: calc(var(--top-bar-height) + 16px);
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.side-block {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.side-title {
  margin: 0 0 6px;
  padding: 0 10px;
  font-size: var(--fs-xs);
  font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--text-3);
}

.side-empty {
  margin: 0;
  padding: 4px 10px 0;
  font-size: var(--fs-xs);
  color: var(--text-3);
}

.side-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px 10px;
  font-family: inherit;
  font-size: var(--fs-base);
  color: var(--muted-foreground);
  text-align: left;
  background: transparent;
  border: none;
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition:
    background 0.15s ease,
    color 0.15s ease;
}

.side-item:hover {
  color: var(--foreground);
  background: var(--surface-2);
}

.side-item.active {
  color: var(--foreground);
  background: var(--surface-3);
}

/* 选中态不能只靠底色：深色主题下 surface-3 和 surface-2 差得太近，
   加一条左侧强调线，一眼能看出「我现在在哪个筛选里」 */
.side-item.active::before {
  content: '';
  width: 2px;
  height: 14px;
  margin-left: -10px;
  margin-right: 8px;
  background: var(--accent);
  border-radius: var(--radius-full);
}

.side-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.side-count {
  font-family: var(--font-numeric);
  font-size: var(--fs-xs);
  color: var(--text-3);
}

.active .side-count {
  color: var(--accent);
}

.create-block {
  padding-top: 4px;
  border-top: 1px solid var(--border-soft);
}

.create-row {
  display: flex;
  gap: 8px;
  padding: 0 2px;
}

/* ===== 右栏 ===== */
.main {
  min-width: 0;
}

.main-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 32px;
  margin-bottom: 12px;
}

.main-title-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}

.main-title {
  margin: 0;
  font-size: var(--fs-md);
  font-weight: 600;
  color: var(--foreground);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.main-count {
  font-size: var(--fs-xs);
  color: var(--text-3);
}

.main-tools {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
}

/* ===== 整理条 ===== */
.organize-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
  padding: 10px 12px;
  font-size: var(--fs-sm);
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
}

.organize-count {
  font-weight: 600;
  color: var(--foreground);
}

.organize-label {
  color: var(--text-3);
}

.organize-target,
.organize-done {
  padding: 4px 10px;
  font-family: inherit;
  font-size: var(--fs-xs);
  color: var(--foreground);
  background: var(--surface-3);
  border: 1px solid var(--border);
  border-radius: var(--radius-full);
  cursor: pointer;
}

.organize-target:hover:not(:disabled) {
  color: var(--accent-foreground);
  background: var(--accent);
  border-color: var(--accent);
}

.organize-target:disabled {
  color: var(--text-3);
  cursor: not-allowed;
}

.organize-done {
  margin-left: auto;
  background: transparent;
  border-color: transparent;
  color: var(--muted-foreground);
}

.organize-done:hover {
  color: var(--foreground);
}

/* ===== 卡片 ===== */
.fav-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(196px, 1fr));
  gap: 16px;
}

.fav-card {
  position: relative;
  border: 1px solid var(--border-soft);
  border-radius: var(--radius-md);
  background: var(--card);
  overflow: hidden;
  transition:
    border-color 0.16s ease,
    transform 0.16s ease;
}

.fav-card:hover {
  border-color: var(--border-strong);
  transform: translateY(-2px);
}

.fav-card.selected {
  border-color: var(--accent);
}

.fav-link {
  display: block;
  color: inherit;
  text-decoration: none;
}

.fav-cover {
  position: relative;
  aspect-ratio: 4 / 3;
  background: var(--surface-2);
  overflow: hidden;
}

.fav-cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.fav-cover-text {
  margin: 0;
  padding: 14px;
  font-size: var(--fs-sm);
  line-height: 1.6;
  color: var(--text-2);
  display: -webkit-box;
  -webkit-line-clamp: 4;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.fav-badge {
  position: absolute;
  top: 8px;
  left: 8px;
  padding: 1px 7px;
  font-size: var(--fs-2xs);
  color: var(--background);
  background: var(--accent);
  border-radius: var(--radius-full);
}

.fav-body {
  padding: 10px 12px 12px;
}

.fav-text {
  margin: 0;
  font-size: var(--fs-sm);
  line-height: 1.55;
  color: var(--foreground);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.fav-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: 8px;
  font-size: var(--fs-2xs);
  color: var(--text-3);
}

.fav-author {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.fav-time {
  flex-shrink: 0;
}

/* 取消收藏：默认半透明常驻，hover / 键盘聚焦时变实。
   不做「只有 hover 才存在」—— 触屏和键盘用户会永远看不到它 */
.fav-remove {
  position: absolute;
  top: 8px;
  right: 8px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  font-family: inherit;
  font-size: var(--fs-2xs);
  color: var(--foreground);
  background: var(--glass-bg-strong);
  border: 1px solid var(--border);
  border-radius: var(--radius-full);
  cursor: pointer;
  opacity: 0.72;
  transition:
    opacity 0.15s ease,
    color 0.15s ease,
    border-color 0.15s ease;
}

.fav-card:hover .fav-remove,
.fav-remove:focus-visible {
  opacity: 1;
}

.fav-remove:hover {
  color: var(--destructive-text);
  border-color: var(--destructive);
}

.fav-remove:disabled {
  cursor: wait;
  opacity: 0.5;
}

.fav-remove-text {
  display: none;
}

/* 卡片够宽才显示文字，否则按钮会盖住封面大半 */
@media (min-width: 1200px) {
  .fav-remove-text {
    display: inline;
  }
}

.fav-check {
  position: absolute;
  top: 8px;
  left: 8px;
  display: inline-flex;
  padding: 2px 4px;
  background: var(--glass-bg-strong);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
}

/* ===== 分页 ===== */
.pager {
  display: flex;
  justify-content: center;
  padding: 24px 0 0;
}

.pager-end {
  margin: 0;
  font-size: var(--fs-xs);
  color: var(--text-3);
}

@media (max-width: 860px) {
  .layout {
    grid-template-columns: minmax(0, 1fr);
    gap: 16px;
  }

  .side {
    position: static;
  }

  .fav-grid {
    grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  }
}
</style>
