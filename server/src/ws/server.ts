import type { Server as HttpServer, IncomingMessage } from 'http'
import { WebSocketServer, WebSocket } from 'ws'
import jwt from 'jsonwebtoken'
import { env } from '../lib/env'
import { MESSAGE_MAX_LENGTH } from '../constants'
import { Hub } from './hub'
import { setHub } from './instance'
import { WS_ERROR, type ClientMessage, type ServerMessage } from './protocol'
import {
  assertMember,
  getOrCreateConversation,
  insertMessage,
  listConversationsFor,
  listUnreadMessages,
  markConversationRead,
  unreadTotalFor,
  validateMessageContent
} from '../lib/chat'

/**
 * WebSocket 服务端
 *
 * 三件事：
 * 1. 握手鉴权 —— 浏览器 WS API 不能自定义请求头，所以 token 只能走 query。
 *    代价和规避办法见 authenticate() 的注释。
 * 2. 连接登记 —— 交给 Hub，Hub 用 Set 存同一用户的多个连接，这是多端同步的基础。
 * 3. 消息路由 —— 收客户端的帧，落库后把结果推给相关方的「所有」连接。
 */

const HEARTBEAT_MS = 30_000
/** 自定义关闭码：4401 = 未授权（4000-4999 段留给应用层） */
const CLOSE_UNAUTHORIZED = 4401

export interface WsServerHandle {
  hub: Hub
  /** 优雅关闭：停心跳 + 断开所有连接 + 关 wss */
  close(): Promise<void>
}

/**
 * 从握手 URL 里解析 userId，解析不出来就返回 null。
 *
 * ⚠️ token 走 query 的安全权衡（面试常被追问）：
 *  - 为什么不用 header？浏览器 new WebSocket() 不支持自定义 header。
 *    生产上的替代方案是握手后立刻发一条 { type:'auth', token } 消息，
 *    在认证完成前只接受不涉及数据的连接。
 *  - 怎么降低泄漏风险？这里做了两件事：
 *    a) 校验失败立刻用 4401 关闭，非法连接根本进不了消息循环
 *    b) 全程不打印握手 URL，避免 token 进服务端日志
 */
function authenticate(req: IncomingMessage): number | null {
  const rawUrl = req.url
  if (!rawUrl) return null

  let token: string | null = null
  try {
    token = new URL(rawUrl, 'http://localhost').searchParams.get('token')
  } catch {
    return null
  }
  if (!token) return null

  try {
    const decoded = jwt.verify(token, env.JWT_SECRET) as { userId: number }
    return typeof decoded.userId === 'number' ? decoded.userId : null
  } catch {
    return null
  }
}

function sendTo(socket: WebSocket, message: ServerMessage): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message))
}

