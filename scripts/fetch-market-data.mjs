/**
 * 爬市集演示数据
 *
 * 数据源：**dummyjson**（https://dummyjson.com/products）—— 公开的演示用商品 API，
 * 免费、无鉴权、专门给原型用，数据本身是合成的。
 *
 * 为什么不爬真实电商（和 fetch-demo-photos.mjs 里「不爬小红书」同一条理由）：
 *   - 真实电商有签名反爬，爬通必须逆向绕过技术保护措施；
 *   - 抓下来的商品图和详情有版权，放进投简历的仓库反而是减分项；
 *   - 真实价格也拿不到「一个 2000 元余额能完整走一遍交易链路」这种可演示的分布。
 * 所以爬的是**公开的演示数据源**，图片本地落盘，不热链 CDN。
 *
 * 「图 ↔ 标题 ↔ 分类」三者对不上，比没有图更糟，所以中文名和描述是
 * **按爬到的信息人工校准**的（和笔记那边一样：图是爬的，文案是配的）。
 *
 * 产物：
 *   - server/uploads/demo/market/<分类>/<id>.webp   真实商品图（gitignore，不入库）
 *   - server/data/market-products.json               结构化商品数据（入库）
 *
 * 用法：node scripts/fetch-market-data.mjs
 */
import { mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const IMG_DIR = join(ROOT, 'server', 'uploads', 'demo', 'market')
const OUT_JSON = join(ROOT, 'server', 'data', 'market-products.json')
const API = 'https://dummyjson.com/products?limit=0'

/**
 * 市集的分类 = 站点的内容频道（穿搭 / 家居 / 美食 / 彩妆 / 健身） + 数码。
 *
 * 数码是市集自己的分类，不在内容频道里 —— 这是有意的：
 * 市集是「卖货」，内容频道是「看笔记」，两者不强行对齐。
 * （商品分类不跳话题页，所以不存在「点进去是空页」的问题。）
 *
 * slug 是给**图片目录**用的，必须是 ASCII：
 * 图片路径会直接进 URL，路径里带中文虽然浏览器能编码，
 * 但静态服务器、curl、任何拼路径的工具都要额外处理一遍 —— 没有理由给自己添这个。
 */
const CHANNELS = {
  穿搭: ['tops', 'womens-dresses', 'womens-bags', 'mens-shoes', 'mens-watches', 'sunglasses'],
  家居: ['kitchen-accessories', 'furniture', 'home-decoration'],
  美食: ['groceries'],
  彩妆: ['beauty', 'skin-care', 'fragrances'],
  健身: ['sports-accessories'],
  数码: ['smartphones', 'tablets', 'laptops', 'mobile-accessories']
}

/** 分类中文名 → 目录用的小写 slug */
const SLUG = {
  穿搭: 'fashion',
  家居: 'home',
  美食: 'food',
  彩妆: 'beauty',
  健身: 'sports',
  数码: 'digital'
}

/**
 * 人工校准的中文名与描述。
 * key 是 dummyjson 的商品 id，值是 { t: 标题, d: 描述 }。
 *
 * 写这段的原因是：dummyjson 的标题是英文的，而站点是中文的。
 * 直接把 "Bamboo Spatula" 摆进一个中文内容社区的商城里，**看起来就是假数据**。
 * 翻成中文又不是机器翻译能解决的 —— 「Carbon Steel Wok」得写成「碳钢炒锅」，
 * 「Chopping Board」得写成「木砧板」，因为「砧板」才是中国人买这个东西时用的词。
 */
const COPY = {
  // ── 家居 ──
  48: { t: '竹制锅铲 · 天然木柄', d: '整块竹子削出来的，铲头不伤涂层，炒菜不刮锅' },
  52: { t: '碳钢炒锅 30cm', d: '无涂层碳钢，开锅之后越用越顺，配硅胶锅铲' },
  53: { t: '木砧板 · 双面可用', d: '正面切菜反面切生熟，边缘有把手好拿' },
  65: { t: '不锈钢便当盒 750ml', d: '带密封圈，能装汤不漏，四个卡扣扣得很死' },
  73: { t: '厨房调料架 · 双层', d: '免打孔免安装，贴上墙就能用，瓶罐按大小分层' },
  45: { t: '观叶绿植 · 带盆发货', d: '好养的室内品种，散射光就能长，每周浇一次' },
  47: { t: '陶瓷台灯 · 三档色温', d: '暖光不刺眼，灯罩可拆，洗起来方便' },
  12: { t: '布艺三人沙发', d: '可拆洗的棉麻套，坐垫偏软，骨架是实木' },

  // ── 穿搭 ──
  162: { t: '蓝色碎花连衣裙', d: '收腰版型，V 领显锁骨，面料有垂感不贴腿' },
  166: { t: '格纹连衣裙 · 加厚款', d: '过膝长度，格子配色沉稳，通勤和出门都能穿' },
  177: { t: '黑色小礼服', d: '露肩设计，缎面材质，参加活动刚好不夸张' },
  172: { t: '蓝色手提包', d: '能装 14 寸笔记本，五金件是电镀的，肩带可调' },
  175: { t: '白色双肩包', d: '防泼水面料，笔记本隔层有缓冲，肩带加厚不勒肩' },
  90: { t: '复古运动鞋', d: '鞋底偏硬，适合走路多的场合，尺码偏大半码' },
  154: { t: '黑框太阳镜', d: 'UV400 防护，镜腿有弹性，戴久了鼻梁不疼' },
  93: { t: '真皮表带腕表', d: '皮带会随佩戴变软，防水溅但不能洗手戴' },

  // ── 美食 ──
  16: { t: '红富士苹果 · 5 斤装', d: '脆甜多汁，个头均匀，坏果包赔' },
  17: { t: '原切牛排 · 谷饲', d: '真空冷链发货，煎到三分熟刚好，油花分布均匀' },
  19: { t: '冷鲜鸡胸肉 1kg', d: '低脂高蛋白，解冻后用厨房纸吸干水分再煎' },
  23: { t: '土鸡蛋 30 枚', d: '个头小一点，蛋黄颜色深，煮 8 分钟就全熟' },
  27: { t: '百花蜜 500g', d: '自然成熟蜜，结晶是正常的，冲水用温水别用开水' },
  28: { t: '手工冰淇淋 4 杯装', d: '需冷链，到货先放冷冻室两小时再挖' },
  34: { t: '挂耳咖啡 · 10 片装', d: '中深烘，热水冲 30 秒，兑牛奶也好喝' },
  38: { t: '五常大米 5kg', d: '真空袋装，开袋有米香，煮饭水米比 1:1.2' },

  // ── 彩妆 ──
  1: { t: '纤长卷翘睫毛膏', d: '防水不晕染，苍蝇腿慎入，需要卸妆水' },
  2: { t: '十二色眼影盘 · 带镜', d: '大地色和珠光都有，粉质不飞，中间附小镜子' },
  4: { t: '正红口红 · 哑光', d: '不拔干，用之前先涂唇膏，持久度大概 4 小时' },
  5: { t: '红色指甲油', d: '两三层颜色才饱和，干透要 5 分钟，附卸甲水' },
  119: { t: '滋润沐浴露 500ml', d: '奶香型，起泡快，冲得干净不留滑腻感' },
  8: { t: '女士香水 50ml', d: '花香调，留香大概 4 小时，喷手腕而不是衣领' },

  // ── 健身 ──
  140: { t: '室外篮球 7 号', d: '耐磨橡胶材质，室外水泥地也不打滑' },
  141: { t: '家用篮球架', d: '免安装挂式，配一个 7 号球刚好，篮板可调角度' },
  146: { t: '羽毛球 12 筒装', d: '鹅毛球，飞行稳定，筒装方便收纳' },
  151: { t: '比赛级网球 3 罐', d: '毛球含胶，出球快，罐装要放在阴凉处' },
  152: { t: '全碳素网球拍', d: '拍框轻，重心靠上好发力，附拍包和避震器' },
  148: { t: '高尔夫球 3 颗装', d: '三层球结构，飞行距离稳定，认准球号' },

  // ── 数码 ──
  121: { t: '二手智能手机 · 95 新', d: '国行，已root，无拆无修，电池健康 89%' },
  78: { t: '笔记本电脑 14 英寸', d: 'i7 处理器 / 16G / 512G，循环次数少，附原装充电器' },
  159: { t: '平板电脑 8.3 英寸', d: '带手写笔和保护壳，屏幕无划痕' },
  100: { t: '无线降噪耳机', d: '主动降噪，开盒续航约 5 小时，配件齐全' },
  106: { t: '智能手表 · GPS 版', d: '能独立离线运动，记录步数和心率，表带是硅胶的' },
  111: { t: '手机自拍杆 三脚架', d: '蓝牙遥控，自带夹子，折叠后能塞进包' }
}

/** 每个分类挑哪几件（dummyjson 的 id） */
const PICKS = {
  家居: [48, 52, 53, 65, 73, 45, 47, 12],
  穿搭: [162, 166, 177, 172, 175, 90, 154, 93],
  美食: [16, 17, 19, 23, 27, 28, 34, 38],
  彩妆: [1, 2, 4, 5, 119, 8],
  健身: [140, 141, 146, 151, 152, 148],
  数码: [121, 78, 159, 100, 106, 111]
}

/**
 * 美元 → 人民币，并取整到电商上常见的那个价。
 *
 * 不直接乘汇率：$7.99 换算过来是 ¥56.7，写进商品标题是「56.7 元」，
 * 而全站金额是**整数分**，定价也得落在「69 / 219 / 13499」这种价上，
 * 看起来才像真的在卖东西。
 */
function toCny(usd) {
  const v = Number(usd) * 7.1
  if (v < 100) return Math.max(9, Math.floor(v / 10) * 10 + 9)
  if (v < 1000) return Math.floor(v / 10) * 10 + 9
  return Math.floor(v / 100) * 100 + 99
}

async function download(url, dest) {
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) })
  if (!res.ok) throw new Error('HTTP ' + res.status)
  const buf = Buffer.from(await res.arrayBuffer())
  writeFileSync(dest, buf)
  return buf.length
}

