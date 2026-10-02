/**
 * WebSocket 服务端测试
 *
 * 重点覆盖多端同步：同一个 userId 挂两个连接，验证
 *   - 对方发来的消息，两个连接都收到
 *   - 自己发的消息，另一个连接也收到（= 微信「电脑发手机收」）
 *
 * 起真实 http server + 真实 ws 客户端，不用 mock —— WS 的行为
 * （握手鉴权、upgrade、ping/pong、close）本来就是协议层的，mock 掉就测不到了。
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import WebSocket from 'ws'
import jwt from 'jsonwebtoken'
import { createTestApp, teardownTestDb } from './app'
import { attachWebSocketServer, type WsServerHandle } from '../src/ws/server'
import { env } from '../src/lib/env'
import type { ServerMessage } from '../src/ws/protocol'

let server: http.Server
let handle: WsServerHandle
let port: number
let db: any

const accounts: Record<string, { id: number; token: string }> = {}

/** 给 WS 客户端套一个消息队列，测试里就不用到处挂 on('message') */
class Client {
  readonly socket: WebSocket
  readonly received: ServerMessage[] = []

  constructor(token: string | null) {
    const url = token ? `ws://127.0.0.1:${port}/ws?token=${token}` : `ws://127.0.0.1:${port}/ws`
    this.socket = new WebSocket(url)
    this.socket.on('message', (raw) => {
      try {
        this.received.push(JSON.parse(raw.toString()))
      } catch {
        /* 忽略非 JSON 帧 */
      }
    })
  }

  /** 等待某类消息出现（已经收到过也算） */
  async waitFor(type: ServerMessage['type'], timeout = 3000): Promise<ServerMessage> {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      const hit = this.received.find((m) => m.type === type)
      if (hit) return hit
      await new Promise((r) => setTimeout(r, 20))
    }
    throw new Error(
      `等不到 ${type} 消息，实际收到：${this.received.map((m) => m.type).join(', ') || '(空)'}`
    )
  }

  countOf(type: ServerMessage['type']): number {
    return this.received.filter((m) => m.type === type).length
  }

  send(data: unknown) {
    this.socket.send(JSON.stringify(data))
  }

  /** 故意发非法 JSON，验证服务端不会崩 */
  sendRaw(text: string) {
    this.socket.send(text)
  }

  async close() {
    if (
      this.socket.readyState === WebSocket.OPEN ||
      this.socket.readyState === WebSocket.CONNECTING
    ) {
      this.socket.close()
      await new Promise((r) => setTimeout(r, 50))
    }
  }
}

function openAs(name: string): Client {
  return new Client(accounts[name].token)
}

