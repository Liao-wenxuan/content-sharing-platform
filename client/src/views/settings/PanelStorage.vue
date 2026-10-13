<script setup lang="ts">
/**
 * 存储空间
 *
 * ⚠️ 这个面板存在的理由是**替换掉写死的「1.94 GB」**。
 * 凭空捏造的数字比没有更糟：用户会拿它做判断，而它永远不变。
 * 现在这个数字是真从磁盘上量出来的（见 GET /api/settings/storage）。
 */
import { computed } from 'vue'
import { useStorageStats } from '@/composables/useStorageStats'
import { formatBytes, formatCount } from '@/utils/format'

const { stats, loading, error, load } = useStorageStats()

const totalBytes = computed(() => {
  if (!stats.value) return 0
  return stats.value.usedBytes + stats.value.avatarBytes
})

/** 图和头像各占多少。用来回答「大头是哪一类」 */
const imageShare = computed(() => {
  if (!stats.value || totalBytes.value === 0) return 0
  return Math.round((stats.value.usedBytes / totalBytes.value) * 100)
})
</script>

<template>
  <div class="panel">
    <el-alert v-if="error" type="error" :title="error" :closable="false" show-icon />

    <div v-loading="loading" class="body">
      <div class="total">
        <span class="total-label">这个账号占用的空间</span>
        <span class="total-value tnum">{{ formatBytes(totalBytes) }}</span>
      </div>

      <template v-if="stats">
        <div class="bar" role="img" :aria-label="`图片占 ${imageShare}%`">
          <span class="bar-image" :style="{ width: `${imageShare}%` }" />
        </div>

        <ul class="breakdown">
          <li>
            <span class="k">笔记配图</span>
            <span class="v tnum">{{ formatBytes(stats.usedBytes) }}</span>
          </li>
          <li>
            <span class="k">头像与封面</span>
            <span class="v tnum">{{ formatBytes(stats.avatarBytes) }}</span>
          </li>
          <li>
            <span class="k">文件数</span>
            <span class="v tnum">{{ formatCount(stats.fileCount) }}</span>
          </li>
        </ul>

        <p v-if="stats.missingCount > 0" class="warn">
          有 {{ formatCount(stats.missingCount) }} 个文件在数据库里有记录，
          但磁盘上已经找不到（可能是手动清理过 uploads 目录）。
          它们不计入占用，但列表里对应的图会显示不出来。
        </p>
      </template>
    </div>

    <section class="block">
      <h3 class="block-title">怎么降下来</h3>
      <ul class="hints">
        <li>删掉带图的老笔记是最直接的 —— 图片本身不会被自动清理</li>
        <li>换张更小的图作为封面：发布时只有第一张会作为列表封面</li>
        <li>导出数据里不包含图片文件，所以导出并不能帮你腾空间</li>
      </ul>
    </section>

    <section class="block">
      <h3 class="block-title">这个数字是怎么算出来的</h3>
      <p class="block-desc">
        只统计<b>你发的笔记上的图</b>，逐个去磁盘上量文件的实际大小。 不按上传配额估算 ——
        配额是「你最多能用多少」， 而这里要回答的是「现在到底占了多少」。
      </p>
      <p class="block-desc">
        共享目录里别人上传的文件算不到你头上，因为按用户分摊字节数
        需要额外维护一张文件表，那张表的维护成本大于这个数字本身的收益。
      </p>
      <el-button size="small" :loading="loading" @click="load(true)">重新统计</el-button>
    </section>
  </div>
</template>

<style scoped>
.body {
  min-height: 140px;
  margin-bottom: 24px;
}

.total {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--border-soft);
}

.total-label {
  font-size: var(--fs-sm);
  color: var(--text-2);
}

.total-value {
  font-size: var(--fs-xl);
  font-weight: 700;
  color: var(--text-1);
}

/* 两段式占比条。用比例而不是数字，因为「大头是哪一类」看形状更快 */
.bar {
  height: 6px;
  border-radius: 3px;
  background: var(--surface-3);
  overflow: hidden;
  margin: 14px 0;
}

.bar-image {
  display: block;
  height: 100%;
  background: var(--accent);
  transition: width var(--dur-medium) var(--ease-out-expo);
}

.breakdown {
  list-style: none;
  margin: 0;
  padding: 0;
}

.breakdown li {
  display: flex;
  justify-content: space-between;
  padding: 8px 0;
  border-bottom: 1px solid var(--border-soft);
  font-size: var(--fs-sm);
}

.breakdown .k {
  color: var(--text-2);
}

.breakdown .v {
  color: var(--text-1);
}

.warn {
  margin: 12px 0 0;
  padding: 10px 12px;
  border-left: 2px solid var(--el-color-warning);
  background: var(--surface-2);
  border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
  font-size: var(--fs-xs);
  color: var(--text-2);
  line-height: 1.7;
}

.block {
  margin-bottom: 26px;
}

.block-title {
  font-size: var(--fs-md);
  font-weight: 600;
  color: var(--text-1);
  margin: 0 0 8px;
}

.block-desc {
  font-size: var(--fs-sm);
  color: var(--text-2);
  line-height: 1.8;
  margin: 0 0 10px;
}

.block-desc b {
  color: var(--text-1);
  font-weight: 600;
}

.hints {
  margin: 0;
  padding-left: 18px;
}

.hints li {
  font-size: var(--fs-sm);
  color: var(--text-2);
  line-height: 1.9;
  margin-bottom: 4px;
}
</style>
