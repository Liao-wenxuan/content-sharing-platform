<script setup lang="ts">
/**
 * 收藏夹管理（专辑）
 *
 * 两块内容：
 *   上：收藏夹列表（新建 / 重命名 / 删除 + 每夹的笔记数）
 *   下：未分类的收藏，可勾选后一键移进某个夹
 *
 * 为什么「未分类」要单独摆出来而不是藏进「全部」里：
 * 用户点了收藏之后，它落在未分类是**默认行为**，不是分类结果。
 * 如果不把它显式列出来，用户会打开收藏页发现「空的」，
 * 然后以为自己收藏失败了 —— 这是收藏功能最常见的投诉来源。
 *
 * 删除收藏夹不会删笔记（外键 ON DELETE SET NULL），只把它们退回未分类，
 * 所以这里没有二次确认弹窗，只在按钮上写明后果。
 */
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Collection, Plus, Delete, EditPen, FolderOpened } from '@element-plus/icons-vue'
import { favoritesApi, type FavoriteFolder, type FavoritedPost } from '@/api/favorites'
import EmptyState from '@/components/EmptyState.vue'

const router = useRouter()

const folders = ref<FavoriteFolder[]>([])
const unclassifiedCount = ref(0)
const unclassified = ref<FavoritedPost[]>([])
const selected = ref<number[]>([])

const loading = ref(false)
const errorMsg = ref('')
const creating = ref(false)
const newName = ref('')
const busyId = ref<number | null>(null)

async function loadFolders() {
  const { list, unclassifiedCount: n } = await favoritesApi.folders()
  folders.value = list
  unclassifiedCount.value = n
}

async function loadUnclassified() {
  const { list } = await favoritesApi.list({ folderId: 'unclassified', pageSize: 50 })
  unclassified.value = list
}

async function load() {
  loading.value = true
  errorMsg.value = ''
  selected.value = []
  try {
    await loadFolders()
    await loadUnclassified()
  } catch (err: any) {
    errorMsg.value = err?.response?.data?.message || '加载失败'
  } finally {
    loading.value = false
  }
}

async function createFolder() {
  const name = newName.value.trim()
  if (!name || creating.value) return
  creating.value = true
  try {
    await favoritesApi.createFolder(name)
    newName.value = ''
    await loadFolders()
    ElMessage.success('收藏夹已创建')
  } catch (err: any) {
    ElMessage.error(err?.response?.data?.message || '创建失败')
  } finally {
    creating.value = false
  }
}

async function renameFolder(folder: FavoriteFolder) {
  try {
    const { value } = await ElMessageBox.prompt('新的收藏夹名称', '重命名', {
      inputValue: folder.name,
      inputPattern: /^.{1,20}$/,
      inputErrorMessage: '名称不能为空且不超过 20 字'
    })
    const name = String(value).trim()
    if (!name || name === folder.name) return
    await favoritesApi.renameFolder(folder.id, name)
    await loadFolders()
    ElMessage.success('已重命名')
  } catch (err: any) {
    if (err === 'cancel' || err === 'close') return
    ElMessage.error(err?.response?.data?.message || '重命名失败')
  }
}