console.log('拉取 ' + API + ' …')
const res = await fetch(API, { signal: AbortSignal.timeout(60000) })
if (!res.ok) {
  console.error('拉取失败：HTTP ' + res.status)
  process.exit(1)
}
const all = (await res.json()).products
console.log(`拿到 ${all.length} 件原始商品`)

const byId = new Map(all.map((p) => [p.id, p]))
const products = []
let downloaded = 0
let reused = 0

for (const [channel, ids] of Object.entries(PICKS)) {
  const slug = SLUG[channel]
  const dir = join(IMG_DIR, slug)
  mkdirSync(dir, { recursive: true })

  for (const id of ids) {
    const raw = byId.get(id)
    if (!raw) {
      console.log(`  ! id ${id} 在源数据里不存在，跳过`)
      continue
    }
    const copy = COPY[id]
    if (!copy) {
      console.log(`  ! id ${id} 还没有中文文案，跳过`)
      continue
    }

    // 最多取 3 张图
    const urls = (raw.images || []).slice(0, 3)
    const localPaths = []
    for (let i = 0; i < urls.length; i++) {
      const file = `p${id}-${i + 1}.webp`
      const dest = join(dir, file)
      if (existsSync(dest)) {
        reused++
        localPaths.push(`/uploads/demo/market/${slug}/${file}`)
        continue
      }
      try {
        const bytes = await download(urls[i], dest)
        downloaded++
        localPaths.push(`/uploads/demo/market/${slug}/${file}`)
        if (bytes < 2000) console.log(`  ! id ${id} 第 ${i + 1} 张图只有 ${bytes} 字节，可能不是图`)
      } catch (err) {
        console.log(`  ! id ${id} 第 ${i + 1} 张图下载失败：${err.message}`)
      }
    }

    products.push({
      // 来源留痕：id 和原始分类能对回 dummyjson 的那条商品
      sourceId: id,
      sourceCategory: raw.category,
      sourceUrl: `https://dummyjson.com/products/${id}`,
      category: channel,
      title: copy.t,
      description: copy.d,
      priceCents: toCny(raw.price) * 100,
      stock: Math.max(1, Math.min(raw.stock ?? 1, 12)),
      coverImage: localPaths[0] || null,
      images: localPaths
    })
  }
}

