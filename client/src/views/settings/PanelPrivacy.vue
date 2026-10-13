<script setup lang="ts">
/**
 * 隐私设置
 *
 * 这一栏之前是死按钮，现在它做三件**都能验证**的事：
 * ① 四个隐私开关（真落库）
 * ② 导出我的数据（真接口，下载一个 JSON）
 * ③ 未成年人模式（落库 + 真的影响列表显示）
 *
 * 导出这一条是隐私权里最基本的一项，也是这个项目里
 * 唯一能证明「隐私设置不是摆设」的功能。
 */
import { ref, computed } from 'vue'
import { ElMessage } from 'element-plus'
import { useUserSettings } from '@/composables/useUserSettings'
import { settingsApi } from '@/api/settings'
import { downloadText, formatCount } from '@/utils/format'
import { EXPORT_COUNT_LABELS } from './labels'

const { settings, patch } = useUserSettings()

const exporting = ref(false)
const exportError = ref('')
const exportedCounts = ref<Record<string, number> | null>(null)

async function exportMyData() {
  exporting.value = true
  exportError.value = ''
  try {
    const data = await settingsApi.exportData()
    const stamp = new Date().toISOString().slice(0, 10)
    downloadText(`内容社区-我的数据-${stamp}.json`, JSON.stringify(data, null, 2))
    exportedCounts.value = (data as any).counts ?? null
    ElMessage.success('已下载')
  } catch (e: any) {
    exportError.value = e?.response?.data?.message || '导出失败，请稍后再试'
  } finally {
    exporting.value = false
  }
}

const blockedCount = computed(() => settings.value.blockedTags.length)
</script>

<template>
  <div class="panel">
    <section class="block">
      <h3 class="block-title">这些内容谁能看到</h3>

      <div class="row">
        <div class="row-text">
          <span class="row-label">个人主页对外可见</span>
          <span class="row-desc">
            关掉后陌生人直接访问会看到「该用户已设置为私密」。 已有链接不再可用 ——
            这是这个开关的全部代价
          </span>
        </div>
        <el-switch
          :model-value="settings.profilePublic"
          @update:model-value="(v: any) => patch({ profilePublic: v })"
        />
      </div>

      <div class="row">
        <div class="row-text">
          <span class="row-label">收藏夹公开</span>
          <span class="row-desc">
            收藏默认私密：接口只给本人看，别人主页上那栏显示「私密」占位
          </span>
        </div>
        <el-switch
          :model-value="settings.favoritesPublic"
          @update:model-value="(v: any) => patch({ favoritesPublic: v })"
        />
      </div>

      <div class="row">
        <div class="row-text">
          <span class="row-label">允许被推荐流触达</span>
          <span class="row-desc">
            关掉之后打开首页直接落在关注流，推荐频道被隐藏。
            你发的内容不会被删，只是不再进入别人的推荐候选集
          </span>
        </div>
        <el-switch
          :model-value="settings.allowRecommendedFeed"
          @update:model-value="(v: any) => patch({ allowRecommendedFeed: v })"
        />
      </div>
    </section>

    <section class="block">
      <h3 class="block-title">未成年人模式</h3>
      <div class="row">
        <div class="row-text">
          <span class="row-label">只显示纯文字笔记</span>
          <span class="row-desc"> 带图内容会被折叠。不是全部屏蔽 —— 那会让应用看起来坏了 </span>
        </div>
        <el-switch
          :model-value="settings.minorMode"
          @update:model-value="(v: any) => patch({ minorMode: v })"
        />
      </div>
    </section>

    <section class="block">
      <h3 class="block-title">屏蔽的内容</h3>
      <div class="row">
        <div class="row-text">
          <span class="row-label">已屏蔽的话题</span>
          <span class="row-desc">
            当前屏蔽了 {{ blockedCount }} 个。在
            <router-link to="/interest" class="link">兴趣画像</router-link>
            里可以看到全部并撤销
          </span>
        </div>
        <span class="count tnum">{{ blockedCount }}</span>
      </div>
    </section>

    <section class="block">
      <h3 class="block-title">拿回我的数据</h3>
      <p class="block-desc">
        下载一份 JSON，包含你的账号资料、全部笔记、评论、点赞、关注、收藏、
        收货地址和订单。<b>不包含</b>密码、登录凭据和钱包流水 ——
        那不是你的个人数据，而且导出文件会到处转发。
      </p>

      <el-button type="primary" :loading="exporting" @click="exportMyData">
        导出我的数据
      </el-button>

      <el-alert
        v-if="exportError"
        type="error"
        :title="exportError"
        :closable="false"
        show-icon
        class="err"
      />

      <ul v-if="exportedCounts" class="exported">
        <li v-for="(n, k) in exportedCounts" :key="k">
          {{ EXPORT_COUNT_LABELS[k] || k }}<b class="tnum">{{ formatCount(n) }}</b>
        </li>
      </ul>
    </section>

    <section class="block">
      <h3 class="block-title">我们存了什么</h3>
      <ul class="facts">
        <li>账号资料<b>邮箱 · 昵称 · 头像</b></li>
        <li>内容<b>笔记正文 · 图片 · 评论</b></li>
        <li>互动关系<b>点赞 · 关注 · 收藏</b></li>
        <li>交易<b>订单 · 钱包流水</b></li>
        <li>图片元数据<b>上传前已剥离 EXIF</b></li>
      </ul>
      <p class="note">
        最后一条值得单独说：发布笔记时图片会在浏览器里重新编码， EXIF 段（含 GPS
        坐标、机型、拍摄时间）会被物理删掉再上传。 换句话说，这个站点**拿不到**你照片里的位置信息。
      </p>
    </section>
  </div>
</template>

<script lang="ts">
export default { name: 'PanelPrivacy' }
</script>

<style scoped>
.block {
  margin-bottom: 28px;
}

.block-title {
  font-size: var(--fs-md);
  font-weight: 600;
  color: var(--text-1);
  margin: 0 0 10px;
}

.block-desc {
  font-size: var(--fs-sm);
  color: var(--text-2);
  line-height: 1.8;
  margin: 0 0 14px;
}

.block-desc b {
  color: var(--text-1);
  font-weight: 600;
}

.row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--sp-4);
  padding: 12px 0;
  border-bottom: 1px solid var(--border-soft);
}

.row-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.row-label {
  font-size: var(--fs-base);
  color: var(--text-1);
}

.row-desc {
  font-size: var(--fs-xs);
  color: var(--text-3);
  line-height: 1.6;
}

.link {
  color: var(--accent);
}

.count {
  font-size: var(--fs-md);
  color: var(--text-1);
}

.err {
  margin-top: 12px;
}

.exported {
  list-style: none;
  margin: 14px 0 0;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 8px;
}

.exported li {
  display: flex;
  justify-content: space-between;
  font-size: var(--fs-xs);
  color: var(--text-2);
}

.exported b {
  color: var(--text-1);
}

.facts {
  list-style: none;
  margin: 0;
  padding: 0;
}

.facts li {
  display: flex;
  justify-content: space-between;
  gap: var(--sp-4);
  padding: 8px 0;
  border-bottom: 1px solid var(--border-soft);
  font-size: var(--fs-sm);
  color: var(--text-2);
}

.facts b {
  color: var(--text-1);
  font-weight: 500;
  text-align: right;
}

.note {
  margin: 12px 0 0;
  font-size: var(--fs-xs);
  color: var(--text-3);
  line-height: 1.8;
}
</style>
