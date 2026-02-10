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
// Koishi Bot 配置与实现
// ============================================================================

export interface MinecraftBotConfig {
  selfId: string
  serverName?: string
  rcon?: {
    host: string
    port: number
    password: string
    timeout?: number
  }
  websocket?: {
    url: string
    accessToken?: string
    extraHeaders?: Record<string, string>
  }
}

export class MinecraftBot<C extends Context = Context> extends Bot<C, MinecraftBotConfig> {
  public rcon?: Rcon
  public ws?: WebSocket

  constructor(ctx: C, config: MinecraftBotConfig) {
    super(ctx, config, 'minecraft')
    this.selfId = config.selfId
    this.platform = 'minecraft'
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
        await this.adapter.broadcast(content)
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
      await this.adapter.sendPrivateMessage(userId, content)
      return []
    }
    return []
  }

  /**
   * 执行 RCON 命令
   * 优先使用 WebSocket send_rcon_command 接口，回退到直接 RCON 连接
   */
  async executeCommand(command: string): Promise<string> {
    if (this.adapter instanceof MinecraftAdapter) {
      return await this.adapter.executeRconCommand(command)
    }
    if (!this.rcon) throw new Error('RCON not connected')
    return await this.rcon.send(command)
  }
}

// ============================================================================
// Koishi Adapter 配置与实现
// ============================================================================

