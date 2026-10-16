<script setup lang="ts">
/**
 * 收货地址
 *
 * 之前是一个死按钮。现在是一套完整的地址簿：增 / 改 / 删 / 设默认。
 *
 * 手机号默认打码显示：地址簿虽然只有自己能看，
 * 但用户会在有别人在旁边的时候打开这个面板 ——
 * 明文全屏显示手机号会让「快速看一眼自己填对没有」变得有心理负担。
 * 想确认时点一下「显示完整号码」即可。
 */
import { ref, computed, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from '@/utils/element'
import { addressesApi, formatAddress, maskPhone, type Address } from '@/api/addresses'

const list = ref<Address[]>([])
const loading = ref(true)
const errorMsg = ref('')

const editing = ref<Address | null>(null)
const saving = ref(false)
const formError = ref('')
const showPhone = ref(false)

const form = ref({
  receiver: '',
  phone: '',
  province: '',
  city: '',
  detail: '',
  isDefault: false
})

const isNew = computed(() => editing.value === null)

onMounted(load)

async function load() {
  loading.value = true
  errorMsg.value = ''
  try {
    list.value = await addressesApi.list()
  } catch (e: any) {
    errorMsg.value = e?.response?.data?.message || '读取地址失败'
  } finally {
    loading.value = false
  }
}

function startNew() {
  editing.value = null
  formError.value = ''
  form.value = {
    receiver: '',
    phone: '',
    province: '',
    city: '',
    detail: '',
    // 新建时默认勾上「设为默认」：用户十有八九是来换默认地址的
    isDefault: list.value.length === 0
  }
}

function startEdit(a: Address) {
  editing.value = a
  formError.value = ''
  form.value = {
    receiver: a.receiver,
    phone: a.phone,
    province: a.province,
    city: a.city,
    detail: a.detail,
    isDefault: a.isDefault
  }
}

function cancelEdit() {
  editing.value = null
  formError.value = ''
}

async function save() {
  formError.value = ''

  // 前端先做一轮校验，不是为了省请求，
  // 而是为了让错误出现在字段旁边而不是页面顶部的一条 toast
  for (const [key, label] of [
    ['receiver', '收货人'],
    ['phone', '手机号'],
    ['province', '省份'],
    ['city', '城市'],
    ['detail', '详细地址']
  ] as const) {
    if (!form.value[key].trim()) {
      formError.value = `请填写${label}`
      return
    }
  }
  if (!/^[\d+\-\s()]{6,20}$/.test(form.value.phone)) {
    formError.value = '手机号格式不正确'
    return
  }

  saving.value = true
  try {
    if (isNew.value) {
      await addressesApi.create(form.value)
      ElMessage.success('地址已保存')
    } else {
      await addressesApi.update(editing.value!.id, form.value)
      ElMessage.success('地址已更新')
    }
    cancelEdit()
    await load()
  } catch (e: any) {
    formError.value = e?.response?.data?.message || '保存失败，请重试'
  } finally {
    saving.value = false
  }
}

async function setDefault(a: Address) {
  try {
    await addressesApi.update(a.id, { isDefault: true })
    await load()
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.message || '设置失败')
  }
}

async function remove(a: Address) {
  try {
    await ElMessageBox.confirm(
      `删除「${a.receiver} · ${formatAddress(a)}」？` +
        (a.isDefault ? '它是默认地址，删除后会自动换成另一条。' : ''),
      '确认删除这个地址？',
      { confirmButtonText: '删除', cancelButtonText: '取消', type: 'warning' }
    )
  } catch {
    return
  }

  try {
    await addressesApi.remove(a.id)
    // 删掉的正好是正在编辑的那条 → 表单必须一起关掉，
    // 否则用户会对着一个已经不存在的地址点「更新」然后收到 404
    if (editing.value?.id === a.id) cancelEdit()
    await load()
    ElMessage.success('已删除')
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.message || '删除失败')
  }
}
</script>

