import { Adapter, Bot, Context, Logger, Schema, Session } from 'koishi'
import { Rcon } from 'rcon-client'
import WebSocket from 'ws'

const logger = new Logger('minecraft')

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
  }

  async sendMessage(channelId: string, content: string) {
    if (channelId.startsWith('mc:')) {
      const player = channelId.slice(3)
      return await this.sendPrivateMessage(player, content)
    } else {
      if (this.adapter instanceof MinecraftAdapter) {
        await this.adapter.broadcast(content)
        return []
      }
      return []
    }
  }

  async sendPrivateMessage(userId: string, content: string): Promise<string[]> {
    if (this.adapter instanceof MinecraftAdapter) {
      await this.adapter.sendPrivateMessage(userId, content)
      return []
    }
    return []
  }

  async executeCommand(command: string): Promise<string> {
    if (!this.rcon) throw new Error('RCON not connected')
    return await this.rcon.send(command)
  }
}

export interface MinecraftAdapterConfig {
  bots: MinecraftBotConfig[]
  debug?: boolean
  detailedLogging?: boolean
  tokenizeMode?: 'split' | 'none'
  reconnectInterval?: number
  maxReconnectAttempts?: number
}

export class MinecraftAdapter<C extends Context = Context> extends Adapter<C, MinecraftBot<C>> {
  private rconConnections = new Map<string, Rcon>()
  private wsConnections = new Map<string, WebSocket>()
  private reconnectAttempts = new Map<string, number>()
  private debug: boolean
  private detailedLogging: boolean
  private tokenizeMode: 'split' | 'none'
  private reconnectInterval: number
  private maxReconnectAttempts: number

  constructor(ctx: C, config: MinecraftAdapterConfig) {
    super(ctx)
    try {
  this.debug = config.debug ?? false
  this.detailedLogging = (config as any).detailedLogging ?? false
  this.tokenizeMode = (config as any).tokenizeMode ?? 'split'
      this.reconnectInterval = config.reconnectInterval ?? 5000
      this.maxReconnectAttempts = config.maxReconnectAttempts ?? 10

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
        if (botConfig.rcon) {
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
              logger.info(`[DEBUG] RCON connection error details:`, error.message, error.stack)
            }
          }
        } else {
          if (this.debug) {
            logger.info(`[DEBUG] No RCON config for bot ${botConfig.selfId}`)
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
      // rethrow so Koishi can report the plugin load failure with stack
      throw err
    }
  }

