import { createConnection, Socket } from 'net'
import { EventEmitter } from 'events'

export interface RconOptions {
  host: string
  port?: number
  password: string
  timeout?: number
}

/**
 * 轻量级 Minecraft RCON 客户端
 * 替换已停止维护的 rcon-client 库，修复认证兼容性问题
 *
 * 主要改进：
 * - 正确处理 Minecraft 服务端的认证响应（兼容 Vanilla/Paper/Spigot/Fabric）
 * - 稳健的 TCP 分包/合包缓冲处理
 * - 独立的 TCP 连接超时和认证超时
 * - 密码类型安全（防止 YAML 解析为非字符串）
 */
export class Rcon {
  private socket: Socket | null = null
  private emitter = new EventEmitter()
  private buf = Buffer.alloc(0)
  private nextId = 0
  private authenticated = false

  // 认证阶段回调（独立于命令回调，避免 id 冲突）
  private authCb: {
    id: number
    resolve: () => void
    reject: (err: Error) => void
    timer: ReturnType<typeof setTimeout>
  } | null = null

  // 命令响应回调
  private pending = new Map<number, {
    resolve: (body: string) => void
    reject: (err: Error) => void
    timer: ReturnType<typeof setTimeout>
  }>()

  private host: string
  private port: number
  private password: string
  private timeout: number

  constructor(options: RconOptions) {
    this.host = options.host
    this.port = options.port ?? 25575
    // 关键修复：强制转为字符串，防止 YAML 将纯数字/布尔密码解析为非 string 类型
    this.password = String(options.password ?? '')
    this.timeout = options.timeout ?? 5000
  }

  static async connect(options: RconOptions): Promise<Rcon> {
    const rcon = new Rcon(options)
    await rcon.connect()
    return rcon
  }

  on(event: string, listener: (...args: any[]) => void) {
    this.emitter.on(event, listener)
  }

  once(event: string, listener: (...args: any[]) => void) {
    this.emitter.once(event, listener)
  }

  off(event: string, listener: (...args: any[]) => void) {
    this.emitter.removeListener(event, listener)
  }

  async connect(): Promise<void> {
    if (this.socket) throw new Error('Already connected')

    // ── Phase 1: TCP 连接 ──
    const socket = createConnection({ host: this.host, port: this.port })
    this.socket = socket

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.destroy()
        this.socket = null
        reject(new Error(
          `RCON: TCP connection to ${this.host}:${this.port} timed out (${this.timeout}ms)`
        ))
      }, this.timeout)

      const onError = (err: Error) => {
        clearTimeout(timer)
        this.socket = null
        reject(err)
      }

      socket.once('error', onError)
      socket.once('connect', () => {
        clearTimeout(timer)
        socket.removeListener('error', onError)
        resolve()
      })
    })

    socket.setNoDelay(true)

    socket.on('data', (chunk) => {
      this.buf = Buffer.concat([this.buf, chunk])
      this.drain()
    })

    socket.on('error', (err) => this.emitter.emit('error', err))

    socket.on('close', () => {
      this.authenticated = false
      this.socket = null
      this.buf = Buffer.alloc(0)
      for (const [, p] of this.pending) {
        clearTimeout(p.timer)
        p.reject(new Error('Connection closed'))
      }
      this.pending.clear()
      if (this.authCb) {
        clearTimeout(this.authCb.timer)
        this.authCb.reject(new Error('Connection closed during authentication'))
        this.authCb = null
      }
      this.emitter.emit('end')
    })

    // ── Phase 2: RCON 认证 ──
    const authId = this.nextId++

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.authCb = null
        socket.destroy()
        this.socket = null
        reject(new Error(`RCON: Authentication timed out (${this.timeout}ms)`))
      }, this.timeout)

      this.authCb = { id: authId, resolve, reject, timer }

      // Auth packet: type = 3 (SERVERDATA_AUTH)
      socket.write(this.encode(authId, 3, this.password))
    })
  }

  async send(command: string): Promise<string> {
    if (!this.authenticated || !this.socket) {
      throw new Error('RCON not connected')
    }

    const id = this.nextId++

    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`RCON command timed out: ${command}`))
      }, this.timeout)

      this.pending.set(id, { resolve, reject, timer })
      // Command packet: type = 2 (SERVERDATA_EXECCOMMAND)
      this.socket!.write(this.encode(id, 2, command))
    })
  }

  end(): void {
    this.socket?.destroy()
  }

  // ── RCON 协议编解码 ──

  /**
   * 编码 RCON 数据包
   * 格式: [4:size][4:id][4:type][body][0x00][0x00]
   */
  private encode(id: number, type: number, body: string): Buffer {
    const payload = Buffer.from(body, 'utf-8')
    const size = 4 + 4 + payload.length + 2 // id + type + body + 2 null terminators
    const pkt = Buffer.alloc(4 + size) // 4 for size field
    pkt.writeInt32LE(size, 0)
    pkt.writeInt32LE(id, 4)
    pkt.writeInt32LE(type, 8)
    payload.copy(pkt, 12)
    // 末尾 2 字节已由 Buffer.alloc 置 0x00（null terminators）
    return pkt
  }

  /**
   * 从缓冲区中提取并处理完整的 RCON 数据包
   * 正确处理 TCP 分包和合包
   */
  private drain(): void {
    while (this.buf.length >= 4) {
      const size = this.buf.readInt32LE(0)
      // 安全校验：size 最小为 10（4 id + 4 type + 2 null），最大为 1MB
      if (size < 10 || size > 0x100000) {
        this.buf = Buffer.alloc(0)
        return
      }
      const total = 4 + size
      if (this.buf.length < total) return // 等待更多数据

      const raw = this.buf.subarray(0, total)
      this.buf = this.buf.subarray(total)

      const id = raw.readInt32LE(4)
      const type = raw.readInt32LE(8)
      // body 位于 header(12字节) 之后、末尾 2 字节 null 之前
      const bodyEnd = Math.max(12, total - 2)
      const body = raw.subarray(12, bodyEnd).toString('utf-8').replace(/\0+$/, '')

      this.onPacket(id, type, body)
    }
  }

  /**
   * 处理接收到的 RCON 数据包
   *
   * 认证阶段：
   *   Minecraft 服务端对认证请求的响应因实现而异：
   *   - Vanilla: 仅发送 Auth_Response (type=2, id=请求id 或 -1)
   *   - 部分实现: 先发送空 Response_Value (type=0) 再发送 Auth_Response
   *
   *   处理策略：
   *   1. 收到 type=2（Auth_Response）→ 立即判断认证结果
   *   2. 收到 id=-1 → 认证失败（无论 type）
   *   3. 其他包 → 忽略（可能是前导空响应）
   */
  private onPacket(id: number, type: number, body: string): void {
    if (!this.authenticated && this.authCb) {
      // Auth_Response (type=2) 或 id=-1 → 最终认证结果
      if (type === 2 || id === -1) {
        const cb = this.authCb
        this.authCb = null
        clearTimeout(cb.timer)

        if (id === -1) {
          cb.reject(new Error('RCON authentication failed: incorrect password'))
        } else if (id === cb.id) {
          this.authenticated = true
          this.emitter.emit('authenticated')
          cb.resolve()
        } else {
          cb.reject(new Error(`RCON authentication failed: unexpected response id ${id}`))
        }
        return
      }

      // type != 2 且 id != -1 → 前导空响应包，忽略
      return
    }

    // ── 命令响应 ──
    const cb = this.pending.get(id)
    if (cb) {
      this.pending.delete(id)
      clearTimeout(cb.timer)
      cb.resolve(body)
    }
  }
}