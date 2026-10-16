/**
 * Element Plus 的「函数式」组件出口（ElMessage / ElMessageBox 等）。
 *
 * 为什么不直接 `import {ElMessage} from '@/utils/element'`：
 * 那是整个库的总桶，`es/index.mjs` re-export 全部 98 个组件。
 * 只要有一个首屏模块从总桶导入，date-picker、table-v2、transfer 这些
 * 用不到的组件连同 dayjs / @popperjs/core / @vueuse/core 就会一起进首屏。
 *
 * 模板里的组件由 vite.config.ts 的深路径 resolver 解决，
 * 但 ElMessage 这类**在 script 里调用**的组件 resolver 扫不到，
 * 只能手写 —— 手写 26 处很容易漏，所以统一收敛到这个文件。
 *
 * 新增函数式组件时：先确认 `element-plus/es/components/<dir>/index.mjs`
 * 存在并导出了它，再加到这里。scripts/analyze-bundle.mjs 会扫总桶，
 * 有人绕过这个文件直接 import 'element-plus' 会让检查变红。
 */

// message 和 message-box 的 index.mjs 是标准 ES 出口，可以直接具名导入
export { ElMessage } from 'element-plus/es/components/message/index'
export { ElMessageBox } from 'element-plus/es/components/message-box/index'

// UploadFile 只是类型，纯类型导入不会进产物；
// 但它仍然必须走深路径 —— `from 'element-plus'` 的类型也会把总桶拉进
// 类型图里，vue-tsc 每次检查都要重新解析整棵依赖树。
export type { UploadFile } from 'element-plus/es/components/upload/src/upload'
