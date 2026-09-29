/**
 * 下载演示配图
 *
 * 为什么不爬小红书：
 *   - XHS 接口有 x-s / x-t 签名反爬，爬通必须逆向绕过技术保护措施
 *   - 抓下来的内容有版权，放进投简历的仓库反而是减分项
 *   所以改用 Unsplash 公开图床的真实照片（可免费商用），
 *   再人工挑一遍，保证「图 ↔ 标题 ↔ 频道」三者对得上。
 *
 * 图片来自 images.unsplash.com 的公开直链，w=800 足够瀑布流展示。
 * 下载后建议跑 `node scripts/contact-sheet.mjs` 生成联络表肉眼核对主题。
 *
 * 用法：node scripts/fetch-demo-photos.mjs
 */
import { writeFileSync, mkdirSync, existsSync } from 'node:fs'

const OUT = new URL('../server/uploads/demo/', import.meta.url).pathname.replace(
  /^\/([A-Za-z]:)/,
  '$1'
)
if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true })

// 第一轮：生活方式类（穿搭 / 美食 / 家居 / 旅行 / 职场 / 人像）
// 第二轮：补齐健身 / 影视 / 游戏 / 运动几个方向
const IDS = [
  // 美食
  '1495474472287-4d71bcdd2085', // 咖啡拉花俯拍
  '1498837167922-ddd27525d352', // 沙拉蔬菜平铺
  '1466637574441-749b8f19452f', // 砧板备菜
  '1504674900247-0877df9cc836', // 牛排摆盘
  '1517248135467-4c7edcad34c4', // 餐厅内景
  // 穿搭
  '1441986300917-64674bd600d8', // 服装店
  '1483985988355-763728e1935b', // 风衣女墨镜
  '1487222477894-8943e31ef7b2', // 皮衣男
  '1517842645767-c639042777db', // 牛仔外套
  // 家居
  '1484154218962-a197022b5858', // 现代厨房
  '1493809842364-78817add7ffb', // 客厅落地窗
  // 旅行
  '1449824913935-59a10b8d2000', // 城市街道
  '1524230572899-a752b3835840', // 白色拱廊
  '1444723121867-7a241cacace9', // 城市夜景航拍
  // 职场 / 人像
  '1573496359142-b8d87734a5a2', // 西装女性
  '1519389950473-47ba0277781c', // 团队协作俯拍
  '1522071820081-009f0129c71c', // 团队在工作
  '1517842645767-c639042777db', // 桌面笔记本
  '1522202176988-66273c2fd55f', // 两人讨论
  '1543269865-cbf427effbad', // 一群人交流
  '1524995997946-a1c2e315a42f', // 图书馆书架
  '1494790108377-be9c29b29330', // 人物特写（彩妆）
  '1507003211169-0a1dd7228f2d', // 人物特写
  // 健身
  '1534438327276-14e5300c3a48', // 哑铃架健身房
  '1571019613454-1cb2f99b2d8b', // 瑜伽垫
  '1540497077202-7c8a3999166f', // 健身房器械
  '1517649763962-0c623066013b', // 公路骑行
  // 影视 / 游戏
  '1574375927938-d5a98e8ffe85', // NETFLIX 屏幕
  '1542751371-adc38448a05e', // 电竞选手
  '1593305841991-05c297ba4575', // 游戏显示器
  '1600861194942-f883de0dfe96', // 游戏手柄
  '1493711662062-fa541adb3fc8', // 手柄玩游戏
  '1550745165-9bc0b252726f', // 复古游戏机
  '1551103782-8ab07afd45c1' // 游戏手办
]

let n = 0
let ok = 0
for (const id of IDS) {
  const url = `https://images.unsplash.com/photo-${id}?w=800&q=75&fm=jpg`
  try {
    const res = await fetch(url)
    if (!res.ok) {
      console.log('skip', id, res.status)
      n++
      continue
    }
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length < 15_000) {
      console.log('skip (too small)', id)
      n++
      continue
    }
    const name = `d${n}-${id.slice(0, 8)}.jpg`
    writeFileSync(OUT + name, buf)
    console.log('ok  ', name, Math.round(buf.length / 1024) + 'KB')
    ok++
  } catch (e) {
    console.log('fail', id, e.message)
  }
  n++
}
console.log(`\n成功 ${ok}/${IDS.length}，输出目录 server/uploads/demo/`)
console.log('下一步：node scripts/contact-sheet.mjs 生成联络表核对主题')
