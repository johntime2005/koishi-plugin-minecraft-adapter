import { Adapter, Bot, Context, Logger, Schema, Session } from 'koishi'
import { Rcon } from 'rcon-client'
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
 * ChatImage 集成配置
 */
export interface ChatImageConfig {
  /** 是否启用 ChatImage CICode 生成（出站方向），默认关闭 */
  enabled?: boolean
  /** 图片在聊天栏中的默认显示名称 */
  defaultImageName?: string
}

/**
 * 单个服务器的配置
 * 每个服务器对应一个独立的 bot 实例
 */
export interface ServerConfig {
  /** 机器人 ID（唯一标识） */
  selfId: string
  /** 服务器名称（需与鹊桥 config.yml 中的 server_name 一致） */
  serverName?: string
  /** WebSocket 配置（用于事件接收和消息发送） */
  websocket: {
    /** WebSocket 地址（如 ws://127.0.0.1:8080） */
    url: string
    /** 访问令牌（需与鹊桥 config.yml 中的 access_token 一致） */
    accessToken?: string
    /** 额外请求头 */
    extraHeaders?: Record<string, string>
  }
  /** RCON 配置（用于执行服务器命令，与 WebSocket 并行工作） */
  rcon?: {
    host: string
    port: number
    password: string
    timeout?: number
  }
  /** ChatImage 图片显示配置（仅对此服务器生效） */
  chatImage?: ChatImageConfig
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
 * 向后兼容：将旧版配置（bots + 全局 chatImage）迁移为新格式（servers + 每服务器 chatImage）
 */
function migrateConfig(raw: any): MinecraftAdapterConfig {
  if (raw.bots && !raw.servers) {
    logger.warn(
      '[迁移提示] 检测到旧版配置格式（使用 "bots" 字段）。' +
      '请迁移到新的 "servers" 格式，详见 README。' +
      '旧格式将在未来版本中移除。'
    )
    const globalChatImage = raw.chatImage
    const servers: ServerConfig[] = (raw.bots as any[]).map(bot => ({
      ...bot,
      chatImage: bot.chatImage ?? globalChatImage,
    }))
    return {
      debug: raw.debug,
      detailedLogging: raw.detailedLogging,
      tokenizeMode: raw.tokenizeMode,
      reconnectInterval: raw.reconnectInterval,
      maxReconnectAttempts: raw.maxReconnectAttempts,
      useMessagePrefix: raw.useMessagePrefix,
      servers,
    }
  }
  return raw as MinecraftAdapterConfig
}

// ============================================================================
// Koishi Bot 实现
// ============================================================================

export class MinecraftBot<C extends Context = Context> extends Bot<C, ServerConfig> {
  public rcon?: Rcon
  public ws?: WebSocket
  /** 此服务器是否启用 ChatImage CICode */
  public chatImageEnabled: boolean
  /** 此服务器的 ChatImage 默认图片名称 */
  public chatImageDefaultName: string

  constructor(ctx: C, config: ServerConfig) {
    super(ctx, config, 'minecraft')
    this.selfId = config.selfId
    this.platform = 'minecraft'
    this.chatImageEnabled = config.chatImage?.enabled ?? false
    this.chatImageDefaultName = config.chatImage?.defaultImageName ?? '图片'
  }

  /**
   * 发送消息到频道或私聊
   */
  async sendMessage(channelId: string, content: string): Promise<string[]> {
    if (channelId.startsWith('private:')) {
      const player = channelId.slice(8)
      return await this.sendPrivateMessage(player, content)
    } else {
      if (this.adapter instanceof MinecraftAdapter) {
        await this.adapter.broadcast(content, this)
        return []
      }
      return []
    }
  }

  /**
   * 发送私聊消息
   */
  async sendPrivateMessage(userId: string, content: string): Promise<string[]> {
    if (this.adapter instanceof MinecraftAdapter) {
      await this.adapter.sendPrivateMessage(userId, content, this)
      return []
    }
    return []
  }

  /**
   * 执行 RCON 命令（用于执行服务器命令，与 WebSocket 并行工作）
   */
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
  private wsConnections = new Map<string, WebSocket>()
  private reconnectAttempts = new Map<string, number>()
  private pendingRequests = new Map<string, { resolve: (value: any) => void; reject: (reason: any) => void; timeout: NodeJS.Timeout }>()
  private requestCounter = 0

  private debug: boolean
  private detailedLogging: boolean
  private tokenizeMode: 'split' | 'none'
  private reconnectInterval: number
  private maxReconnectAttempts: number
  private useMessagePrefix: boolean