<template>
  <div class="panel">
    <el-alert v-if="errorMsg" type="error" :title="errorMsg" :closable="false" show-icon />

    <!-- 编辑表单 -->
    <section v-if="editing || isNew" class="editor">
      <h3 class="editor-title">{{ isNew ? '新增地址' : '编辑地址' }}</h3>

      <div class="grid">
        <el-input v-model="form.receiver" placeholder="收货人" maxlength="20" />
        <el-input v-model="form.phone" placeholder="手机号" maxlength="20" />
        <el-input v-model="form.province" placeholder="省份" maxlength="20" />
        <el-input v-model="form.city" placeholder="城市" maxlength="30" />
      </div>
      <el-input
        v-model="form.detail"
        placeholder="详细地址（街道、门牌号）"
        maxlength="120"
        class="full"
      />

      <div class="editor-foot">
        <el-checkbox v-model="form.isDefault">设为默认地址</el-checkbox>
        <div class="editor-actions">
          <el-button size="small" @click="cancelEdit">取消</el-button>
          <el-button size="small" type="primary" :loading="saving" @click="save">
            {{ isNew ? '保存' : '更新' }}
          </el-button>
        </div>
      </div>

      <el-alert
        v-if="formError"
        type="error"
        :title="formError"
        :closable="false"
        show-icon
        class="form-err"
      />
    </section>

    <!-- 列表 -->
    <div v-loading="loading" class="list">
      <template v-if="!loading && list.length === 0 && editing === null">
        <div class="empty">
          <p class="empty-title">还没有收货地址</p>
          <p class="empty-desc">
            市集目前的交易是站内余额结算，还没有接物流。 存下地址是为了以后接运费和发货时不用从头填
            —— 但它现在**不会**被用在任何一笔订单上。
          </p>
          <el-button type="primary" @click="startNew">添加一个</el-button>
        </div>
      </template>

      <div v-for="a in list" :key="a.id" class="item" :class="{ editing: editing?.id === a.id }">
        <div class="item-main">
          <div class="item-top">
            <span class="item-name">{{ a.receiver }}</span>
            <el-tag v-if="a.isDefault" size="small" type="primary" effect="plain">默认</el-tag>
            <button class="phone-toggle" type="button" @click="showPhone = !showPhone">
              <span class="tnum">{{ showPhone ? a.phone : maskPhone(a.phone) }}</span>
            </button>
          </div>
          <div class="item-addr">{{ formatAddress(a) }}</div>
        </div>

        <div class="item-actions">
          <el-button v-if="!a.isDefault" size="small" text @click="setDefault(a)">
            设为默认
          </el-button>
          <el-button size="small" text @click="startEdit(a)">编辑</el-button>
          <el-button size="small" text type="danger" @click="remove(a)">删除</el-button>
        </div>
      </div>
    </div>

    <el-button v-if="list.length > 0 && editing === null" class="add" @click="startNew">
      + 新增地址
    </el-button>
  </div>
</template>

<style scoped>
.editor {
  padding: 16px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--surface-2);
  margin-bottom: 18px;
}

.editor-title {
  font-size: var(--fs-md);
  font-weight: 600;
  color: var(--text-1);
  margin: 0 0 12px;
}

.grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  margin-bottom: 8px;
}

.full {
  width: 100%;
}

.editor-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 12px;
}

.editor-actions {
  display: flex;
  gap: 8px;
}

.form-err {
  margin-top: 12px;
}

.list {
  min-height: 100px;
}

.item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-4);
  padding: 12px;
  border: 1px solid var(--border-soft);
  border-radius: var(--radius-sm);
  margin-bottom: 8px;
  transition: border-color var(--dur-fast) var(--ease-out-expo);
}

.item.editing {
  border-color: var(--accent);
}

.item-main {
  min-width: 0;
}

.item-top {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 3px;
}

.item-name {
  font-size: var(--fs-base);
  color: var(--text-1);
  font-weight: 500;
}

.phone-toggle {
  background: none;
  border: none;
  padding: 0;
  cursor: pointer;
  color: var(--text-2);
  font-size: var(--fs-xs);
  font-family: var(--font-numeric);
}

.phone-toggle:hover {
  color: var(--accent);
}

.item-addr {
  font-size: var(--fs-sm);
  color: var(--text-2);
}

.item-actions {
  display: flex;
  gap: 2px;
  flex-shrink: 0;
}

.empty {
  text-align: center;
  padding: 32px 16px;
}

.empty-title {
  font-size: var(--fs-md);
  color: var(--text-1);
  margin: 0 0 6px;
}

.empty-desc {
  font-size: var(--fs-sm);
  color: var(--text-2);
  line-height: 1.8;
  margin: 0 0 16px;
}

.add {
  width: 100%;
  margin-top: 4px;
}
</style>
