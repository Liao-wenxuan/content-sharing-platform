import { WebSocket } from 'ws'
import type { ServerMessage } from './protocol'

/**
 * 在线连接登记表
 *
 * 「多端同步」的全部秘密就在这：同一个 userId 对应一个 Set<WebSocket>，
 * 而不是单个 socket。往一个用户推消息时把这个 Set 里的连接全推一遍，
 * 于是「电脑端发的，手机端立刻收到」就是自然结果，不需要任何额外同步逻辑。
 *
 * 对比一下如果用 Map<userId, WebSocket> 会怎样：后连接的会覆盖先连接的，
 * 用户的第二个标签页就成了哑巴。
 */
export class Hub {
  private byUser = new Map<number, Set<WebSocket>>()

  add(userId: number, socket: WebSocket): void {
    let set = this.byUser.get(userId)
    if (!set) {
      set = new Set()
      this.byUser.set(userId, set)
    }
    set.add(socket)
  }

  remove(userId: number, socket: WebSocket): void {
    const set = this.byUser.get(userId)
    if (!set) return
    set.delete(socket)
    // 最后一个连接断开就删掉 key，否则用户多了 Map 会一直涨
    if (set.size === 0) this.byUser.delete(userId)
  }

  /** 该用户当前在线连接数（>1 说明是多端在线） */
  connectionCount(userId: number): number {
    return this.byUser.get(userId)?.size ?? 0
  }

  isOnline(userId: number): boolean {
    return this.connectionCount(userId) > 0
  }

  onlineUserIds(): number[] {
    return [...this.byUser.keys()]
  }

  /**
   * 推给某个用户的所有连接。
   * 顺带清掉发送失败的死连接 —— 不然 Set 里会一直堆积已经关掉的 socket。
   * @returns 成功送达的连接数
   */
  sendToUser(userId: number, message: ServerMessage): number {
    const set = this.byUser.get(userId)
    if (!set) return 0

    const data = JSON.stringify(message)
    let delivered = 0

    for (const socket of [...set]) {
      if (socket.readyState !== WebSocket.OPEN) {
        set.delete(socket)
        continue
      }
      socket.send(data, (err) => {
        if (err) set.delete(socket)
      })
      delivered++
    }

    if (set.size === 0) this.byUser.delete(userId)
    return delivered
  }

  /** 一次推给多个人（比如新消息要同时更新「对方」和「发送者的其他设备」） */
  sendToUsers(userIds: number[], message: ServerMessage): void {
    const seen = new Set<number>()
    for (const id of userIds) {
      if (seen.has(id)) continue
      seen.add(id)
      this.sendToUser(id, message)
    }
  }

  /** 测试 / 进程退出时收口 */
  closeAll(code = 1001, reason = 'server shutting down'): void {
    for (const set of this.byUser.values()) {
      for (const socket of set) {
        try {
          socket.close(code, reason)
        } catch {
          /* 已经在关闭流程里了，忽略 */
        }
      }
    }
    this.byUser.clear()
  }

  /** 仅测试用：当前登记的所有连接 */
  get totalConnections(): number {
    let n = 0
    for (const set of this.byUser.values()) n += set.size
    return n
  }
}
