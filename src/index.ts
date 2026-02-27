import { Adapter, Bot, Context, h, Logger, MessageEncoder, Schema, Session } from 'koishi'
import { Rcon } from './rcon'
import WebSocket from 'ws'

const logger = new Logger('minecraft')

// ============================================================================
// 鹊桥 V2 协议类型定义
// 参考文档: https://queqiao-docs.pages.dev
// ============================================================================

/**
 * Minecraft 文本组件格式
 * 参考: https://zh.minecraft.wiki/w/原始JSON文本格式
 */
export interface MinecraftTextComponent {
  text?: string
  color?: string
  bold?: boolean
  italic?: boolean
  underlined?: boolean
  strikethrough?: boolean
  obfuscated?: boolean
  extra?: MinecraftTextComponent[]
}

/**
 * 鹊桥 V2 Player 对象
 * 注意：不同服务端实现可能缺少部分字段
 */
export interface QueqiaoPlayer {
  nickname: string
  uuid?: string
  is_op?: boolean
  address?: string
  health?: number
  max_health?: number
  experience_level?: number
  experience_progress?: number
  total_experience?: number
  walk_speed?: number
  x?: number
  y?: number
  z?: number
}

/**
 * 鹊桥 V2 Death 对象
 */
export interface QueqiaoDeath {
  key?: string
  args?: string
  text?: string
}

/**
 * 鹊桥 V2 Achievement 对象
 */
export interface QueqiaoAchievement {
  display?: {
    title?: string
    description?: string
    frame?: string
  }
  text?: string
}

/**
 * 鹊桥 V2 事件基础结构
 */
export interface QueqiaoEventBase {
  timestamp: number
  post_type: 'message' | 'notice' | 'response'
  event_name: string
  server_name: string
  server_version?: string
  server_type?: string
}

/**
 * 玩家聊天事件 (PlayerChatEvent)
 */
export interface PlayerChatEvent extends QueqiaoEventBase {
  post_type: 'message'
  event_name: 'PlayerChatEvent'
  message: string
  rawMessage?: string
  message_id?: string
  player: QueqiaoPlayer
}

/**
 * 玩家命令事件 (PlayerCommandEvent)
 */
export interface PlayerCommandEvent extends QueqiaoEventBase {
  post_type: 'message'
  event_name: 'PlayerCommandEvent'
  command: string
  rawMessage?: string
  message_id?: string
  player: QueqiaoPlayer
}

/**
 * 玩家加入事件 (PlayerJoinEvent)
 */
export interface PlayerJoinEvent extends QueqiaoEventBase {
  post_type: 'notice'
  event_name: 'PlayerJoinEvent'
  sub_type: 'player_join'
  player: QueqiaoPlayer
}

/**
 * 玩家离开事件 (PlayerQuitEvent)
 */
export interface PlayerQuitEvent extends QueqiaoEventBase {
  post_type: 'notice'
  event_name: 'PlayerQuitEvent'
  sub_type: 'player_quit'
  player: QueqiaoPlayer
}

/**
 * 玩家死亡事件 (PlayerDeathEvent)
 */
export interface PlayerDeathEvent extends QueqiaoEventBase {
  post_type: 'notice'
  event_name: 'PlayerDeathEvent'
  sub_type: 'player_death'
  death?: QueqiaoDeath
  player: QueqiaoPlayer
}

/**
 * 玩家成就事件 (PlayerAchievementEvent)
 */
export interface PlayerAchievementEvent extends QueqiaoEventBase {
  post_type: 'notice'
  event_name: 'PlayerAchievementEvent'
  sub_type: 'player_achievement'
  achievement?: QueqiaoAchievement
  player: QueqiaoPlayer
}

export type QueqiaoEvent =
  | PlayerChatEvent
  | PlayerCommandEvent
  | PlayerJoinEvent
  | PlayerQuitEvent
  | PlayerDeathEvent
  | PlayerAchievementEvent

/**
 * 鹊桥 V2 API 请求格式
 */
export interface QueqiaoApiRequest<T = any> {
  api: string
  data: T
  echo?: string | number
}

/**
 * 鹊桥 V2 API 响应格式
 */
export interface QueqiaoApiResponse<T = any> {
  code: number
  api: string
  post_type: 'response'
  status: 'SUCCESS' | 'FAILED'
  message: string
  data?: T
  echo?: string | number
}

// ============================================================================
// 配置类型定义
// ============================================================================

/**
 * 单个服务器的配置（扁平化结构）
 * 每个服务器对应一个独立的 bot 实例
 */
export interface ServerConfig {
  /** 机器人 ID（唯一标识） */
  selfId: string
  /** 服务器名称（需与鹊桥 config.yml 中的 server_name 一致） */
  serverName?: string

  // ---- WebSocket ----
  /** WebSocket 地址（如 ws://127.0.0.1:8080） */
  url: string
  /** 访问令牌（需与鹊桥 config.yml 中的 access_token 一致） */
  accessToken?: string
  /** 额外请求头 */
  extraHeaders?: Record<string, string>

  // ---- RCON ----
  /** 启用 RCON 远程命令执行 */
  enableRcon?: boolean
  /** RCON 主机地址 */
  rconHost?: string
  /** RCON 端口 */
  rconPort?: number
  /** RCON 密码 */
  rconPassword?: string
  /** RCON 超时时间(ms) */
  rconTimeout?: number

  // ---- ChatImage ----
  /** 启用 ChatImage CICode 图片发送（需客户端安装 ChatImage Mod） */
  enableChatImage?: boolean
  /** 图片在聊天栏中的默认显示名称 */
  chatImageDefaultName?: string
}

/** @deprecated 请使用 ServerConfig */
export type MinecraftBotConfig = ServerConfig

// ============================================================================
// 适配器配置
// ============================================================================

export interface MinecraftAdapterConfig {
  /** 服务器配置列表 */
  servers: ServerConfig[]
  /** 启用调试模式 */
  debug?: boolean
  /** 启用详细调试日志 */
  detailedLogging?: boolean
  /** 入站消息分词模式 */
  tokenizeMode?: 'split' | 'none'
  /** 重连间隔时间(ms) */
  reconnectInterval?: number
  /** 最大重连尝试次数 */
  maxReconnectAttempts?: number
  /** 是否在消息前添加默认前缀 */
  useMessagePrefix?: boolean
}

/**
 * 将嵌套格式的服务器配置扁平化。
 * 每种嵌套对象（websocket / rcon / chatImage）独立处理，
 * 确保任何混合格式（如扁平 url + 嵌套 rcon）都能正确转换。
 */
