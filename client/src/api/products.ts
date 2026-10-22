import request from './request'

/**
 * 商品
 *
 * 与 server/src/routes/products.ts 一一对应，字段名也照抄服务端的返回，
 * 中间不另起一套命名 —— 两套名字对不上是前端 bug 里最难查的一种。
 *
 * ⚠️ 注意 `sellerId` 不是 `userId`：products 表的列名就是 seller_id。
 */

export type ProductStatus = 'on_sale' | 'off_shelf'

/**
 * 市集分类。
 *
 * ⚠️ **服务端有一份一模一样的**（server/src/constants.ts 的 PRODUCT_CATEGORIES）。
 * 两个 tsconfig 互不包含，这是唯一能跑通的写法 ——
 * 但改的时候必须两边一起改，否则前端会开始提交服务端不认的分类。
 */
export const MARKET_CATEGORIES = ['穿搭', '家居', '美食', '彩妆', '健身', '数码'] as const

export type MarketCategory = (typeof MARKET_CATEGORIES)[number]

export interface Product {
  id: number
  sellerId: number
  title: string
  description: string | null
  /** 整数分。显示请走 utils/money 的 formatYuan */
  priceCents: number
  coverImage: string | null
  images: string[]
  stock: number
  status: ProductStatus
  /** 分类。老数据（迁移前建的）没有这一列，所以是 null 而不是 '' */
  category: MarketCategory | null
  createdAt: string
  seller: { id: number; nickname: string; avatar: string | null }
}

export type ProductSort = 'new' | 'price_asc' | 'price_desc'

export interface ProductListQuery {
  page?: number
  pageSize?: number
  q?: string
  sort?: ProductSort
  /**
   * 按分类筛。空 = 不筛。
   * 服务端是精确匹配（`WHERE category = ?`），不是模糊 ——
   * 点「家居」不该把「家居收纳」也捞出来。
   */
  category?: MarketCategory
  /**
   * 只看某位卖家的商品。
   * 传自己的 id 时能看到自己下架的，别人只能看在售的。
   */
  sellerId?: number
}

/**
 * 商品列表的结果。
 *
 * hasMore 由服务端给（和 orders / wallet 一致）——
 * 客户端自己按 total 推的话，两边的翻页算法一改就会对不上，
 * 症状是「加载更多」按钮要么不出现、要么一直出现。
 */
export interface ProductListResult {
  list: Product[]
  pagination: { page: number; pageSize: number; total: number; hasMore: boolean }
}

export interface CreateProductPayload {
  title: string
  /** 整数分。表单里的「元」要先过 utils/money 的 yuanToCents */
  priceCents: number
  stock: number
  description?: string
  coverImage?: string | null
  images?: string[]
  /**
   * 分类。不传就是「未分类」——
   * 服务端只校验「传了就必须在白名单里」，不强制必填：
   * 强制必填的话，发布表单就多一个填错就发不出去的坎，
   * 而未分类的商品照样能在「全部」里被看到。
   */
  category?: MarketCategory
}

export interface UpdateProductPayload {
  title?: string
  priceCents?: number
  stock?: number
  description?: string
}

export const productsApi = {
  list(params: ProductListQuery = {}): Promise<ProductListResult> {
    return request.get<ProductListResult>('/products', { params })
  },

  detail(id: number): Promise<Product> {
    return request.get<Product>(`/products/${id}`)
  },

  create(payload: CreateProductPayload): Promise<Product> {
    return request.post<Product>('/products', payload)
  },

  update(id: number, payload: UpdateProductPayload): Promise<Product> {
    return request.patch<Product>(`/products/${id}`, payload)
  },

  /**
   * 上下架是两个方法而不是 toggle。
   *
   * 和关注 / 收藏一致：调用方要能区分「本来就已经下架」和「我刚把它下架了」，
   * toggle 表达不了这个区别，用户点了两次会以为上架了其实没上架。
   */
  onShelf(id: number): Promise<{ status: ProductStatus }> {
    return request.post<{ status: ProductStatus }>(`/products/${id}/on-shelf`)
  },

  offShelf(id: number): Promise<{ status: ProductStatus }> {
    return request.post<{ status: ProductStatus }>(`/products/${id}/off-shelf`)
  }
}