/**
 * 一件「已下架」的演示商品。
 *
 * 它演示的是一条规则：**下架的商品别人看不到，但卖家自己还看得见**。
 * 这条规则必须有数据才能验 —— 只在界面上写一句「下架的商品别人看不到」
 * 是没有证据的，而这条规则恰恰是「谁的商品谁能改」那套权限模型的边界。
 *
 * 它放在数据文件里而不是 seed 里硬编码：seed 只管「读数据 → 写库」，
 * 不该夹带一份商品数据（那样就有两处商品清单了）。
 */
const OFF_SHELF_DEMO = {
  category: '家居',
  title: '折叠沥水篮（已下架演示）',
  description: '演示「下架商品别人看不到，卖家自己还看得见」',
  priceCents: 3900,
  stock: 0,
  offShelf: true,
  coverImage: '/uploads/demo/market/home/ph.svg',
  images: []
}

const out = {
  source: 'https://dummyjson.com/products',
  note: '商品图来自 dummyjson 的公开演示数据，中文名与描述是人工校准的（见 scripts/fetch-market-data.mjs）。',
  count: products.length + 1,
  categories: Object.keys(PICKS),
  products: [...products, OFF_SHELF_DEMO]
}

mkdirSync(join(ROOT, 'server', 'data'), { recursive: true })
writeFileSync(OUT_JSON, JSON.stringify(out, null, 2) + '\n', 'utf8')

console.log(`\n商品 ${products.length} 件，写入 ${OUT_JSON}`)
console.log(`图片：新下载 ${downloaded} 张，复用 ${reused} 张 → ${IMG_DIR}`)
const byCat = {}
for (const p of products) byCat[p.category] = (byCat[p.category] || 0) + 1
console.log(
  '分类分布: ' +
    Object.entries(byCat)
      .map(([c, n]) => `${c} ${n}`)
      .join(' / ')
)
const noImg = products.filter((p) => !p.coverImage).length
if (noImg) console.log(`⚠ ${noImg} 件没有图，seed 会给它们生成占位图`)
