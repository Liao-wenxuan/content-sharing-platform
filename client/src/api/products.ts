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