export interface MinecraftAdapterConfig {
  bots: MinecraftBotConfig[]
  debug?: boolean
  detailedLogging?: boolean
  tokenizeMode?: 'split' | 'none'
  reconnectInterval?: number
  maxReconnectAttempts?: number
  /** 是否在消息前添加默认前缀 [鹊桥]，默认不添加（由服务端配置） */
  useMessagePrefix?: boolean
}

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

  constructor(ctx: C, config: MinecraftAdapterConfig) {
    super(ctx)
    try {
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
          botCount: config.bots.length
        })
      }

      // 为每个配置创建机器人
      ctx.on('ready', async () => {
        if (this.debug) {
          logger.info(`[DEBUG] Koishi ready event triggered, initializing ${config.bots.length} bots`)
        }

        for (const botConfig of config.bots) {
          if (this.debug) {
            logger.info(`[DEBUG] Initializing bot ${botConfig.selfId}`)
          }

          const bot = new MinecraftBot(ctx, botConfig)
          bot.adapter = this
          this.bots.push(bot)

          // 初始化 RCON 连接
          if (botConfig.rcon && botConfig.rcon.host && botConfig.rcon.port && botConfig.rcon.password) {
            try {
              if (this.debug) {
                logger.info(`[DEBUG] Connecting RCON for bot ${botConfig.selfId} to ${botConfig.rcon.host}:${botConfig.rcon.port}`)
              }

              const rcon = await Rcon.connect({
                host: botConfig.rcon.host,
                port: botConfig.rcon.port,
                password: botConfig.rcon.password,
                timeout: botConfig.rcon.timeout || 5000,
              })
              this.rconConnections.set(botConfig.selfId, rcon)
              bot.rcon = rcon
              logger.info(`RCON connected for bot ${botConfig.selfId}`)
            } catch (error) {
              logger.warn(`Failed to connect RCON for bot ${botConfig.selfId}:`, error)
              if (this.debug) {
                logger.info(`[DEBUG] RCON connection error details:`, (error as Error).message, (error as Error).stack)
              }
            }
          } else {
            if (this.debug) {
              if (botConfig.rcon) {
                logger.info(`[DEBUG] RCON config incomplete for bot ${botConfig.selfId}, skipping (need host, port, password)`)
              } else {
                logger.info(`[DEBUG] No RCON config for bot ${botConfig.selfId}`)
              }
            }
          }

          // 初始化 WebSocket 连接
          if (botConfig.websocket) {
            if (this.debug) {
              logger.info(`[DEBUG] Initializing WebSocket for bot ${botConfig.selfId}`)
            }
            await this.connectWebSocket(bot, botConfig.websocket)
          } else {
            if (this.debug) {
              logger.info(`[DEBUG] No WebSocket config for bot ${botConfig.selfId}`)
            }
          }
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

  /**
   * 将消息转换为 Minecraft 文本组件格式
   */
  private toTextComponent(message: any): MinecraftTextComponent[] {
    const extractText = (item: any): string => {
      if (item == null) return ''
      if (typeof item === 'string') return item
      if (typeof item === 'number' || typeof item === 'boolean') return String(item)
      if (Array.isArray(item)) return item.map(extractText).join('')
      if (typeof item === 'object') {
        if (item.attrs && typeof item.attrs.content === 'string') return item.attrs.content
        if (typeof item.content === 'string') return item.content
        if (typeof item.text === 'string') return item.text
        if (item.children) return extractText(item.children)
        try {
          if (typeof item.toString === 'function' && item.toString !== Object.prototype.toString) {
            const s = item.toString()
            if (typeof s === 'string' && s !== '[object Object]') return s
          }
        } catch (e) {
          // ignore
        }
        let acc = ''
        for (const key in item) {
          try {
            acc += extractText((item as any)[key])
          } catch (e) {
            // ignore
          }
        }
        return acc
      }
      return String(item)
    }

    const text = extractText(message)
    return [{ text }]
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

  private async connectWebSocket(bot: MinecraftBot<C>, wsConfig: NonNullable<MinecraftBotConfig['websocket']>) {
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
   */
  private parseMessageToElements(messageText: string): any[] {
    if (!messageText) return []

    const tokens: string[] =
      this.tokenizeMode === 'none'
        ? [messageText]
        : messageText.split(/(\s+)/).filter((s: string) => s.length > 0)

    return tokens.map((token) => {
      const el: any = { type: 'text', attrs: { content: token } }
      el.toString = function () {
        return this.attrs?.content ?? ''
      }
      return el
    })
  }

  /**
   * 发送私聊消息 (send_private_msg)
   */
  async sendPrivateMessage(player: string, message: string): Promise<void> {
    if (this.debug) {
      logger.info(`[DEBUG] Sending private message to player ${player}: ${message}`)
    }

    const messageComponent = this.toTextComponent(message)

    // 优先使用 WebSocket 发送
    for (const [botId, ws] of this.wsConnections) {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          // 鹊桥 V2 API: send_private_msg
          // 参数: uuid 或 nickname (至少一个), message (Minecraft 文本组件)
          const response = await this.sendApiRequest(ws, 'send_private_msg', {
            nickname: player, // 优先使用 nickname
            message: messageComponent
          })
          if (this.debug) {
            logger.info(`[DEBUG] Private message sent successfully:`, response)
          }
          return
        } catch (error) {
          logger.warn(`Failed to send private message via WebSocket for bot ${botId}:`, error)
        }
      }
    }

    // 回退到 RCON
    for (const [botId, rcon] of this.rconConnections) {
      try {
        const json = JSON.stringify(messageComponent)
        if (this.debug) {
          logger.info(`[DEBUG] Sending via RCON: tellraw ${player} ${json}`)
        }
        await rcon.send(`tellraw ${player} ${json}`)
        return
      } catch (error) {
        logger.warn(`Failed to send message via RCON for bot ${botId}:`, error)
      }
    }

    throw new Error('No available connection to send message')
  }

  /**
   * 广播消息 (broadcast)
   */
  async broadcast(message: string): Promise<void> {
    if (this.debug) {
      logger.info(`[DEBUG] Broadcasting message: ${message}`)
    }

    const messageComponent = this.toTextComponent(message)

    // 优先使用 WebSocket 发送
    for (const [botId, ws] of this.wsConnections) {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          // 鹊桥 V2 API: broadcast
          // 参数: message (Minecraft 文本组件)
          const response = await this.sendApiRequest(ws, 'broadcast', {
            message: messageComponent
          })
          if (this.debug) {
            logger.info(`[DEBUG] Broadcast sent successfully:`, response)
          }
          return
        } catch (error) {
          logger.warn(`Failed to broadcast via WebSocket for bot ${botId}:`, error)
        }
      }
    }

    // 回退到 RCON
    for (const [botId, rcon] of this.rconConnections) {
      try {
        const text = typeof message === 'string' ? message : JSON.stringify(message)
        if (this.debug) {
          logger.info(`[DEBUG] Broadcasting via RCON: say ${text}`)
        }
        await rcon.send(`say ${text}`)
        return
      } catch (error) {
        logger.warn(`Failed to broadcast via RCON for bot ${botId}:`, error)
      }
    }

    throw new Error('No available connection to broadcast message')
  }

  /**
   * 执行 RCON 命令 (send_rcon_command)
   */
  async executeRconCommand(command: string): Promise<string> {
    if (this.debug) {
      logger.info(`[DEBUG] Executing RCON command: ${command}`)
    }

    // 优先使用 WebSocket 发送
    for (const [botId, ws] of this.wsConnections) {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          // 鹊桥 V2 API: send_rcon_command
          // 参数: command
          const response = await this.sendApiRequest<string>(ws, 'send_rcon_command', {
            command
          })
          if (this.debug) {
            logger.info(`[DEBUG] RCON command executed successfully:`, response)
          }
          return response.data || ''
        } catch (error) {
          logger.warn(`Failed to execute RCON command via WebSocket for bot ${botId}:`, error)
        }
      }
    }

    // 回退到直接 RCON
    for (const [botId, rcon] of this.rconConnections) {
      try {
        if (this.debug) {
          logger.info(`[DEBUG] Executing via direct RCON: ${command}`)
        }
        return await rcon.send(command)
      } catch (error) {
        logger.warn(`Failed to execute RCON command for bot ${botId}:`, error)
      }
    }

    throw new Error('No available connection to execute RCON command')
  }

  /**
   * 发送标题消息 (title)
   */
  async sendTitle(
    title: string | MinecraftTextComponent,
    subtitle?: string | MinecraftTextComponent,
    player?: string
  ): Promise<void> {
    const titleComponent = typeof title === 'string' ? { text: title } : title
    const subtitleComponent = subtitle ? (typeof subtitle === 'string' ? { text: subtitle } : subtitle) : undefined

    for (const [botId, ws] of this.wsConnections) {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          const data: any = { title: titleComponent }
          if (subtitleComponent) data.subtitle = subtitleComponent
          if (player) data.nickname = player

          await this.sendApiRequest(ws, 'send_title', data)
          return
        } catch (error) {
          logger.warn(`Failed to send title via WebSocket for bot ${botId}:`, error)
        }
      }
    }

    throw new Error('No available connection to send title')
  }

  /**
   * 发送动画栏消息 (action_bar)
   */
  async sendActionBar(message: string | MinecraftTextComponent, player?: string): Promise<void> {
    const messageComponent = typeof message === 'string' ? { text: message } : message

    for (const [botId, ws] of this.wsConnections) {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          const data: any = { message: messageComponent }
          if (player) data.nickname = player

          await this.sendApiRequest(ws, 'send_actionbar', data)
          return
        } catch (error) {
          logger.warn(`Failed to send action bar via WebSocket for bot ${botId}:`, error)
        }
      }
    }

    throw new Error('No available connection to send action bar')
  }

  async stop() {
    if (this.debug) {
      logger.info(`[DEBUG] Stopping MinecraftAdapter`)
    }

    // 清理所有待处理的请求
    for (const [echo, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout)
      pending.reject(new Error('Adapter stopped'))
    }
    this.pendingRequests.clear()

    for (const [botId, ws] of this.wsConnections) {
      try {
        ws.close()
      } catch (error) {
        logger.warn(`Failed to close WebSocket for bot ${botId}:`, error)
      }
    }
    this.wsConnections.clear()

    for (const [botId, rcon] of this.rconConnections) {
      try {
        rcon.end()
      } catch (error) {
        logger.warn(`Failed to close RCON for bot ${botId}:`, error)
      }
    }
    this.rconConnections.clear()
  }
}

// ============================================================================
// Koishi Schema 配置
// ============================================================================

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
    bots: Schema.array(Schema.object({
      selfId: Schema.string().description('机器人 ID（唯一标识）').required(),
      serverName: Schema.string().description('服务器名称（需与鹊桥 config.yml 中的 server_name 一致）'),
      rcon: Schema.object({
        host: Schema.string().description('RCON 主机地址').default('127.0.0.1'),
        port: Schema.number().description('RCON 端口').default(25575),
        password: Schema.string().description('RCON 密码').required(),
        timeout: Schema.number().description('RCON 超时时间(ms)').default(5000),
      }).description('RCON 配置（可选，用于回退）'),
      websocket: Schema.object({
        url: Schema.string().description('WebSocket 地址（如 ws://127.0.0.1:8080）').required(),
        accessToken: Schema.string().description('访问令牌（需与鹊桥 config.yml 中的 access_token 一致）'),
        extraHeaders: Schema.dict(Schema.string()).description('额外请求头'),
      }).description('WebSocket 配置'),
    })).description('机器人配置列表').default([]),
  })
}

export default MinecraftAdapter