beforeAll(async () => {
  // createTestApp 内部已经 setTestDb 成 :memory:，这里拿到的 db 就是 WS 侧会用的那个
  const created = createTestApp()
  db = created.db

  server = http.createServer(created.app)
  handle = attachWebSocketServer(server)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  port = (server.address() as AddressInfo).port

  // 建三个账号
  for (const [name, email] of [
    ['alice', 'ws-alice@test.com'],
    ['bob', 'ws-bob@test.com'],
    ['carol', 'ws-carol@test.com']
  ] as const) {
    const res = await fetch(`http://127.0.0.1:${port}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'secret123', nickname: name })
    })
    const body = (await res.json()) as any
    accounts[name] = {
      id: body.userInfo.id,
      token: jwt.sign({ userId: body.userInfo.id, email }, env.JWT_SECRET)
    }
  }
})

afterAll(async () => {
  await handle.close()
  await new Promise<void>((r) => server.close(() => r()))
  teardownTestDb()
})

beforeEach(() => {
  db.prepare(`DELETE FROM messages`).run()
  db.prepare(`UPDATE conversations SET last_message_id = NULL, last_message_at = NULL`).run()
})

const clients: Client[] = []
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()))
})

describe('握手鉴权', () => {
  it('不带 token 的连接会被 4401 关闭', async () => {
    const c = new Client(null)
    clients.push(c)
    await new Promise<void>((resolve) => {
      c.socket.on('close', () => resolve())
      setTimeout(resolve, 1500)
    })
    expect(c.socket.readyState).toBe(WebSocket.CLOSED)
    // @ts-expect-error 读 ws 内部关闭码
    expect((c.socket as any)._closeCode).toBe(4401)
  })

  it('token 无效同样被拒', async () => {
    const c = new Client('not-a-real-token')
    clients.push(c)
    await new Promise<void>((resolve) => {
      c.socket.on('close', () => resolve())
      setTimeout(resolve, 1500)
    })
    // @ts-expect-error 读 ws 内部关闭码
    expect((c.socket as any)._closeCode).toBe(4401)
  })

  it('鉴权失败的连接不会被登记进 Hub', async () => {
    const before = handle.hub.totalConnections
    const c = new Client('bad')
    clients.push(c)
    await new Promise((r) => setTimeout(r, 300))
    expect(handle.hub.totalConnections).toBe(before)
  })

  it('合法 token 能连上并收到 ready', async () => {
    const c = openAs('alice')
    clients.push(c)
    const ready = await c.waitFor('ready')
    expect(ready.payload.userId).toBe(accounts.alice.id)
    expect(Array.isArray(ready.payload.onlineUserIds)).toBe(true)
  })
})

describe('离线补偿 sync', () => {
  it('连接后立刻收到 sync', async () => {
    const c = openAs('alice')
    clients.push(c)
    const sync = await c.waitFor('sync')
    expect(Array.isArray(sync.payload.conversations)).toBe(true)
    expect(Array.isArray(sync.payload.messages)).toBe(true)
  })

  it('离线期间收到的消息会在重连时补发', async () => {
    // 先让 bob 直接往库里写一条 alice 没读过的消息（模拟 alice 掉线期间发生的）
    const conv = db.prepare(`SELECT * FROM conversations LIMIT 1`).get() as any

    if (!conv) {
      // 没有会话就现建一个
      const [a, b] = [accounts.alice.id, accounts.bob.id].sort((x, y) => x - y)
      const info = db
        .prepare(`INSERT INTO conversations (user_a_id, user_b_id) VALUES (?, ?)`)
        .run(a, b)
      db.prepare(
        `INSERT INTO messages (conversation_id, sender_id, receiver_id, content) VALUES (?,?,?,?)`
      ).run(Number(info.lastInsertRowid), accounts.bob.id, accounts.alice.id, '离线时发的消息')
    } else {
      db.prepare(
        `INSERT INTO messages (conversation_id, sender_id, receiver_id, content) VALUES (?,?,?,?)`
      ).run(conv.id, accounts.bob.id, accounts.alice.id, '离线时发的消息')
    }

    const c = openAs('alice')
    clients.push(c)
    const sync = await c.waitFor('sync')
    expect(sync.payload.messages.map((m) => m.content)).toContain('离线时发的消息')
  })
})

describe('发消息', () => {
  it('A 发消息 B 收到', async () => {
    const alice = openAs('alice')
    const bob = openAs('bob')
    clients.push(alice, bob)
    await Promise.all([alice.waitFor('ready'), bob.waitFor('ready')])

    alice.send({ type: 'send_message', payload: { receiverId: accounts.bob.id, content: '在吗' } })

    const got = await bob.waitFor('message')
    expect(got.payload.message.content).toBe('在吗')
    expect(got.payload.message.senderId).toBe(accounts.alice.id)
    expect(got.payload.message.receiverId).toBe(accounts.bob.id)
  })

  it('消息真的落库了', async () => {
    const alice = openAs('alice')
    const bob = openAs('bob')
    clients.push(alice, bob)
    await Promise.all([alice.waitFor('ready'), bob.waitFor('ready')])

    alice.send({
      type: 'send_message',
      payload: { receiverId: accounts.bob.id, content: '落库测试' }
    })
    await bob.waitFor('message')

    const { total } = db
      .prepare(`SELECT COUNT(*) AS total FROM messages WHERE content = ?`)
      .get('落库测试') as { total: number }
    expect(total).toBe(1)
  })

  it('发给自己其他设备（多端同步）', async () => {
    const pc = openAs('alice')
    const phone = openAs('alice')
    clients.push(pc, phone)
    await Promise.all([pc.waitFor('ready'), phone.waitFor('ready')])

    pc.send({ type: 'send_message', payload: { receiverId: accounts.bob.id, content: '多端消息' } })

    // 手机端也收到了 —— 这就是「电脑发、手机收」
    const onPhone = await phone.waitFor('message')
    expect(onPhone.payload.message.content).toBe('多端消息')
    // 而且带 tempId 语义：没有 tempId 的设备直接当新消息
    expect(onPhone.payload.tempId).toBeUndefined()
  })

  it('带 tempId 时原样回传（乐观消息替换用）', async () => {
    const alice = openAs('alice')
    clients.push(alice)
    await alice.waitFor('ready')

    alice.send({
      type: 'send_message',
      payload: { receiverId: accounts.bob.id, content: '带 tempId', tempId: 'tmp-1' }
    })
    const got = await alice.waitFor('message')
    expect(got.payload.tempId).toBe('tmp-1')
    expect(got.payload.message.id).toBeGreaterThan(0)
  })

  it('不传 conversationId 会自动建会话', async () => {
    const alice = openAs('alice')
    const carol = openAs('carol')
    clients.push(alice, carol)
    await Promise.all([alice.waitFor('ready'), carol.waitFor('ready')])

    alice.send({
      type: 'send_message',
      payload: { receiverId: accounts.carol.id, content: '首次' }
    })
    const got = await carol.waitFor('message')
    expect(got.payload.message.conversationId).toBeGreaterThan(0)
  })
})

describe('多端推送（核心）', () => {
  it('对方开两个连接，两个都收到', async () => {
    const alice = openAs('alice')
    const bobPC = openAs('bob')
    const bobPhone = openAs('bob')
    clients.push(alice, bobPC, bobPhone)
    await Promise.all([alice.waitFor('ready'), bobPC.waitFor('ready'), bobPhone.waitFor('ready')])

    expect(handle.hub.connectionCount(accounts.bob.id)).toBe(2)

    alice.send({
      type: 'send_message',
      payload: { receiverId: accounts.bob.id, content: '双端接收' }
    })

    const [onPC, onPhone] = await Promise.all([
      bobPC.waitFor('message'),
      bobPhone.waitFor('message')
    ])
    expect(onPC.payload.message.id).toBe(onPhone.payload.message.id)
  })

  it('ready 里的 onlineUserIds 能看出谁在线', async () => {
    const alice = openAs('alice')
    clients.push(alice)
    const ready = await alice.waitFor('ready')
    expect(ready.payload.onlineUserIds).toContain(accounts.alice.id)
  })

  it('连接关闭后从 Hub 摘除', async () => {
    const a = openAs('alice')
    await a.waitFor('ready')
    const b = openAs('alice')
    await b.waitFor('ready')
    expect(handle.hub.connectionCount(accounts.alice.id)).toBe(2)

    await b.close()
    await new Promise((r) => setTimeout(r, 200))
    expect(handle.hub.connectionCount(accounts.alice.id)).toBe(1)
  })
})

describe('已读回执', () => {
  it('B 读消息后 A 收到回执', async () => {
    const alice = openAs('alice')
    const bob = openAs('bob')
    clients.push(alice, bob)
    await Promise.all([alice.waitFor('ready'), bob.waitFor('ready')])

    alice.send({ type: 'send_message', payload: { receiverId: accounts.bob.id, content: '读我' } })
    const received = await bob.waitFor('message')
    const convId = received.payload.message.conversationId

    bob.send({ type: 'read', payload: { conversationId: convId } })

    const receipt = await alice.waitFor('read_receipt')
    expect(receipt.payload.conversationId).toBe(convId)
    expect(receipt.payload.readerId).toBe(accounts.bob.id)
  })

  it('重复标记已读不会重复推送回执', async () => {
    const alice = openAs('alice')
    const bob = openAs('bob')
    clients.push(alice, bob)
    await Promise.all([alice.waitFor('ready'), bob.waitFor('ready')])

    alice.send({ type: 'send_message', payload: { receiverId: accounts.bob.id, content: 'x' } })
    const received = await bob.waitFor('message')
    const convId = received.payload.message.conversationId

    bob.send({ type: 'read', payload: { conversationId: convId } })
    await alice.waitFor('read_receipt')
    const countAfterFirst = alice.countOf('read_receipt')

    bob.send({ type: 'read', payload: { conversationId: convId } })
    await new Promise((r) => setTimeout(r, 300))
    expect(alice.countOf('read_receipt')).toBe(countAfterFirst)
  })
})

describe('typing 与心跳', () => {
  it('typing 只转发不落库', async () => {
    const alice = openAs('alice')
    const bob = openAs('bob')
    clients.push(alice, bob)
    await Promise.all([alice.waitFor('ready'), bob.waitFor('ready')])

    // 先造一个会话
    alice.send({ type: 'send_message', payload: { receiverId: accounts.bob.id, content: 'hi' } })
    const received = await bob.waitFor('message')
    const convId = received.payload.message.conversationId

    alice.send({ type: 'typing', payload: { conversationId: convId } })
    const typing = await bob.waitFor('typing')
    expect(typing.payload.userId).toBe(accounts.alice.id)

    const { total } = db
      .prepare(`SELECT COUNT(*) AS total FROM messages WHERE conversation_id = ?`)
      .get(convId) as { total: number }
    expect(total).toBe(1) // 只有那一条真实消息
  })

  it('ping 有 pong 回', async () => {
    const alice = openAs('alice')
    clients.push(alice)
    await alice.waitFor('ready')
    alice.send({ type: 'ping', payload: { ts: 1234 } })
    const pong = await alice.waitFor('pong')
    expect(pong.payload.ts).toBe(1234)
  })
})

describe('输入校验', () => {
  it('空消息被拒', async () => {
    const alice = openAs('alice')
    clients.push(alice)
    await alice.waitFor('ready')
    alice.send({
      type: 'send_message',
      payload: { receiverId: accounts.bob.id, content: '   ', tempId: 'bad-1' }
    })
    const err = await alice.waitFor('error')
    expect(err.payload.code).toBe('empty_message')
    expect(err.payload.tempId).toBe('bad-1')
  })

  it('超长消息被拒', async () => {
    const alice = openAs('alice')
    clients.push(alice)
    await alice.waitFor('ready')
    alice.send({
      type: 'send_message',
      payload: { receiverId: accounts.bob.id, content: 'a'.repeat(501) }
    })
    const err = await alice.waitFor('error')
    expect(err.payload.code).toBe('message_too_long')
  })

  it('给自己发消息被拒', async () => {
    const alice = openAs('alice')
    clients.push(alice)
    await alice.waitFor('ready')
    alice.send({ type: 'send_message', payload: { receiverId: accounts.alice.id, content: 'hi' } })
    const err = await alice.waitFor('error')
    expect(err.payload.code).toBe('bad_payload')
  })

  it('非会话成员不能往该会话发消息', async () => {
    const alice = openAs('alice')
    const carol = openAs('carol')
    clients.push(alice, carol)
    await Promise.all([alice.waitFor('ready'), carol.waitFor('ready')])

    // alice 和 bob 建会话
    alice.send({ type: 'send_message', payload: { receiverId: accounts.bob.id, content: 'hi' } })
    const got = await alice.waitFor('message')
    const convId = got.payload.message.conversationId

    // carol 拿着这个会话 id 想发言
    carol.send({
      type: 'send_message',
      payload: { conversationId: convId, receiverId: accounts.bob.id, content: '闯入' }
    })
    const err = await carol.waitFor('error')
    expect(err.payload.code).toBe('not_a_member')
  })

  it('非法 JSON 不会让连接崩掉', async () => {
    const alice = openAs('alice')
    clients.push(alice)
    await alice.waitFor('ready')

    alice.sendRaw('{这不是 JSON')
    const err = await alice.waitFor('error')
    expect(err.payload.code).toBe('bad_payload')
    // 连接还活着：还能正常 ping
    alice.send({ type: 'ping', payload: { ts: 1 } })
    expect((await alice.waitFor('pong')).payload.ts).toBe(1)
  })

  it('未知消息类型返回错误而不是静默丢弃', async () => {
    const alice = openAs('alice')
    clients.push(alice)
    await alice.waitFor('ready')
    alice.send({ type: '不存在的类型', payload: {} })
    const err = await alice.waitFor('error')
    expect(err.payload.message).toContain('不存在的类型')
  })
})