export function attachWebSocketServer(httpServer: HttpServer): WsServerHandle {
  const hub = new Hub()
  // 登记成单例，好让 HTTP 路由（写通知时）能推帧给用户的所有连接。
  // 没有这一步，「别人给我点赞 → 我的铃铛 +1」就只能靠轮询。
  setHub(hub)
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' })
  /** 上一轮 ping 是否收到了 pong；没收到就说明这条连接已经死了 */
  const alive = new WeakMap<WebSocket, boolean>()

  // ---------- 握手 + 每连接的处理器 ----------
  wss.on('connection', (socket, req) => {
    const userId = authenticate(req)

    if (userId === null) {
      // 鉴权失败：不登记、不进消息循环，直接踢掉
      socket.close(CLOSE_UNAUTHORIZED, 'unauthorized')
      return
    }

    alive.set(socket, true)
    hub.add(userId, socket)

    // 告诉前端「你连上了」+ 当前未读总数 + 哪些人在线（用来置灰离线用户）
    sendTo(socket, {
      type: 'ready',
      payload: {
        userId,
        unreadTotal: unreadTotalFor(userId),
        onlineUserIds: hub.onlineUserIds()
      }
    })

    // 离线补偿：把断线期间错过的会话和未读消息一次补齐。
    // 必须有这步 —— 浏览器切后台被系统回收、网络抖动，都会导致消息在服务端
    // 已经产生、但客户端没收到；重连后只等「之后的新消息」会永远漏掉这一段。
    sendTo(socket, {
      type: 'sync',
      payload: {
        conversations: listConversationsFor(userId),
        messages: listUnreadMessages(userId)
      }
    })

    // ---------- 心跳应答 ----------
    // 浏览器会自动回 pong，这里只更新存活标记
    socket.on('pong', () => alive.set(socket, true))

    // ---------- 断线清理 ----------
    const cleanup = () => hub.remove(userId, socket)
    socket.on('close', cleanup)
    socket.on('error', cleanup)

    // ---------- 消息 ----------
    socket.on('message', (raw) => {
      let msg: ClientMessage
      try {
        msg = JSON.parse(raw.toString())
      } catch {
        sendTo(socket, {
          type: 'error',
          payload: { code: WS_ERROR.BAD_PAYLOAD, message: '消息不是合法 JSON' }
        })
        return
      }

      if (!msg || typeof msg.type !== 'string') {
        sendTo(socket, {
          type: 'error',
          payload: { code: WS_ERROR.BAD_PAYLOAD, message: '缺少 type 字段' }
        })
        return
      }

      try {
        handleMessage(userId, socket, msg)
      } catch (err: any) {
        console.error('[WS Handle Error]', msg.type, err)
        sendTo(socket, {
          type: 'error',
          payload: { code: WS_ERROR.INTERNAL, message: '服务端处理失败' }
        })
      }
    })
  })

  // ---------- 服务端心跳：主动 ping，清理死连接 ----------
  const heartbeat = setInterval(() => {
    for (const client of wss.clients) {
      // 上一轮 ping 没等到 pong：连接已经不可信，直接 terminate
      if (alive.get(client) === false) {
        client.terminate()
        continue
      }
      alive.set(client, false)
      client.ping()
    }
  }, HEARTBEAT_MS)
  // 别让心跳定时器挡住进程退出
  heartbeat.unref?.()

  function handleMessage(userId: number, socket: WebSocket, msg: ClientMessage): void {
    switch (msg.type) {
      case 'ping': {
        sendTo(socket, { type: 'pong', payload: { ts: msg.payload?.ts ?? Date.now() } })
        return
      }

      case 'send_message': {
        const { conversationId, receiverId, content, tempId } = msg.payload ?? ({} as any)

        if (!Number.isInteger(receiverId) || receiverId <= 0 || receiverId === userId) {
          sendTo(socket, {
            type: 'error',
            payload: { code: WS_ERROR.BAD_PAYLOAD, message: 'receiverId 不合法', tempId }
          })
          return
        }

        const checked = validateMessageContent(content)
        if (!checked.ok) {
          sendTo(socket, {
            type: 'error',
            payload: {
              code: checked.reason,
              message:
                checked.reason === WS_ERROR.EMPTY_MESSAGE
                  ? '消息不能为空'
                  : `消息不能超过 ${MESSAGE_MAX_LENGTH} 字`,
              tempId
            }
          })
          return
        }

        // 会话：给了 id 就校验成员，没给就现建
        let convId: number
        if (Number.isInteger(conversationId)) {
          const conv = assertMember(conversationId as number, userId)
          if (!conv) {
            sendTo(socket, {
              type: 'error',
              payload: { code: WS_ERROR.NOT_A_MEMBER, message: '无权访问该会话', tempId }
            })
            return
          }
          convId = conversationId as number
        } else {
          convId = getOrCreateConversation(userId, receiverId).id
        }

        const saved = insertMessage(convId, userId, receiverId, checked.value)

        // 推给对方的所有连接（对方可能同时开着手机和电脑）
        hub.sendToUser(receiverId, { type: 'message', payload: { message: saved } })

        // 推给自己的所有连接并带上 tempId：
        //  - 发起端：把「发送中」那条乐观消息换成真实 id
        //  - 自己的其他设备：本地没有这个 tempId，收到就当新消息 append
        hub.sendToUser(userId, { type: 'message', payload: { message: saved, tempId } })
        return
      }

      case 'read': {
        const convId = Number(msg.payload?.conversationId)
        if (!Number.isInteger(convId) || !assertMember(convId, userId)) {
          sendTo(socket, {
            type: 'error',
            payload: { code: WS_ERROR.NOT_A_MEMBER, message: '无权访问该会话' }
          })
          return
        }
        const updated = markConversationRead(convId, userId)
        if (updated === 0) return

        // 告诉对方「你的消息被读了」—— 已读回执
        const conv = assertMember(convId, userId)!
        const peerId = conv.user_a_id === userId ? conv.user_b_id : conv.user_a_id
        hub.sendToUser(peerId, {
          type: 'read_receipt',
          payload: { conversationId: convId, readerId: userId, readAt: new Date().toISOString() }
        })
        return
      }

      case 'typing': {
        // 纯转发，不落库：这是瞬时状态，存下来也没意义
        const convId = Number(msg.payload?.conversationId)
        if (!Number.isInteger(convId)) return
        const conv = assertMember(convId, userId)
        if (!conv) return
        const peerId = conv.user_a_id === userId ? conv.user_b_id : conv.user_a_id
        hub.sendToUser(peerId, { type: 'typing', payload: { conversationId: convId, userId } })
        return
      }

      default: {
        sendTo(socket, {
          type: 'error',
          payload: { code: WS_ERROR.BAD_PAYLOAD, message: `未知消息类型：${(msg as any).type}` }
        })
      }
    }
  }

  return {
    hub,
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(heartbeat)
        hub.closeAll()
        wss.close(() => resolve())
      })
  }
}
