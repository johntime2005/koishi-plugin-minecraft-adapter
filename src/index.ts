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
  reconnectInterval?: number
  maxReconnectAttempts?: number
}

export class MinecraftAdapter<C extends Context = Context> extends Adapter<C, MinecraftBot<C>> {
  private rconConnections = new Map<string, Rcon>()
  private wsConnections = new Map<string, WebSocket>()
  private reconnectAttempts = new Map<string, number>()
  private debug: boolean
  private reconnectInterval: number
  private maxReconnectAttempts: number

  constructor(ctx: C, config: MinecraftAdapterConfig) {
    super(ctx)
    this.debug = config.debug ?? false
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
      }
      // 重置重连尝试次数
      this.reconnectAttempts.set(bot.selfId, 0)
      bot.online()
      clearTimeout(connectionTimeout)
    })
  }

  private createSession(bot: MinecraftBot<C>, type: string, payload: any): Session | undefined {
    if (this.debug) {
      logger.info(`[DEBUG] Creating session for event type: ${type}, payload:`, payload)
    }

    switch (type) {
      case 'chat':
      case 'player_chat':
        return {
          type: 'message',
          subtype: 'private',
          platform: 'minecraft',
          selfId: bot.selfId,
          userId: payload.player || payload.name || 'unknown',
          channelId: `mc:${payload.player || payload.name || 'unknown'}`,
          guildId: 'minecraft',
          content: payload.message || payload.text || '',
          timestamp: Date.now(),
          author: {
            userId: payload.player || payload.name || 'unknown',
            username: payload.player || payload.name || 'unknown',
          },
        } as Session

      case 'join':
      case 'player_join':
        return {
          type: 'guild-member-added',
          platform: 'minecraft',
          selfId: bot.selfId,
          userId: payload.player || payload.name || 'unknown',
          guildId: 'minecraft',
          timestamp: Date.now(),
        } as Session

      case 'leave':
      case 'quit':
      case 'player_quit':
        return {
          type: 'guild-member-removed',
          platform: 'minecraft',
          selfId: bot.selfId,
          userId: payload.player || payload.name || 'unknown',
          guildId: 'minecraft',
          timestamp: Date.now(),
        } as Session

      case 'death':
      case 'player_death':
        return {
          type: 'message',
          subtype: 'private',
          platform: 'minecraft',
          selfId: bot.selfId,
          userId: payload.player || payload.name || 'unknown',
          channelId: 'minecraft',
          guildId: 'minecraft',
          content: `💀 ${payload.player || payload.name || 'unknown'} ${payload.deathMessage || 'died'}`,
          timestamp: Date.now(),
          author: {
            userId: payload.player || payload.name || 'unknown',
            username: payload.player || payload.name || 'unknown',
          },
        } as Session

      case 'advancement':
      case 'achievement':
        return {
          type: 'message',
          subtype: 'private',
          platform: 'minecraft',
          selfId: bot.selfId,
          userId: payload.player || payload.name || 'unknown',
          channelId: 'minecraft',
          guildId: 'minecraft',
          content: `🏆 ${payload.player || payload.name || 'unknown'} achieved: ${payload.advancement || payload.achievement}`,
          timestamp: Date.now(),
          author: {
            userId: payload.player || payload.name || 'unknown',
            username: payload.player || payload.name || 'unknown',
          },
        } as Session

      default:
        // 自定义事件可以通过其他方式处理
        if (this.debug) {
          logger.info(`[DEBUG] Unhandled event type: ${type}, payload:`, payload)
        }
        logger.debug(`Unhandled event type: ${type}`, payload)
        return undefined
    }
  }

  async sendPrivateMessage(player: string, message: string): Promise<void> {
    // 优先使用 WebSocket 发送
    for (const [botId, ws] of this.wsConnections) {
      if (ws.readyState === WebSocket.OPEN) {
        const payload = {
          api: 'tell',
          data: { player, message }
        }
        ws.send(JSON.stringify(payload))
        return
      }
    }

    // 回退到 RCON
    for (const [botId, rcon] of this.rconConnections) {
      try {
        const json = JSON.stringify([{ text: message }])
        await rcon.send(`tellraw ${player} ${json}`)
        return
      } catch (error) {
        logger.warn(`Failed to send message via RCON for bot ${botId}:`, error)
      }
    }

    throw new Error('No available connection to send message')
  }

  async broadcast(message: string): Promise<void> {
    // 优先使用 WebSocket 发送
    for (const [botId, ws] of this.wsConnections) {
      if (ws.readyState === WebSocket.OPEN) {
        const payload = {
          api: 'broadcast',
          data: { message }
        }
        ws.send(JSON.stringify(payload))
        return
      }
    }

    // 回退到 RCON
    for (const [botId, rcon] of this.rconConnections) {
      try {
        await rcon.send(`say ${message}`)
        return
      } catch (error) {
        logger.warn(`Failed to broadcast via RCON for bot ${botId}:`, error)
      }
    }

    throw new Error('No available connection to broadcast message')
  }

  async stop() {
    // 关闭所有连接
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
        extraHeaders: Schema.dict(String).description('额外请求头'),
      }).description('WebSocket 配置'),
    })).description('机器人配置列表').default([]),
  })
}

export default MinecraftAdapter