  constructor(ctx: C, rawConfig: MinecraftAdapterConfig) {
    super(ctx)
    try {
      const config = migrateConfig(rawConfig)

      this.debug = config.debug ?? false
      this.detailedLogging = config.detailedLogging ?? false
      this.tokenizeMode = config.tokenizeMode ?? 'split'
      this.reconnectInterval = config.reconnectInterval ?? 5000
      this.maxReconnectAttempts = config.maxReconnectAttempts ?? 10
      this.useMessagePrefix = config.useMessagePrefix ?? false

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
            logger.info(`[DEBUG] Initializing server ${serverConfig.selfId}`)
          }

          const bot = new MinecraftBot(ctx, serverConfig)
          bot.adapter = this
          this.bots.push(bot)

          const connectTasks: Promise<void>[] = []

          // RCON（用于执行服务器命令，与 WebSocket 并行工作）
          if (serverConfig.rcon && serverConfig.rcon.host && serverConfig.rcon.port && serverConfig.rcon.password) {
            connectTasks.push((async () => {
              try {
                if (this.debug) {
                  logger.info(`[DEBUG] Connecting RCON for server ${serverConfig.selfId} to ${serverConfig.rcon!.host}:${serverConfig.rcon!.port}`)
                }

                const rcon = await Rcon.connect({
                  host: serverConfig.rcon!.host,
                  port: serverConfig.rcon!.port,
                  password: serverConfig.rcon!.password,
                  timeout: serverConfig.rcon!.timeout || 5000,
                })
                this.rconConnections.set(serverConfig.selfId, rcon)
                bot.rcon = rcon
                logger.info(`RCON connected for server ${serverConfig.selfId} — ready for command execution`)
              } catch (error) {
                logger.warn(`Failed to connect RCON for server ${serverConfig.selfId}:`, error)
                if (this.debug) {
                  logger.info(`[DEBUG] RCON connection error details:`, (error as Error).message, (error as Error).stack)
                }
              }
            })())
          } else {
            logger.warn(`RCON not configured for server ${serverConfig.selfId} — server commands (executeCommand) will not be available`)
            if (this.debug) {
              if (serverConfig.rcon) {
                logger.info(`[DEBUG] RCON config incomplete for server ${serverConfig.selfId}, skipping (need host, port, password)`)
              } else {
                logger.info(`[DEBUG] No RCON config for server ${serverConfig.selfId}`)
              }
            }
          }

          // WebSocket（用于事件接收和消息发送）
          if (serverConfig.websocket) {
            connectTasks.push((async () => {
              if (this.debug) {
                logger.info(`[DEBUG] Initializing WebSocket for server ${serverConfig.selfId}`)
              }
              await this.connectWebSocket(bot, serverConfig.websocket)
            })())
          } else {
            if (this.debug) {
              logger.info(`[DEBUG] No WebSocket config for server ${serverConfig.selfId}`)
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
   */
  private async sendApiRequest<T = any>(
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

  private async connectWebSocket(bot: MinecraftBot<C>, wsConfig: ServerConfig['websocket']) {
    const headers: Record<string, string> = {
      'x-self-name': bot.config.serverName || bot.selfId,
      ...(wsConfig.extraHeaders || {}),
    }
    if (wsConfig.accessToken) {
      headers['Authorization'] = `Bearer ${wsConfig.accessToken}`
    }

    if (this.debug) {
      logger.info(`[DEBUG] Connecting to WebSocket: ${wsConfig.url}`)
      logger.info(`[DEBUG] Headers:`, headers)
    }

    const ws = new WebSocket(wsConfig.url, { headers })
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

      const attempts = this.reconnectAttempts.get(bot.selfId) || 0
      if (attempts < this.maxReconnectAttempts) {
        this.reconnectAttempts.set(bot.selfId, attempts + 1)
        const delay = this.reconnectInterval * Math.pow(2, attempts) // 指数退避
        if (this.debug) {
          logger.info(`[DEBUG] Attempting to reconnect WebSocket for bot ${bot.selfId} in ${delay}ms (attempt ${attempts + 1}/${this.maxReconnectAttempts})`)
        }
        setTimeout(() => {
          if (this.wsConnections.get(bot.selfId)?.readyState !== WebSocket.OPEN) {
            this.connectWebSocket(bot, wsConfig)
          }
        }, delay)
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
// Koishi Schema 配置
// ============================================================================

const serverSchema = Schema.object({
  selfId: Schema.string().description('机器人 ID（唯一标识）').required(),
  serverName: Schema.string().description('服务器名称（需与鹊桥 config.yml 中的 server_name 一致）'),
  websocket: Schema.object({
    url: Schema.string().description('WebSocket 地址（如 ws://127.0.0.1:8080）').required(),
    accessToken: Schema.string().description('访问令牌（需与鹊桥 config.yml 中的 access_token 一致）'),
    extraHeaders: Schema.dict(Schema.string()).description('额外请求头'),
  }).description('WebSocket 配置（用于事件接收和消息发送）').required(),
  rcon: Schema.object({
    host: Schema.string().description('RCON 主机地址').default('127.0.0.1'),
    port: Schema.number().description('RCON 端口').default(25575),
    password: Schema.string().description('RCON 密码').required(),
    timeout: Schema.number().description('RCON 超时时间(ms)').default(5000),
  }).description('RCON 配置（用于执行服务器命令，与 WebSocket 并行工作）'),
  chatImage: Schema.object({
    enabled: Schema.boolean().description('启用 ChatImage CICode 图片发送（需客户端安装 ChatImage Mod）').default(false),
    defaultImageName: Schema.string().description('图片在聊天栏中的默认显示名称').default('图片'),
  }).description('ChatImage 图片显示配置（仅对此服务器生效）'),
})

export namespace MinecraftAdapter {
  export const Config: Schema<MinecraftAdapterConfig> = Schema.object({
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
  })
}

export default MinecraftAdapter