function flattenServerConfig(server: any): ServerConfig {
  const result: any = { ...server }

  // ── websocket 嵌套 → 扁平 ──
  if (result.websocket && typeof result.websocket === 'object') {
    const ws = result.websocket
    if (ws.url !== undefined) result.url = ws.url
    if (ws.accessToken !== undefined) result.accessToken = ws.accessToken
    if (ws.extraHeaders !== undefined) result.extraHeaders = ws.extraHeaders
    delete result.websocket
  }

  // ── rcon 嵌套 → 扁平 ──
  if (result.rcon && typeof result.rcon === 'object') {
    const rcon = result.rcon
    const hasRconConfig = rcon.host || rcon.port || rcon.password
    if (hasRconConfig || rcon.enabled) {
      result.enableRcon = true
    }
    // 仅在嵌套值实际存在时覆盖，避免用 undefined 覆盖已有值或阻止 Schema 默认值
    if (rcon.host !== undefined) result.rconHost = rcon.host
    if (rcon.port !== undefined) result.rconPort = rcon.port
    if (rcon.password !== undefined) result.rconPassword = rcon.password
    if (rcon.timeout !== undefined) result.rconTimeout = rcon.timeout
    delete result.rcon
  }

  // ── chatImage 嵌套 → 扁平 ──
  if (result.chatImage && typeof result.chatImage === 'object') {
    const ci = result.chatImage
    if (ci.enabled !== undefined || ci.defaultImageName) {
      result.enableChatImage = ci.enabled ?? !!ci.defaultImageName
    }
    if (ci.defaultImageName !== undefined) result.chatImageDefaultName = ci.defaultImageName
    delete result.chatImage
  }

  return result as ServerConfig
}

/**
 * 向后兼容：
 * 1. 将旧版 bots 字段迁移为 servers
 * 2. 将嵌套的 websocket/rcon/chatImage 子对象扁平化
 */
function migrateConfig(raw: any): MinecraftAdapterConfig {
  let servers: any[] | undefined

  if (raw.bots && !raw.servers) {
    logger.warn(
      '[迁移提示] 检测到旧版配置格式（使用 "bots" 字段）。' +
      '请迁移到新的 "servers" 格式，详见 README。' +
      '旧格式将在未来版本中移除。'
    )
    const globalChatImage = raw.chatImage
    servers = (raw.bots as any[]).map(bot => ({
      ...bot,
      chatImage: bot.chatImage ?? globalChatImage,
    }))
  } else {
    servers = raw.servers
  }

  if (servers) {
    servers = servers.map(flattenServerConfig)
  }

  return {
    debug: raw.debug,
    detailedLogging: raw.detailedLogging,
    tokenizeMode: raw.tokenizeMode,
    reconnectInterval: raw.reconnectInterval,
    maxReconnectAttempts: raw.maxReconnectAttempts,
    useMessagePrefix: raw.useMessagePrefix,
    servers: servers ?? [],
  }
}

// ============================================================================
// Koishi Bot 实现
// ============================================================================

export class MinecraftBot<C extends Context = Context> extends Bot<C, ServerConfig> {
  public rcon?: Rcon
  public ws?: WebSocket
  public chatImageEnabled: boolean
  public chatImageDefaultName: string

  constructor(ctx: C, config: ServerConfig) {
    super(ctx, config, 'minecraft')
    this.selfId = config.selfId
    this.platform = 'minecraft'
    this.chatImageEnabled = config.enableChatImage ?? false
    this.chatImageDefaultName = config.chatImageDefaultName ?? '图片'
  }

  async createDirectChannel(userId: string) {
    return { id: `private:${userId}`, type: 1 as const }
  }

  async executeCommand(command: string): Promise<string> {
    if (this.adapter instanceof MinecraftAdapter) {
      return await this.adapter.executeRconCommand(command, this)
    }
    if (!this.rcon) throw new Error('RCON not connected')
    return await this.rcon.send(command)
  }
}

// ============================================================================
// Koishi Adapter 实现
// ============================================================================

export class MinecraftAdapter<C extends Context = Context> extends Adapter<C, MinecraftBot<C>> {
  static reusable = true

  private rconConnections = new Map<string, Rcon>()
  private rconReconnectAttempts = new Map<string, number>()
  private rconConfigs = new Map<string, ServerConfig>()
  /** @internal 供 MessageEncoder 访问 */
  wsConnections = new Map<string, WebSocket>()
  private reconnectAttempts = new Map<string, number>()
  private pendingRequests = new Map<string, { resolve: (value: any) => void; reject: (reason: any) => void; timeout: NodeJS.Timeout }>()
  private requestCounter = 0

  /** 事件去重缓存：防止鹊桥服务端对同一事件发送多次 */
  private recentEventKeys = new Map<string, number>()

  private disposed = false
  private reconnectTimers = new Set<ReturnType<typeof setTimeout>>()

  private debug: boolean
  private detailedLogging: boolean
  private tokenizeMode: 'split' | 'none'
  private reconnectInterval: number
  private maxReconnectAttempts: number
  private useMessagePrefix: boolean

  constructor(ctx: C, rawConfig: MinecraftAdapterConfig) {
    super(ctx)
    try {
      const config = migrateConfig(rawConfig as any)

      this.debug = config.debug ?? false
      this.detailedLogging = config.detailedLogging ?? false
      this.tokenizeMode = config.tokenizeMode ?? 'split'
      this.reconnectInterval = config.reconnectInterval ?? 5000
      this.maxReconnectAttempts = config.maxReconnectAttempts ?? 10
      this.useMessagePrefix = config.useMessagePrefix ?? false

      this.startDedupCleanup()

      if (this.debug) {
        logger.info(`[DEBUG] MinecraftAdapter initialized with config:`, {
          debug: this.debug,
          reconnectInterval: this.reconnectInterval,
          maxReconnectAttempts: this.maxReconnectAttempts,
          serverCount: config.servers.length
        })
      }

      ctx.on('ready', async () => {
        if (this.debug) {
          logger.info(`[DEBUG] Koishi ready event triggered, initializing ${config.servers.length} server(s)`)
        }

        for (const serverConfig of config.servers) {
          if (this.debug) {
            logger.info(`[DEBUG] Initializing server ${serverConfig.selfId}, full config:`, JSON.stringify(serverConfig))
          }

          const bot = new MinecraftBot(ctx, serverConfig)
          bot.adapter = this
          this.bots.push(bot)

          const connectTasks: Promise<void>[] = []

          // RCON（用于执行服务器命令，与 WebSocket 并行工作）
          if (serverConfig.enableRcon) {
            this.rconConfigs.set(serverConfig.selfId, serverConfig)
            connectTasks.push(this.connectRcon(bot))
          } else {
            if (this.debug) {
              logger.info(`[DEBUG] RCON not enabled for server ${serverConfig.selfId}`)
            }
          }

          // WebSocket（用于事件接收和消息发送）
          if (serverConfig.url) {
            connectTasks.push((async () => {
              if (this.debug) {
                logger.info(`[DEBUG] Initializing WebSocket for server ${serverConfig.selfId}`)
              }
              await this.connectWebSocket(bot)
            })())
          } else {
            if (this.debug) {
              logger.info(`[DEBUG] No WebSocket URL for server ${serverConfig.selfId}`)
            }
          }

          await Promise.allSettled(connectTasks)
        }
      })
    } catch (err) {
      logger.error('MinecraftAdapter initialization failed:', err)
      throw err
    }
  }

