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
}

export class MinecraftAdapter<C extends Context = Context> extends Adapter<C, MinecraftBot<C>> {
  private rconConnections = new Map<string, Rcon>()
  private wsConnections = new Map<string, WebSocket>()

  constructor(ctx: C, config: MinecraftAdapterConfig) {
    super(ctx)

    // 为每个配置创建机器人
    ctx.on('ready', async () => {
      for (const botConfig of config.bots) {
        const bot = new MinecraftBot(ctx, botConfig)
        bot.adapter = this
        this.bots.push(bot)

        // 初始化 RCON 连接
        if (botConfig.rcon) {
          try {
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
          }
        }

        // 初始化 WebSocket 连接
        if (botConfig.websocket) {
          await this.connectWebSocket(bot, botConfig.websocket)
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

    const ws = new WebSocket(wsConfig.url, { headers })
    this.wsConnections.set(bot.selfId, ws)
    bot.ws = ws

    ws.on('open', () => {
      logger.info(`WebSocket connected for bot ${bot.selfId}`)
      bot.online()
    })

    ws.on('message', (data: WebSocket.RawData) => {
      try {
        const text = data.toString('utf8')
        const obj = JSON.parse(text)
        const type = obj.type || obj.event || 'unknown'
        const payload = obj.data ?? obj

        const session = this.createSession(bot, type, payload)
        if (session) {
          bot.dispatch(session)
        }
      } catch (error) {
        logger.warn('Failed to process WebSocket message:', error)
      }
    })

    ws.on('close', () => {
      logger.warn(`WebSocket disconnected for bot ${bot.selfId}`)
      bot.offline()
      // 自动重连
      setTimeout(() => {
        if (!this.wsConnections.has(bot.selfId)) {
          logger.info(`Attempting to reconnect WebSocket for bot ${bot.selfId}`)
          this.connectWebSocket(bot, wsConfig)
        }
      }, 5000)
    })

    ws.on('error', (error) => {
      logger.warn(`WebSocket error for bot ${bot.selfId}:`, error)
    })
  }

  private createSession(bot: MinecraftBot<C>, type: string, payload: any): Session | undefined {
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