  // 将 message 元素序列化为字符串或简单数组，避免将 Element 实例原样 JSON.stringify 导致丢失内容
  private serializeOutgoingMessage(message: any) {
    if (message == null) return message
    if (typeof message === 'string') return message
    if (Array.isArray(message)) {
      return message.map((item) => {
        if (item == null) return item
        if (typeof item === 'string') return item
        if (typeof item === 'object') {
          // satori Element-like
          if (item.attrs) return item.attrs.content ?? JSON.stringify(item)
          return item.content ?? item.text ?? JSON.stringify(item)
        }
        return String(item)
      })
    }
    if (typeof message === 'object') {
      // 支持 satori Element-like 对象以及常见的 text/content 字段
      return message.content ?? (message.attrs && message.attrs.content) ?? message.text ?? JSON.stringify(message)
    }
    return String(message)
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

  // (已移除心跳发送与连接状态轮询以减少周期性日志与 ping)

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
  // 心跳发送已移除
    })

    ws.on('message', (data: WebSocket.RawData) => {
      try {
        const text = data.toString('utf8')
        if (this.debug) {
          logger.info(`[DEBUG] Received WebSocket message for bot ${bot.selfId}:`, text)
          logger.info(`[DEBUG] Message length: ${text.length} characters`)
        }

        const obj = JSON.parse(text)
        const postType = obj.post_type
        const subType = obj.sub_type
        const eventName = obj.event_name
        const payload = obj

        // 确定消息类型
        let type = 'unknown'
        if (postType === 'message') {
          if (subType === 'chat' || eventName === 'AsyncPlayerChatEvent') {
            type = 'chat'
          }
        } else if (postType === 'notice') {
          if (subType === 'join' || eventName === 'PlayerJoinEvent') {
            type = 'join'
          } else if (subType === 'leave' || eventName === 'PlayerQuitEvent') {
            type = 'leave'
          }
        }

        if (this.debug) {
          logger.info(`[DEBUG] Parsed message type: ${type}, post_type: ${postType}, sub_type: ${subType}, event_name: ${eventName}, payload:`, payload)
        }

        const session = this.createSession(bot, type, payload)
        if (session) {
          if (this.debug) {
              logger.info(`[DEBUG] Created session:`, session)
              logger.info(`[DEBUG] Preparing to dispatch session to bot ${bot.selfId}`)

              // 进一步追踪 session 内的重要字段，避免直接序列化整个对象导致循环引用问题
              try {
                const content = session.content
                const cid = (session as any).cid || (session as any).channelId || null
                const gid = (session as any).gid || (session as any).guildId || null
                const uid = (session as any).uid || (session as any).userId || null
                const ev = (session as any).event || {}
                const msg = ev.message || (ev._data && ev._data.message) || null
                logger.info(`[TRACE] session.content:`, content)
                logger.info(`[TRACE] session.ids:`, { cid, gid, uid })
                logger.info(`[TRACE] event.type/message:`, { type: ev.type || ev._type || null, messageContent: msg?.content || msg?.text || null })
              } catch (err) {
                logger.warn(`[TRACE] Failed to extract session fields:`, err)
              }
          }

          // 在 dispatch 之前记录完整 session 快照（当 detailedLogging 启用时）
          if (this.detailedLogging) {
            try {
              const snapshot = {
                sessionId: (session as any).id,
                content: session.content,
                elements: session.event?.message?.elements,
                eventMessage: session.event?.message,
                eventReferrer: session.event?.referrer,
                user: session.event?.user,
                userId: (session as any).userId || session.event?.user?.id,
                guildId: (session as any).guildId || session.event?.guild?.id,
                channelId: (session as any).channelId || session.event?.channel?.id,
                isDirect: (session as any).isDirect,
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
            // 记录 dispatch 中上游插件抛出的错误以便定位
            logger.warn(`Dispatch threw an error for bot ${bot.selfId}:`, err)
            if (this.detailedLogging) {
              try {
                const snapshot = {
                  sessionId: (session as any).id,
                  content: session.content,
                  elements: session.event?.message?.elements,
                  eventMessage: session.event?.message,
                  eventReferrer: session.event?.referrer,
                  userId: (session as any).userId || session.event?.user?.id,
                  guildId: (session as any).guildId || session.event?.guild?.id,
                }
                logger.info(`[DETAILED] Dispatch error session snapshot for bot ${bot.selfId}:`, snapshot)
              } catch (e) {
                logger.warn(`[DETAILED] Failed to capture session snapshot:`, e)
              }
            }
            if (this.debug) {
              logger.info(`[DEBUG] Dispatch error stack:`, err?.stack || err)
              // 继续，不抛出，避免影响 WebSocket 消息处理循环
            }
          }

          if (this.debug) {
            logger.info(`[DEBUG] Post-dispatch: you can now check Koishi logs for further processing of this session`)
          }
        } else {
          if (this.debug) {
            logger.info(`[DEBUG] No session created for message type: ${type}`)
          }
        }
      } catch (error) {
        logger.warn('Failed to process WebSocket message:', error)
        if (this.debug) {
          logger.info(`[DEBUG] Raw message data:`, data.toString('utf8'))
          logger.info(`[DEBUG] Parse error:`, error.message, error.stack)
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

  // 清理连接相关资源

      const attempts = this.reconnectAttempts.get(bot.selfId) || 0
      if (attempts < this.maxReconnectAttempts) {
        this.reconnectAttempts.set(bot.selfId, attempts + 1)
        const delay = this.reconnectInterval * Math.pow(2, attempts) // 指数退避
        if (this.debug) {
          logger.info(`[DEBUG] Attempting to reconnect WebSocket for bot ${bot.selfId} in ${delay}ms (attempt ${attempts + 1}/${this.maxReconnectAttempts})`)
        }
        setTimeout(() => {
          if (!this.wsConnections.has(bot.selfId)) {
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
        logger.info(`[DEBUG] WebSocket error details:`, error.message, error.stack)
      }
    })

    ws.on('ping', () => {
  // ping handling removed
    })

    ws.on('pong', () => {
  // pong handling removed
    })
  }

  private createSession(bot: MinecraftBot<C>, type: string, payload: any): Session | undefined {
    if (this.debug) {
      logger.info(`[DEBUG] Creating session for event type: ${type}, payload:`, payload)
    }

    // 创建 Event 对象
    const event: any = {
      sn: Date.now(), // 简单的时间戳作为序列号
      type: type === 'chat' ? 'message' : type === 'join' ? 'guild-member-added' : type === 'leave' ? 'guild-member-removed' : type,
      login: {
        sn: bot.sn,
        adapter: 'minecraft-adapter',
        user: bot.user || { id: bot.selfId, name: bot.selfId }, // 确保 user 对象完整
        platform: 'minecraft',
        selfId: bot.selfId,
        status: bot.status,
        features: bot.features,
      },
      selfId: bot.selfId,
      platform: 'minecraft',
      timestamp: (payload.timestamp || Date.now()) * 1000,
      referrer: payload,
    }

    // 根据事件类型设置相应的属性
    switch (type) {
      case 'chat':
        const player = payload.player
        const userId = player?.uuid || player?.display_name || 'unknown'
        const username = player?.display_name || player?.nickname || userId

        event.user = {
          id: userId,
          name: username,
          nick: player?.nickname,
        }
        event.channel = {
          id: payload.server_name || 'minecraft',
          type: 0, // TEXT
        }
        event.guild = {
          id: payload.server_name || 'minecraft',
          name: payload.server_name || 'Minecraft Server',
        }
        // 将元素设为字符串数组（简洁、可靠）：Session.content getter 会对 elements.join("") 返回文本
  // 规范化消息文本并将其分词为 elements，提升 Koishi 命令解析的准确性
        let messageText: string = ''
        if (payload == null) {
          messageText = ''
        } else if (typeof payload.message === 'string') {
          messageText = payload.message
        } else if (Array.isArray(payload.message)) {
          // 如果 payload.message 已经是数组，尝试把每项转换为字符串并连接为文本
          messageText = payload.message.map((it: any) => (typeof it === 'string' ? it : it?.content ?? it?.text ?? JSON.stringify(it))).join(' ')
        } else if (typeof payload.message === 'object') {
          // 支持常见 component 对象
          messageText = payload.message.attrs?.content ?? payload.message.content ?? payload.message.text ?? JSON.stringify(payload.message)
        } else {
          messageText = String(payload.message ?? '')
        }

  // 先按照配置得到字符串 tokens，然后将它们转换为 Koishi 兼容的元素对象
  let elements = (() => {
          if (!messageText) return []
          const tokens: string[] =
            this.tokenizeMode === 'none'
              ? [messageText]
              : messageText.split(/(\s+)/).filter((s: string) => s.length > 0)

          // 将每个 token 包装为 Koishi h 元素对象，确保 ChatLuna 的 messageTransformer/intercept 能读取到 element.type 和 element.attrs.content
          // 同时为每个元素添加 toString 方法，保证 elements.join('') 会返回原始文本（用于 session.content 与命令解析）
          return tokens.map((token) => {
            const el: any = { type: 'text', attrs: { content: token } }
            el.toString = function () {
              return this.attrs?.content ?? ''
            }
            return el
          })
        })()

  // （已移除 wakeWords 相关处理，适配器保持最小侵入性，由上游中间件负责唤醒逻辑）

        if (this.detailedLogging) {
          logger.info(`[DEBUG] Message parse details for bot ${bot.selfId}: rawPayloadMessage=`, payload.message)
          logger.info(`[DEBUG] Message parse details for bot ${bot.selfId}: messageText=`, messageText)
          logger.info(`[DEBUG] Message parse details for bot ${bot.selfId}: elements=`, elements)
        }

        event.message = {
          id: payload.message_id || Date.now().toString(),
          content: messageText,
          timestamp: (payload.timestamp || Date.now()) * 1000,
          user: event.user, // 现在 event.user 已经定义了
          elements,
          createdAt: (payload.timestamp || Date.now()) * 1000,
          updatedAt: (payload.timestamp || Date.now()) * 1000,
        }
        break

      case 'join':
        const joinPlayer = payload.player
        const joinUserId = joinPlayer?.uuid || joinPlayer?.display_name || 'unknown'

        event.user = {
          id: joinUserId,
          name: joinPlayer?.display_name || joinPlayer?.nickname || joinUserId,
          nick: joinPlayer?.nickname,
        }
        event.guild = {
          id: payload.server_name || 'minecraft',
          name: payload.server_name || 'Minecraft Server',
        }
        event.member = {
          user: event.user,
          nick: joinPlayer?.nickname,
          joinedAt: (payload.timestamp || Date.now()) * 1000,
        }
        break

      case 'leave':
        const leavePlayer = payload.player
        const leaveUserId = leavePlayer?.uuid || leavePlayer?.display_name || 'unknown'

        event.user = {
          id: leaveUserId,
          name: leavePlayer?.display_name || leavePlayer?.nickname || leaveUserId,
          nick: leavePlayer?.nickname,
        }
        event.guild = {
          id: payload.server_name || 'minecraft',
          name: payload.server_name || 'Minecraft Server',
        }
        event.member = {
          user: event.user,
          nick: leavePlayer?.nickname,
        }
        break

      default:
        if (this.debug) {
          logger.info(`[DEBUG] Unhandled event type: ${type}, payload:`, payload)
        }
        logger.debug(`Unhandled event type: ${type}`, payload)
        return undefined
    }

    // 使用 bot.session() 方法创建 Session 对象
    // 添加兼容性的 room/context 字段，便于 downstream 中间件（例如 chatluna）识别房间或上下文
    try {
      const channelId = event.channel?.id || event.guild?.id || 'minecraft'
      const roomId = `${event.platform}:${channelId}`
      ;(event as any).room = { id: roomId }
      ;(event as any).context = (event as any).context || {}
      ;(event as any).context.options = Object.assign({}, (event as any).context.options || {}, { room: roomId })
      // 也在 channel 上放一个兼容别名，便于某些插件直接读取
      if (event.channel) (event.channel as any).altId = roomId
      if (this.detailedLogging) {
        try {
          logger.info(`[DETAILED] Added compatibility room/context for bot ${bot.selfId}:`, { roomId })
        } catch (e) {
          // ignore
        }
      }
    } catch (e) {
      if (this.debug) logger.warn('[DEBUG] Failed to add compatibility room/context:', e)
    }

    return bot.session(event)
  }

  async sendPrivateMessage(player: string, message: string): Promise<void> {
    if (this.debug) {
      logger.info(`[DEBUG] Sending private message to player ${player}: ${message}`)
    }

    // 优先使用 WebSocket 发送
    const serialized = this.serializeOutgoingMessage(message)
    for (const [botId, ws] of this.wsConnections) {
      if (ws.readyState === WebSocket.OPEN) {
        const wsMessage = Array.isArray(serialized) ? serialized.join('') : serialized
        const payload = {
          api: 'tell',
          data: { player, message: wsMessage }
        }
        if (this.debug) {
          logger.info(`[DEBUG] Sending via WebSocket:`, payload)
        }
        ws.send(JSON.stringify(payload))
        return
      }
    }

    // 回退到 RCON
    for (const [botId, rcon] of this.rconConnections) {
      try {
        // RCON tellraw expects a JSON text component array
        let components: any[]
        if (Array.isArray(serialized)) {
          components = serialized.map((s) => ({ text: String(s) }))
        } else {
          components = [{ text: String(serialized) }]
        }
        const json = JSON.stringify(components)
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

  async broadcast(message: string): Promise<void> {
    if (this.debug) {
      logger.info(`[DEBUG] Broadcasting message: ${message}`)
    }

    // 优先使用 WebSocket 发送
    const serialized = this.serializeOutgoingMessage(message)
    for (const [botId, ws] of this.wsConnections) {
      if (ws.readyState === WebSocket.OPEN) {
        const wsMessage = Array.isArray(serialized) ? serialized.join('') : serialized
        const payload = {
          api: 'broadcast',
          data: { message: wsMessage }
        }
        if (this.debug) {
          logger.info(`[DEBUG] Broadcasting via WebSocket:`, payload)
        }
        ws.send(JSON.stringify(payload))
        return
      }
    }

    // 回退到 RCON
    for (const [botId, rcon] of this.rconConnections) {
      try {
        // RCON say expects a plain string
        const text = Array.isArray(serialized) ? serialized.join('') : String(serialized)
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

  async stop() {
    if (this.debug) {
      logger.info(`[DEBUG] Stopping MinecraftAdapter`)
    }

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

export namespace MinecraftAdapter {
  export const Config: Schema<MinecraftAdapterConfig> = Schema.object({
    debug: Schema.boolean().description('启用调试模式，输出详细日志').default(false),
    reconnectInterval: Schema.number().description('重连间隔时间(ms)').default(5000),
    maxReconnectAttempts: Schema.number().description('最大重连尝试次数').default(10),
    bots: Schema.array(Schema.object({
      selfId: Schema.string().description('机器人 ID').required(),
      serverName: Schema.string().description('服务器名称'),
      rcon: Schema.object({
        host: Schema.string().description('RCON 主机地址').default('127.0.0.1'),
        port: Schema.number().description('RCON 端口').default(25575),
        password: Schema.string().description('RCON 密码').required(),
        timeout: Schema.number().description('RCON 超时时间(ms)').default(5000),
      }).description('RCON 配置'),
      websocket: Schema.object({
        url: Schema.string().description('WebSocket 地址').required(),
        accessToken: Schema.string().description('访问令牌'),
        extraHeaders: Schema.dict(Schema.string()).description('额外请求头'),
      }).description('WebSocket 配置'),
    })).description('机器人配置列表').default([]),
  detailedLogging: Schema.boolean().description('启用详细调试日志（记录入站解析和 dispatch 快照）').default(false),
  tokenizeMode: Schema.union([Schema.const('split'), Schema.const('none')]).description('入站消息的分词模式：split=按空白分词（默认），none=不分词，保留原文').default('split'),
  })
}

export default MinecraftAdapter