  private static readonly DEDUP_WINDOW_MS = 2000
  private static readonly DEDUP_CLEANUP_INTERVAL_MS = 10000

  private isDuplicateEvent(payload: QueqiaoEvent): boolean {
    if (payload.post_type !== 'notice') return false

    const player = (payload as any).player
    const key = `${payload.event_name}:${player?.uuid || player?.nickname || ''}:${payload.server_name}`
    const now = Date.now()
    const lastSeen = this.recentEventKeys.get(key)

    if (lastSeen && now - lastSeen < MinecraftAdapter.DEDUP_WINDOW_MS) {
      if (this.debug) {
        logger.info(`[DEBUG] Duplicate event suppressed: ${key}`)
      }
      return true
    }

    this.recentEventKeys.set(key, now)
    return false
  }

  private startDedupCleanup() {
    const interval = setInterval(() => {
      const now = Date.now()
      for (const [key, ts] of this.recentEventKeys) {
        if (now - ts > MinecraftAdapter.DEDUP_WINDOW_MS * 2) {
          this.recentEventKeys.delete(key)
        }
      }
    }, MinecraftAdapter.DEDUP_CLEANUP_INTERVAL_MS)
    this.ctx.on('dispose', () => clearInterval(interval))
  }

  /**
   * 生成唯一的请求 ID
   */
  private generateEcho(): string {
    return `koishi_${Date.now()}_${++this.requestCounter}`
  }

  private toTextComponent(message: any, chatImageEnabled: boolean, chatImageDefaultName: string): MinecraftTextComponent[] {
    const raw = this.extractRawText(message)
    if (!raw) return [{ text: '' }]

    const segments = this.parseOutboundMessage(raw)
    if (segments.length === 0) return [{ text: '' }]

    const fullText = segments.map(seg => {
      if (seg.type === 'image') {
        if (chatImageEnabled) {
          return this.buildCICode(seg.url, seg.name, chatImageDefaultName)
        }
        return seg.url
      }
      return seg.text
    }).join('')

    return [{ text: fullText }]
  }

  private extractRawText(message: any): string {
    if (message == null) return ''
    if (typeof message === 'string') return message
    if (typeof message === 'number' || typeof message === 'boolean') return String(message)
    if (Array.isArray(message)) return message.map(item => this.extractRawText(item)).join('')
    if (typeof message === 'object') {
      if (message.attrs && typeof message.attrs.content === 'string') return message.attrs.content
      if (typeof message.content === 'string') return message.content
      if (typeof message.text === 'string') return message.text
      if (message.children) return this.extractRawText(message.children)
      try {
        if (typeof message.toString === 'function' && message.toString !== Object.prototype.toString) {
          const s = message.toString()
          if (typeof s === 'string' && s !== '[object Object]') return s
        }
      } catch (e) {
        // ignore
      }
      let acc = ''
      for (const key in message) {
        try {
          acc += this.extractRawText((message as any)[key])
        } catch (e) {
          // ignore
        }
      }
      return acc
    }
    return String(message)
  }

  /**
   * 生成 ChatImage CICode: [[CICode,url=<url>,name=<name>]]
   */
  private buildCICode(url: string, name?: string, defaultName: string = '图片'): string {
    const displayName = name || defaultName
    return `[[CICode,url=${url},name=${displayName}]]`
  }

  /**
   * 解析出站消息中的 Koishi 元素标签 (<img src="..."/>, <image url="..."/>)
   */
  private parseOutboundMessage(content: string): Array<{ type: 'text'; text: string } | { type: 'image'; url: string; name?: string }> {
    const segments: Array<{ type: 'text'; text: string } | { type: 'image'; url: string; name?: string }> = []
    const imgTagRegex = /<(?:img|image)\s+([^>]*?)\/?>(?:<\/(?:img|image)>)?/gi
    let lastIndex = 0
    let match: RegExpExecArray | null

    while ((match = imgTagRegex.exec(content)) !== null) {
      if (match.index > lastIndex) {
        segments.push({ type: 'text', text: content.slice(lastIndex, match.index) })
      }

      const attrs = match[1]
      const rawUrl = this.extractAttr(attrs, 'src') || this.extractAttr(attrs, 'url')
      if (rawUrl) {
        const url = this.decodeHtmlEntities(rawUrl)
        const name = this.extractAttr(attrs, 'alt') || this.extractAttr(attrs, 'name') || this.extractAttr(attrs, 'summary')
        segments.push({ type: 'image', url, name: name || undefined })
      }

      lastIndex = match.index + match[0].length
    }

    if (lastIndex < content.length) {
      segments.push({ type: 'text', text: content.slice(lastIndex) })
    }

    return segments
  }