async function deleteFolder(folder: FavoriteFolder) {
  try {
    await ElMessageBox.confirm(
      `删除「${folder.name}」不会删掉里面的 ${folder.postCount} 篇笔记，它们会退回未分类。确定删除吗？`,
      '删除收藏夹',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  busyId.value = folder.id
  try {
    const res = await favoritesApi.deleteFolder(folder.id)
    await load()
    unclassifiedCount.value = res.unclassifiedCount
    ElMessage.success('收藏夹已删除')
  } catch (err: any) {
    ElMessage.error(err?.response?.data?.message || '删除失败')
  } finally {
    busyId.value = null
  }
}

/** 批量移动：一次整理一摞，否则这个功能会被用不起来 */
async function moveSelected(folderId: number) {
  if (selected.value.length === 0) return
  busyId.value = folderId
  try {
    const res = await favoritesApi.moveToFolder(folderId, selected.value)
    await load()
    ElMessage.success(`已移动 ${res.moved} 篇`)
  } catch (err: any) {
    ElMessage.error(err?.response?.data?.message || '移动失败')
  } finally {
    busyId.value = null
  }
}

function toggleSelect(id: number) {
  const i = selected.value.indexOf(id)
  if (i === -1) selected.value.push(id)
  else selected.value.splice(i, 1)
}

const hasSelection = computed(() => selected.value.length > 0)

onMounted(load)
</script>

<template>
  <div class="fav-manage">
    <div class="head">
      <h1 class="title">收藏夹</h1>
      <p class="subtitle">把收藏整理成专辑，方便以后按主题回看</p>
    </div>

    <EmptyState v-if="errorMsg" variant="error" :title="errorMsg" action="重试" @action="load" />
    <EmptyState v-else-if="loading" variant="loading" title="加载中..." />

    <template v-else>
      <!-- ===== 新建 ===== -->
      <el-card shadow="never" class="block">
        <template #header><span class="block-title">新建收藏夹</span></template>
        <div class="create-row">
          <el-input
            v-model="newName"
            placeholder="收藏夹名称，最多 20 字"
            maxlength="20"
            show-word-limit
            @keyup.enter="createFolder"
          />
          <el-button type="primary" :loading="creating" @click="createFolder">
            <el-icon><component :is="Plus" /></el-icon>
            创建
          </el-button>
        </div>
      </el-card>

      <!-- ===== 收藏夹列表 ===== -->
      <el-card shadow="never" class="block">
        <template #header>
          <span class="block-title">全部收藏夹（{{ folders.length }}）</span>
        </template>

        <el-empty v-if="folders.length === 0" description="还没有收藏夹" :image-size="70" />

        <ul v-else class="folder-list">
          <li v-for="f in folders" :key="f.id" class="folder-row">
            <el-icon class="folder-icon"><component :is="FolderOpened" /></el-icon>
            <div class="folder-info">
              <div class="folder-name">{{ f.name }}</div>
              <div class="folder-count">{{ f.postCount }} 篇笔记</div>
            </div>
            <el-button
              v-if="hasSelection"
              type="primary"
              size="small"
              :loading="busyId === f.id"
              @click="moveSelected(f.id)"
            >
              移入（{{ selected.length }}）
            </el-button>
            <el-button size="small" text @click="renameFolder(f)">
              <el-icon><component :is="EditPen" /></el-icon>
            </el-button>
            <el-button size="small" text :loading="busyId === f.id" @click="deleteFolder(f)">
              <el-icon><component :is="Delete" /></el-icon>
            </el-button>
          </li>
        </ul>
      </el-card>

      <!-- ===== 未分类 ===== -->
      <el-card shadow="never" class="block">
        <template #header>
          <span class="block-title">
            未分类（{{ unclassifiedCount }}）
            <span v-if="hasSelection" class="hint">已选 {{ selected.length }} 篇</span>
          </span>
          <el-button link size="small" @click="router.push('/profile/me')"
            >去我的主页看全部</el-button
          >
        </template>

        <el-empty
          v-if="unclassified.length === 0"
          description="没有未分类的收藏，很整洁 👌"
          :image-size="70"
        />

        <ul v-else class="post-list">
          <li v-for="p in unclassified" :key="p.id" class="post-row">
            <el-checkbox :model-value="selected.includes(p.id)" @change="toggleSelect(p.id)" />
            <el-avatar :size="32" :src="p.author?.avatar || undefined" />
            <div class="post-info">
              <div class="post-text">{{ p.content }}</div>
              <div class="post-meta">{{ p.author?.nickname }}</div>
            </div>
            <el-button size="small" text @click="router.push(`/post/${p.id}`)">
              <el-icon><component :is="Collection" /></el-icon>
            </el-button>
          </li>
        </ul>
      </el-card>
    </template>
  </div>
</template>

<style scoped>
.fav-manage {
  max-width: 720px;
  margin: 0 auto;
  padding: 24px 0 48px;
}

.head {
  margin-bottom: 18px;
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

.block {
  margin-bottom: 16px;
}

.block-title {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 14px;
  font-weight: 600;
  color: var(--foreground);
}

.hint {
  font-size: 12px;
  font-weight: 400;
  color: var(--accent);
}

.create-row {
  display: flex;
  gap: 10px;
}

.folder-list,
.post-list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.folder-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 0;
  border-bottom: 1px solid var(--border);
}

.folder-row:last-child {
  border-bottom: none;
}

.folder-icon {
  flex-shrink: 0;
  font-size: 18px;
  color: var(--muted-foreground);
}

.folder-info {
  flex: 1;
  min-width: 0;
}

.folder-name {
  font-size: 14px;
  color: var(--foreground);
}

.folder-count {
  margin-top: 2px;
  font-size: 12px;
  color: var(--muted-foreground);
}

.post-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 0;
  border-bottom: 1px solid var(--border);
}

.post-row:last-child {
  border-bottom: none;
}

.post-info {
  flex: 1;
  min-width: 0;
}

.post-text {
  font-size: 14px;
  color: var(--foreground);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.post-meta {
  margin-top: 2px;
  font-size: 12px;
  color: var(--muted-foreground);
}
</style>