  // 从 HTML 属性字符串中提取指定属性值: name="val" | name='val' | name=val
  private extractAttr(attrs: string, name: string): string | null {
    const regex = new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|(\\S+))`, 'i')
    const match = regex.exec(attrs)
    if (!match) return null
    return match[1] ?? match[2] ?? match[3] ?? null
  }

  private decodeHtmlEntities(str: string): string {
    return str
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
      .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)))
  }

  /**
   * 发送 WebSocket API 请求并等待响应
   * @internal 供 MessageEncoder 访问
   */
  async sendApiRequest<T = any>(
    ws: WebSocket,
    api: string,
    data: any,
    timeout: number = 10000
  ): Promise<QueqiaoApiResponse<T>> {
    return new Promise((resolve, reject) => {
      const echo = this.generateEcho()
      const request: QueqiaoApiRequest = { api, data, echo }

      const timeoutId = setTimeout(() => {
        this.pendingRequests.delete(echo)
        reject(new Error(`API request timeout: ${api}`))
      }, timeout)

      this.pendingRequests.set(echo, { resolve, reject, timeout: timeoutId })

      if (this.debug) {
        logger.info(`[DEBUG] Sending API request:`, request)
      }

      ws.send(JSON.stringify(request))
    })
  }

  /**
   * 处理 API 响应
   */
  private handleApiResponse(response: QueqiaoApiResponse) {
    if (response.echo && this.pendingRequests.has(String(response.echo))) {
      const pending = this.pendingRequests.get(String(response.echo))!
      clearTimeout(pending.timeout)
      this.pendingRequests.delete(String(response.echo))

      if (response.status === 'SUCCESS') {
        pending.resolve(response)
      } else {
        pending.reject(new Error(response.message || 'API request failed'))
      }
    }
  }

  private getWebSocketCloseCode(code: number): string {
    const codes: Record<number, string> = {
      1000: 'Normal Closure',
      1001: 'Going Away',
      1002: 'Protocol Error',
      1003: 'Unsupported Data',
      1004: 'Reserved',
      1005: 'No Status Received',
      1006: 'Abnormal Closure',
      1007: 'Invalid Frame Payload Data',
      1008: 'Policy Violation',
      1009: 'Message Too Big',
      1010: 'Missing Extension',
      1011: 'Internal Error',
      1012: 'Service Restart',
      1013: 'Try Again Later',
      1014: 'Bad Gateway',
      1015: 'TLS Handshake'
    }
    return codes[code] || `Unknown Code ${code}`
  }

  private getWebSocketStateString(state: number): string {
    const states = {
      0: 'CONNECTING',
      1: 'OPEN',
      2: 'CLOSING',
      3: 'CLOSED'
    }
    return states[state as keyof typeof states] || `UNKNOWN(${state})`
  }

  private async connectRcon(bot: MinecraftBot<C>): Promise<void> {
    // 优先使用 rconConfigs（经 migrateConfig 扁平化后的可靠配置），回退到 bot.config
    const config = this.rconConfigs.get(bot.selfId) ?? bot.config
    const selfId = bot.selfId
    // rconHost 未配置时，从 WebSocket URL 中提取主机地址作为回退
    let rconHost = config.rconHost
    if (!rconHost && config.url) {
      try {
        rconHost = new URL(config.url).hostname
      } catch {}
    }
    rconHost = rconHost || '127.0.0.1'
    const rconPort = config.rconPort ?? 25575
    const rconTimeout = config.rconTimeout ?? 5000
    if (this.debug) {
      logger.info(`[DEBUG] RCON config for server ${selfId}:`, {
        rconHost: config.rconHost,
        rconPort: config.rconPort,
        rconPassword: config.rconPassword ? '***' : undefined,
        rconTimeout: config.rconTimeout,
        enableRcon: config.enableRcon,
        resolved: `${rconHost}:${rconPort}`,
      })
    }

    try {
      const rconPassword = String(config.rconPassword ?? '')
      const rcon = await this.createRconWithTimeout(rconHost, rconPort, rconPassword, rconTimeout)
      this.rconConnections.set(selfId, rcon)
      bot.rcon = rcon
      this.rconReconnectAttempts.set(selfId, 0)
      logger.info(`RCON connected for server ${selfId} — ready for command execution`)

      rcon.on('end', () => {
        logger.warn(`RCON connection lost for server ${selfId}`)
        this.rconConnections.delete(selfId)
        bot.rcon = undefined
        this.scheduleRconReconnect(bot)
      })

      rcon.on('error', (error: Error) => {
        logger.warn(`RCON error for server ${selfId}:`, error.message)
      })
    } catch (error) {
      logger.warn(`Failed to connect RCON for server ${selfId}:`, error)
      if (this.debug) {
        logger.info(`[DEBUG] RCON connection error details:`, (error as Error).message, (error as Error).stack)
      }
      this.scheduleRconReconnect(bot)
    }
  }

  private createRconWithTimeout(host: string, port: number, password: string, timeout: number): Promise<Rcon> {
    const debug = this.debug
    return new Promise<Rcon>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`RCON TCP connection timeout after ${timeout}ms to ${host}:${port}`))
      }, timeout)

      Rcon.connect({ host, port, password, timeout, debug }).then(
        (rcon) => { clearTimeout(timer); resolve(rcon) },
        (err) => { clearTimeout(timer); reject(err) },
      )
    })
  }

  private scheduleRconReconnect(bot: MinecraftBot<C>) {
    const selfId = bot.selfId
    if (!this.rconConfigs.has(selfId)) return
    if (this.disposed) return

    const attempts = this.rconReconnectAttempts.get(selfId) || 0
    if (attempts >= this.maxReconnectAttempts) {
      logger.error(`RCON max reconnect attempts (${this.maxReconnectAttempts}) reached for server ${selfId}`)
      return
    }

    this.rconReconnectAttempts.set(selfId, attempts + 1)
    const delay = this.reconnectInterval * Math.pow(2, Math.min(attempts, 5))

    if (this.debug) {
      logger.info(`[DEBUG] RCON reconnect for server ${selfId} in ${delay}ms (attempt ${attempts + 1}/${this.maxReconnectAttempts})`)
    }

    const timer = setTimeout(() => {
      this.reconnectTimers.delete(timer)
      if (this.disposed) return
      if (!this.rconConfigs.has(selfId)) return
      if (this.rconConnections.has(selfId)) return
      this.connectRcon(bot)
    }, delay)
    this.reconnectTimers.add(timer)
  }

  private async connectWebSocket(bot: MinecraftBot<C>) {
    const config = bot.config
    const headers: Record<string, string> = {
      'x-self-name': config.serverName || bot.selfId,
      ...(config.extraHeaders || {}),
    }
    if (config.accessToken) {
      headers['Authorization'] = `Bearer ${config.accessToken}`
    }

    if (this.debug) {
      logger.info(`[DEBUG] Connecting to WebSocket: ${config.url}`)
      logger.info(`[DEBUG] Headers:`, headers)
    }

    const ws = new WebSocket(config.url, { headers })
    this.wsConnections.set(bot.selfId, ws)
    bot.ws = ws

    // 添加连接超时处理
    const connectionTimeout = setTimeout(() => {
      if (ws.readyState === WebSocket.CONNECTING) {
        if (this.debug) {
          logger.info(`[DEBUG] WebSocket connection timeout for bot ${bot.selfId}`)
        }
        ws.close()
      }
    }, 10000) // 10秒超时

    ws.on('open', () => {
      logger.info(`WebSocket connected for bot ${bot.selfId}`)
      if (this.debug) {
        logger.info(`[DEBUG] WebSocket opened successfully for bot ${bot.selfId}`)
        logger.info(`[DEBUG] WebSocket protocol: ${ws.protocol}`)
        logger.info(`[DEBUG] WebSocket extensions: ${ws.extensions}`)
      }
      // 重置重连尝试次数
      this.reconnectAttempts.set(bot.selfId, 0)
      bot.online()
      clearTimeout(connectionTimeout)
    })

    ws.on('message', (data: WebSocket.RawData) => {
      try {
        const text = data.toString('utf8')
        if (this.debug) {
          logger.info(`[DEBUG] Received WebSocket message for bot ${bot.selfId}:`, text)
          logger.info(`[DEBUG] Message length: ${text.length} characters`)
        }

        const obj = JSON.parse(text)

        // 检查是否是 API 响应
        if (obj.post_type === 'response') {
          this.handleApiResponse(obj as QueqiaoApiResponse)
          return
        }

        // 处理事件
        const event = obj as QueqiaoEvent

        if (this.isDuplicateEvent(event)) return

        const session = this.createSession(bot, event)
        if (session) {
          if (this.debug) {
            logger.info(`[DEBUG] Created session for event: ${event.event_name}`)
          }

          if (this.detailedLogging) {
            try {
              const snapshot = {
                sessionId: (session as any).id,
                content: session.content,
                elements: session.event?.message?.elements,
                eventMessage: session.event?.message,
                user: session.event?.user,
                userId: (session as any).userId || session.event?.user?.id,
                guildId: (session as any).guildId || session.event?.guild?.id,
                channelId: (session as any).channelId || session.event?.channel?.id,
              }
              logger.info(`[DETAILED] Pre-dispatch session snapshot for bot ${bot.selfId}:`, snapshot)
            } catch (e) {
              logger.warn(`[DETAILED] Failed to capture pre-dispatch session snapshot:`, e)
            }
          }

          try {
            bot.dispatch(session)
            if (this.debug) logger.info(`[DEBUG] Session dispatched successfully to bot ${bot.selfId}`)
          } catch (err) {
            logger.warn(`Dispatch threw an error for bot ${bot.selfId}:`, err)
            if (this.debug) {
              logger.info(`[DEBUG] Dispatch error stack:`, (err as Error)?.stack || err)
            }
          }
        } else {
          if (this.debug) {
            logger.info(`[DEBUG] No session created for event: ${event.event_name}`)
          }
        }
      } catch (error) {
        logger.warn('Failed to process WebSocket message:', error)
        if (this.debug) {
          logger.info(`[DEBUG] Raw message data:`, data.toString('utf8'))
          logger.info(`[DEBUG] Parse error:`, (error as Error).message, (error as Error).stack)
        }
      }
    })

    ws.on('close', (code, reason) => {
      logger.warn(`WebSocket disconnected for bot ${bot.selfId} (code: ${code}, reason: ${reason.toString()})`)
      if (this.debug) {
        logger.info(`[DEBUG] Close code details:`, this.getWebSocketCloseCode(code))
        logger.info(`[DEBUG] Close reason:`, reason.toString())
      }
      bot.offline()

      if (this.disposed) return

      const attempts = this.reconnectAttempts.get(bot.selfId) || 0
      if (attempts < this.maxReconnectAttempts) {
        this.reconnectAttempts.set(bot.selfId, attempts + 1)
        const delay = this.reconnectInterval * Math.pow(2, attempts)
        if (this.debug) {
          logger.info(`[DEBUG] Attempting to reconnect WebSocket for bot ${bot.selfId} in ${delay}ms (attempt ${attempts + 1}/${this.maxReconnectAttempts})`)
        }
        const timer = setTimeout(() => {
          this.reconnectTimers.delete(timer)
          if (this.disposed) return
          if (this.wsConnections.get(bot.selfId)?.readyState !== WebSocket.OPEN) {
            this.connectWebSocket(bot)
          }
        }, delay)
        this.reconnectTimers.add(timer)
      } else {
        logger.error(`Max reconnect attempts reached for bot ${bot.selfId}`)
      }
    })

    ws.on('error', (error) => {
      logger.warn(`WebSocket error for bot ${bot.selfId}:`, error)
      if (this.debug) {
        logger.info(`[DEBUG] WebSocket error details:`, (error as Error).message, (error as Error).stack)
      }
    })
  }

  private sessionCounter = 0

  /**
   * 根据鹊桥 V2 事件创建 Koishi Session
   */
  private createSession(bot: MinecraftBot<C>, payload: QueqiaoEvent): Session | undefined {
    if (this.debug) {
      logger.info(`[DEBUG] Creating session for event: ${payload.event_name}, payload:`, payload)
    }

    const event: any = {
      sn: ++this.sessionCounter,
      login: {
        sn: bot.sn,
        adapter: bot.adapterName,
        user: bot.user || { id: bot.selfId, name: bot.selfId },
        platform: 'minecraft',
        selfId: bot.selfId,
        status: bot.status,
        features: bot.features,
      },
      selfId: bot.selfId,
      platform: 'minecraft',
      timestamp: payload.timestamp * 1000,
      referrer: payload,
    }

    switch (payload.event_name) {
      // 玩家聊天事件
      case 'PlayerChatEvent': {
        const chatEvent = payload as PlayerChatEvent
        const player = chatEvent.player
        const userId = player.uuid || player.nickname
        const username = player.nickname

        event.type = 'message'
        event.user = {
          id: userId,
          name: username,
          nick: username,
          isOp: player.is_op,
        }
        event.channel = {
          id: chatEvent.server_name || 'minecraft',
          type: 0, // TEXT
        }
        event.guild = {
          id: chatEvent.server_name || 'minecraft',
          name: chatEvent.server_name || 'Minecraft Server',
        }

        // 解析消息
        const messageText = chatEvent.message || ''
        const elements = this.parseMessageToElements(messageText)

        event.message = {
          id: chatEvent.message_id || Date.now().toString(),
          content: messageText,
          timestamp: payload.timestamp * 1000,
          user: event.user,
          elements,
          createdAt: payload.timestamp * 1000,
          updatedAt: payload.timestamp * 1000,
        }
        break
      }

      // 玩家命令事件
      case 'PlayerCommandEvent': {
        const cmdEvent = payload as PlayerCommandEvent
        const player = cmdEvent.player
        const userId = player.uuid || player.nickname
        const username = player.nickname

        event.type = 'message'
        event.user = {
          id: userId,
          name: username,
          nick: username,
          isOp: player.is_op,
        }
        event.channel = {
          id: cmdEvent.server_name || 'minecraft',
          type: 0,
        }
        event.guild = {
          id: cmdEvent.server_name || 'minecraft',
          name: cmdEvent.server_name || 'Minecraft Server',
        }

        // 命令消息
        const commandText = cmdEvent.command || ''
        const elements = this.parseMessageToElements(commandText)

        event.message = {
          id: cmdEvent.message_id || Date.now().toString(),
          content: commandText,
          timestamp: payload.timestamp * 1000,
          user: event.user,
          elements,
          createdAt: payload.timestamp * 1000,
          updatedAt: payload.timestamp * 1000,
        }
        // 标记为命令事件
        event.subtype = 'command'
        break
      }

      // 玩家加入事件
      case 'PlayerJoinEvent': {
        const joinEvent = payload as PlayerJoinEvent
        const player = joinEvent.player
        const userId = player.uuid || player.nickname

        event.type = 'guild-member-added'
        event.user = {
          id: userId,
          name: player.nickname,
          nick: player.nickname,
          isOp: player.is_op,
        }
        event.guild = {
          id: joinEvent.server_name || 'minecraft',
          name: joinEvent.server_name || 'Minecraft Server',
        }
        event.member = {
          user: event.user,
          nick: player.nickname,
          joinedAt: payload.timestamp * 1000,
        }
        break
      }

      // 玩家离开事件
      case 'PlayerQuitEvent': {
        const quitEvent = payload as PlayerQuitEvent
        const player = quitEvent.player
        const userId = player.uuid || player.nickname

        event.type = 'guild-member-removed'
        event.user = {
          id: userId,
          name: player.nickname,
          nick: player.nickname,
          isOp: player.is_op,
        }
        event.guild = {
          id: quitEvent.server_name || 'minecraft',
          name: quitEvent.server_name || 'Minecraft Server',
        }
        event.member = {
          user: event.user,
          nick: player.nickname,
        }
        break
      }

      // 玩家死亡事件
      case 'PlayerDeathEvent': {
        const deathEvent = payload as PlayerDeathEvent
        const player = deathEvent.player
        const userId = player.uuid || player.nickname

        event.type = 'notice'
        event.subtype = 'player-death'
        event.user = {
          id: userId,
          name: player.nickname,
          nick: player.nickname,
          isOp: player.is_op,
        }
        event.guild = {
          id: deathEvent.server_name || 'minecraft',
          name: deathEvent.server_name || 'Minecraft Server',
        }
        // 从 death 对象提取死亡消息
        const deathText = deathEvent.death?.text || ''
        if (deathText) {
          event.message = {
            id: Date.now().toString(),
            content: deathText,
            timestamp: payload.timestamp * 1000,
          }
        }
        break
      }

      // 玩家成就事件
      case 'PlayerAchievementEvent': {
        const achieveEvent = payload as PlayerAchievementEvent
        const player = achieveEvent.player
        const userId = player.uuid || player.nickname

        event.type = 'notice'
        event.subtype = 'player-achievement'
        event.user = {
          id: userId,
          name: player.nickname,
          nick: player.nickname,
          isOp: player.is_op,
        }
        event.guild = {
          id: achieveEvent.server_name || 'minecraft',
          name: achieveEvent.server_name || 'Minecraft Server',
        }
        // 从 achievement 对象提取成就信息
        const achievementText = achieveEvent.achievement?.display?.title
          || achieveEvent.achievement?.text
          || ''
        if (achievementText) {
          event.message = {
            id: Date.now().toString(),
            content: achievementText,
            timestamp: payload.timestamp * 1000,
          }
        }
        break
      }

      default:
        if (this.debug) {
          logger.info(`[DEBUG] Unhandled event type: ${(payload as any).event_name}`)
        }
        return undefined
    }

    // 添加兼容性字段
    try {
      const channelId = event.channel?.id || event.guild?.id || 'minecraft'
      const roomId = `minecraft:${channelId}`
      event.room = { id: roomId }
      event.context = event.context || {}
      event.context.options = { ...(event.context.options || {}), room: roomId }
      if (event.channel) event.channel.altId = roomId
    } catch (e) {
      if (this.debug) logger.warn('[DEBUG] Failed to add compatibility fields:', e)
    }

    return bot.session(event)
  }

  /**
   * 解析消息文本为 Koishi 元素数组
   * 入站方向始终解析 CICode 和裸图片 URL（不受 chatImage.enabled 控制）
   */
  private parseMessageToElements(messageText: string): any[] {
    if (!messageText) return []

    const elements: any[] = []
    // CICode: [[CICode,url=<url>(,name=<name>)(,nsfw=<bool>)(,pre=<p>)(,suf=<s>)]]
    // 裸图片 URL: https?://....(png|jpg|jpeg|gif|bmp|ico|jfif|webp)
    const ciCodePattern = /\[\[CICode,([^\]]*)\]\]/g
    const imageUrlPattern = /https?:\/\/\S+\.(?:png|jpe?g|gif|bmp|ico|jfif|webp)(?:\?[^\s]*)?/gi
    const combinedPattern = new RegExp(
      `(${ciCodePattern.source})|(${imageUrlPattern.source})`,
      'gi'
    )

    let lastIndex = 0
    let match: RegExpExecArray | null

    while ((match = combinedPattern.exec(messageText)) !== null) {
      if (match.index > lastIndex) {
        const textBefore = messageText.slice(lastIndex, match.index)
        this.addTextElements(elements, textBefore)
      }

      if (match[1]) {
        const params = match[2]
        const url = this.extractCICodeParam(params, 'url')
        if (url) {
          const el: any = { type: 'img', attrs: { src: url } }
          const name = this.extractCICodeParam(params, 'name')
          if (name) el.attrs.alt = name
          el.toString = function () { return `[${this.attrs.alt || '图片'}]` }
          elements.push(el)
        }
      } else {
        const url = match[0]
        const el: any = { type: 'img', attrs: { src: url } }
        el.toString = function () { return `[图片]` }
        elements.push(el)
      }

      lastIndex = match.index + match[0].length
    }

    if (lastIndex < messageText.length) {
      const textAfter = messageText.slice(lastIndex)
      this.addTextElements(elements, textAfter)
    }

    if (elements.length === 0) {
      this.addTextElements(elements, messageText)
    }

    return elements
  }

  // 提取 CICode 参数: "url=xxx,name=yyy" => { url: "xxx", name: "yyy" }
  private extractCICodeParam(params: string, key: string): string | null {
    const regex = new RegExp(`(?:^|,)${key}=([^,]*)`, 'i')
    const match = regex.exec(params)
    return match ? match[1] : null
  }

  private addTextElements(elements: any[], text: string): void {
    const tokens: string[] =
      this.tokenizeMode === 'none'
        ? [text]
        : text.split(/(\s+)/).filter((s: string) => s.length > 0)

    for (const token of tokens) {
      const el: any = { type: 'text', attrs: { content: token } }
      el.toString = function () { return this.attrs?.content ?? '' }
      elements.push(el)
    }
  }

  /**
   * 发送私聊消息 (send_private_msg)
   */
  async sendPrivateMessage(player: string, message: string, bot?: MinecraftBot<C>): Promise<void> {
    if (this.debug) {
      logger.info(`[DEBUG] Sending private message to player ${player}: ${message}`)
    }

    if (bot) {
      const ws = this.wsConnections.get(bot.selfId)
      if (ws?.readyState === WebSocket.OPEN) {
        const messageComponent = this.toTextComponent(message, bot.chatImageEnabled, bot.chatImageDefaultName)
        const response = await this.sendApiRequest(ws, 'send_private_msg', {
          nickname: player,
          message: messageComponent
        })
        if (this.debug) {
          logger.info(`[DEBUG] Private message sent successfully via server ${bot.selfId}:`, response)
        }
        return
      }
      throw new Error(`No active WebSocket connection for server ${bot.selfId}`)
    }

    for (const [botId, ws] of this.wsConnections) {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          const targetBot = this.bots.find(b => b.selfId === botId)
          const messageComponent = this.toTextComponent(
            message,
            targetBot?.chatImageEnabled ?? false,
            targetBot?.chatImageDefaultName ?? '图片'
          )
          const response = await this.sendApiRequest(ws, 'send_private_msg', {
            nickname: player,
            message: messageComponent
          })
          if (this.debug) {
            logger.info(`[DEBUG] Private message sent successfully via server ${botId}:`, response)
          }
          return
        } catch (error) {
          logger.warn(`Failed to send private message via WebSocket for server ${botId}:`, error)
        }
      }
    }

    throw new Error('No available WebSocket connection to send private message')
  }

  async broadcast(message: string, bot?: MinecraftBot<C>): Promise<void> {
    if (this.debug) {
      logger.info(`[DEBUG] Broadcasting message: ${message}`)
    }

    if (bot) {
      const ws = this.wsConnections.get(bot.selfId)
      if (ws?.readyState === WebSocket.OPEN) {
        const messageComponent = this.toTextComponent(message, bot.chatImageEnabled, bot.chatImageDefaultName)
        const response = await this.sendApiRequest(ws, 'broadcast', {
          message: messageComponent
        })
        if (this.debug) {
          logger.info(`[DEBUG] Broadcast sent successfully via server ${bot.selfId}:`, response)
        }
        return
      }
      throw new Error(`No active WebSocket connection for server ${bot.selfId}`)
    }

    for (const [botId, ws] of this.wsConnections) {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          const targetBot = this.bots.find(b => b.selfId === botId)
          const messageComponent = this.toTextComponent(
            message,
            targetBot?.chatImageEnabled ?? false,
            targetBot?.chatImageDefaultName ?? '图片'
          )
          const response = await this.sendApiRequest(ws, 'broadcast', {
            message: messageComponent
          })
          if (this.debug) {
            logger.info(`[DEBUG] Broadcast sent successfully via server ${botId}:`, response)
          }
          return
        } catch (error) {
          logger.warn(`Failed to broadcast via WebSocket for server ${botId}:`, error)
        }
      }
    }

    throw new Error('No available WebSocket connection to broadcast message')
  }

  async executeRconCommand(command: string, bot?: MinecraftBot<C>): Promise<string> {
    if (this.debug) {
      logger.info(`[DEBUG] Executing RCON command: ${command}`)
    }

    if (bot) {
      const rcon = this.rconConnections.get(bot.selfId)
      if (rcon) {
        if (this.debug) {
          logger.info(`[DEBUG] Executing via RCON for server ${bot.selfId}: ${command}`)
        }
        return await rcon.send(command)
      }
      throw new Error(`RCON not available for server ${bot.selfId}: no active RCON connection`)
    }

    for (const [botId, rcon] of this.rconConnections) {
      try {
        if (this.debug) {
          logger.info(`[DEBUG] Executing via RCON for server ${botId}: ${command}`)
        }
        return await rcon.send(command)
      } catch (error) {
        logger.warn(`Failed to execute RCON command for server ${botId}:`, error)
      }
    }

    throw new Error('RCON not available: no active RCON connection to execute command')
  }

  async sendTitle(
    title: string | MinecraftTextComponent,
    subtitle?: string | MinecraftTextComponent,
    player?: string,
    bot?: MinecraftBot<C>
  ): Promise<void> {
    const titleComponent = typeof title === 'string' ? { text: title } : title
    const subtitleComponent = subtitle ? (typeof subtitle === 'string' ? { text: subtitle } : subtitle) : undefined

    if (bot) {
      const ws = this.wsConnections.get(bot.selfId)
      if (ws?.readyState === WebSocket.OPEN) {
        const data: any = { title: titleComponent }
        if (subtitleComponent) data.subtitle = subtitleComponent
        if (player) data.nickname = player
        await this.sendApiRequest(ws, 'send_title', data)
        return
      }
      throw new Error(`No active WebSocket connection for server ${bot.selfId}`)
    }

    for (const [botId, ws] of this.wsConnections) {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          const data: any = { title: titleComponent }
          if (subtitleComponent) data.subtitle = subtitleComponent
          if (player) data.nickname = player
          await this.sendApiRequest(ws, 'send_title', data)
          return
        } catch (error) {
          logger.warn(`Failed to send title via WebSocket for server ${botId}:`, error)
        }
      }
    }

    throw new Error('No available connection to send title')
  }

  async sendActionBar(
    message: string | MinecraftTextComponent,
    player?: string,
    bot?: MinecraftBot<C>
  ): Promise<void> {
    const messageComponent = typeof message === 'string' ? { text: message } : message

    if (bot) {
      const ws = this.wsConnections.get(bot.selfId)
      if (ws?.readyState === WebSocket.OPEN) {
        const data: any = { message: messageComponent }
        if (player) data.nickname = player
        await this.sendApiRequest(ws, 'send_actionbar', data)
        return
      }
      throw new Error(`No active WebSocket connection for server ${bot.selfId}`)
    }

    for (const [botId, ws] of this.wsConnections) {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          const data: any = { message: messageComponent }
          if (player) data.nickname = player
          await this.sendApiRequest(ws, 'send_actionbar', data)
          return
        } catch (error) {
          logger.warn(`Failed to send action bar via WebSocket for server ${botId}:`, error)
        }
      }
    }

    throw new Error('No available connection to send action bar')
  }

  async stop() {
    if (this.debug) {
      logger.info(`[DEBUG] Stopping MinecraftAdapter`)
    }

    this.disposed = true

    for (const timer of this.reconnectTimers) {
      clearTimeout(timer)
    }
    this.reconnectTimers.clear()

    for (const [echo, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout)
      pending.reject(new Error('Adapter stopped'))
    }
    this.pendingRequests.clear()

    for (const [botId, ws] of this.wsConnections) {
      try {
        ws.close()
      } catch (error) {
        logger.warn(`Failed to close WebSocket for server ${botId}:`, error)
      }
    }
    this.wsConnections.clear()

    this.rconConfigs.clear()
    for (const [botId, rcon] of this.rconConnections) {
      try {
        rcon.end()
      } catch (error) {
        logger.warn(`Failed to close RCON for server ${botId}:`, error)
      }
    }
    this.rconConnections.clear()
  }
}

// ============================================================================
// MessageEncoder 实现 — 让 Koishi 框架正确管理消息生命周期
// ============================================================================

class MinecraftMessageEncoder<C extends Context = Context> extends MessageEncoder<C, MinecraftBot<C>> {
  private buffer = ''

  async flush(): Promise<void> {
    if (!this.buffer) return

    const text = this.buffer
    this.buffer = ''

    const adapter = this.bot.adapter as MinecraftAdapter<C>
    const ws = adapter.wsConnections.get(this.bot.selfId)
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error(`No active WebSocket connection for server ${this.bot.selfId}`)
    }

    const messageComponent: MinecraftTextComponent[] = [{ text }]

    const isPrivate = this.channelId.startsWith('private:')
    if (isPrivate) {
      const player = this.channelId.slice(8)
      const response = await adapter.sendApiRequest(ws, 'send_private_msg', {
        nickname: player,
        message: messageComponent,
      })
      const msgId = String(response.echo ?? Date.now())
      this.results.push({ id: msgId, content: text })
    } else {
      const response = await adapter.sendApiRequest(ws, 'broadcast', {
        message: messageComponent,
      })
      const msgId = String(response.echo ?? Date.now())
      this.results.push({ id: msgId, content: text })
    }
  }

  async visit(element: h): Promise<void> {
    const { type, attrs, children } = element
    switch (type) {
      case 'text':
        this.buffer += attrs.content ?? ''
        break
      case 'at':
        if (attrs.name) {
          this.buffer += `@${attrs.name}`
        } else if (attrs.id) {
          this.buffer += `@${attrs.id}`
        }
        break
      case 'br':
        this.buffer += '\n'
        break
      case 'p':
        if (this.buffer && !this.buffer.endsWith('\n')) this.buffer += '\n'
        await this.render(children)
        if (!this.buffer.endsWith('\n')) this.buffer += '\n'
        break
      case 'img':
      case 'image':
      case 'audio':
      case 'video':
      case 'file': {
        const url = attrs.src ?? attrs.url ?? ''
        if (url) {
          if (this.bot.chatImageEnabled && (type === 'img' || type === 'image')) {
            const name = attrs.alt ?? attrs.name ?? attrs.summary ?? this.bot.chatImageDefaultName
            this.buffer += `[[CICode,url=${url},name=${name}]]`
          } else {
            this.buffer += url
          }
        }
        break
      }
      case 'message':
        await this.flush()
        await this.render(children)
        await this.flush()
        break
      default:
        await this.render(children)
        break
    }
  }
}

MinecraftBot.MessageEncoder = MinecraftMessageEncoder as any

// ============================================================================
// Koishi Schema 配置
// ============================================================================

const serverSchema = Schema.object({
  selfId: Schema.string().description('机器人 ID（唯一标识）').required(),
  serverName: Schema.string().description('服务器名称（需与鹊桥 config.yml 中的 server_name 一致）'),
  url: Schema.string().description('WebSocket 地址（如 ws://127.0.0.1:8080）'),
  accessToken: Schema.string().description('访问令牌（需与鹊桥 config.yml 中的 access_token 一致）'),
  extraHeaders: Schema.dict(Schema.string()).description('额外请求头'),
  enableRcon: Schema.boolean().description('启用 RCON 远程命令执行').default(false),
  rconHost: Schema.string().description('RCON 主机地址（留空则自动取 WebSocket 地址中的主机）'),
  rconPort: Schema.number().description('RCON 端口').default(25575),
  rconPassword: Schema.string().description('RCON 密码（留空表示无密码）'),
  rconTimeout: Schema.number().description('RCON 超时时间(ms)').default(5000),
  enableChatImage: Schema.boolean().description('启用 ChatImage CICode 图片发送（需客户端安装 ChatImage Mod）').default(false),
  chatImageDefaultName: Schema.string().description('图片在聊天栏中的默认显示名称').default('图片'),
  // 接受嵌套配置格式（README 文档中推荐的格式），由 flattenServerConfig 扁平化
  websocket: Schema.any().hidden(),
  rcon: Schema.any().hidden(),
  chatImage: Schema.any().hidden(),
})

export namespace MinecraftAdapter {
  export const Config = Schema.object({
    debug: Schema.boolean().description('启用调试模式，输出详细日志').default(false),
    detailedLogging: Schema.boolean().description('启用详细调试日志（记录入站解析和 dispatch 快照）').default(false),
    tokenizeMode: Schema.union([
      Schema.const('split').description('按空白分词（默认）'),
      Schema.const('none').description('不分词，保留原文')
    ]).description('入站消息的分词模式').default('split'),
    reconnectInterval: Schema.number().description('重连间隔时间(ms)').default(5000),
    maxReconnectAttempts: Schema.number().description('最大重连尝试次数').default(10),
    useMessagePrefix: Schema.boolean().description('是否在消息前添加默认前缀（由服务端配置）').default(false),
    servers: Schema.array(serverSchema).description('服务器配置列表（每个服务器对应一个独立的 bot 实例）').default([]),
  }) as Schema<MinecraftAdapterConfig>
}

export default MinecraftAdapter
