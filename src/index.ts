import { Adapter, Bot, Context, Logger, Schema, Service } from 'koishi'
import { Rcon } from 'rcon-client'
import WebSocket from 'ws'

const logger = new Logger('minecraft')

export interface MinecraftServiceAPI {
	/** 发送任意 RCON 指令，返回原始响应字符串 */
	execute(command: string): Promise<string>
	/** 广播一条消息（基于配置选择 say 或 tellraw） */
	broadcast(message: string): Promise<string>
	/** 向指定玩家发送消息（tellraw） */
	sendTo(player: string, message: string): Promise<string>
	/** 通过 WS 广播（可回退 RCON） */
	wsBroadcast(message: string): Promise<string | void>
	/** 通过 WS 私聊（可回退 RCON） */
	wsTell(player: string, message: string): Promise<string | void>
	/** 通过 WS 或 RCON 发送标题、子标题 */
	wsTitle(player: string, title: string, subtitle?: string): Promise<string | void>
	/** 通过 WS 或 RCON 发送动作栏 */
	wsActionbar(player: string, message: string): Promise<string | void>
}

class MinecraftService extends Service implements MinecraftServiceAPI {
	static inject = {
		required: [],
		optional: ['server'],
	}

	private rcon?: Rcon
	private isConnecting = false
	private reconnectTimer?: any
	private currentReconnectInterval?: number

	private commandQueue: Array<{ command: string; resolve: (v: string) => void; reject: (e: any) => void }> = []
	private isProcessingQueue = false

	// WebSocket
	private ws?: WebSocket
	private wsReconnectTimer?: any
	private wsCurrentInterval?: number

	// Debug
	private debugEnabled = false

	// Command rate limit
	private commandBuckets: Map<string, { count: number; resetAt: number }> = new Map()

    // 正式适配器占位（暂不启用）

	// 内置简易 Bot（用于在无正式 Adapter 时注入会话）
	private internalBot?: MinecraftBot

	// 正式 Adapter + Bot
	private adapterInstance?: MinecraftAdapter
	private runtimeBot?: MinecraftBot

	constructor(public ctx: Context, public config: MinecraftService.Config) {
		super(ctx, 'minecraft', true)
		this.debugEnabled = !!config.debug

		if (config.webhook?.enabled) {
			this.registerWebhook()
		}

		// 创建一个内部 Bot，便于把聊天注入 Koishi 标准消息事件
		if (config.adapterCompat?.injectMessage) {
			this.internalBot = new MinecraftBot(ctx, { selfId: config.websocket?.serverName || 'minecraft' }, this)
			;(this.internalBot as any).adapter = new DummyAdapter(ctx)
		}

		if (config.adapter?.enabled && config.websocket?.enabled) {
			const selfId = config.adapter.selfId || config.websocket.serverName || 'minecraft'
			this.adapterInstance = new MinecraftAdapter(ctx, this)
			this.runtimeBot = new MinecraftBot(ctx, { selfId }, this)
			;(this.runtimeBot as any).adapter = this.adapterInstance
			// 尝试注册到 Koishi bots 列表，便于在控制台显示（仅 debug 日志）
			try {
				const bots = (this.ctx as any).bots
				if (Array.isArray(bots) && !bots.includes(this.runtimeBot)) bots.push(this.runtimeBot)
				this.dlog('adapter.register.bot', { selfId })
			} catch {}
		}

		// 注册 Koishi 指令，便于 ChatLuna 通过自然语言“触发命令”
		if (config.commands?.enabled !== false) {
			const authority = config.commands?.authority ?? 2
			ctx.command('mc.exec <command:text>', '执行 Minecraft 指令 (RCON)')
				.action(async ({ session }, command) => {
					this.dlog('cmd.exec', { command })
					const currentAuth = Number(((session as any)?.user?.authority) ?? 0)
					if (currentAuth < authority) return '权限不足'
					if (!command) return '用法: mc.exec <command>'
					if (!this.checkCommandAllowed(command)) return '命令不在白名单或命中黑名单'
					if (!this.consumeBucket('exec')) return '执行过于频繁，请稍后再试'
					try {
						const res = await this.execute(command)
						return res || '已执行'
					} catch (e: any) {
						return '执行失败: ' + (e?.message || e)
					}
				})

			ctx.command('mc.say <message:text>', '向服务器广播消息')
				.action(async ({ session }, message) => {
					this.dlog('cmd.say', { message })
					const currentAuth = Number(((session as any)?.user?.authority) ?? 0)
					if (currentAuth < authority) return '权限不足'
					if (!message) return '用法: mc.say <message>'
					if (!this.consumeBucket('say')) return '发送过于频繁，请稍后再试'
					try {
						const res = await this.broadcast(message)
						return res || '已广播'
					} catch (e: any) {
						return '广播失败: ' + (e?.message || e)
					}
				})

			ctx.command('mc.tell <player:string> <message:text>', '向指定玩家发送消息')
				.action(async ({ session }, player, message) => {
					this.dlog('cmd.tell', { player, message })
					const currentAuth = Number(((session as any)?.user?.authority) ?? 0)
					if (currentAuth < authority) return '权限不足'
					if (!player || !message) return '用法: mc.tell <player> <message>'
					if (!this.consumeBucket('tell')) return '发送过于频繁，请稍后再试'
					try {
						const res = await this.sendTo(player, message)
						return res || '已发送'
					} catch (e: any) {
						return '发送失败: ' + (e?.message || e)
					}
				})
			ctx.command('mc.kick <player:string> [reason:text]', '踢出玩家')
				.action(async ({ session }, player, reason) => {
					const currentAuth = Number(((session as any)?.user?.authority) ?? 0)
					if (currentAuth < authority) return '权限不足'
					if (!player) return '用法: mc.kick <player> [reason]'
					if (!this.checkCommandAllowed('kick') || !this.consumeBucket('kick')) return '操作过于频繁或不被允许'
					try {
						const cmd = reason ? `kick ${player} ${escapeForMc(reason)}` : `kick ${player}`
						const res = await this.execute(cmd)
						return res || '已踢出'
					} catch (e: any) {
						return '执行失败: ' + (e?.message || e)
					}
				})

			ctx.command('mc.title <player:string> <title:text> [subtitle:text]', '向玩家发送标题/子标题')
				.action(async ({ session }, player, title, subtitle) => {
					this.dlog('cmd.title', { player, title, subtitle })
					const currentAuth = Number(((session as any)?.user?.authority) ?? 0)
					if (currentAuth < authority) return '权限不足'
					if (!player || !title) return '用法: mc.title <player> <title> [subtitle]'
					try {
						await this.wsTitle(player, title, subtitle)
						return '已发送'
					} catch (e: any) {
						return '发送失败: ' + (e?.message || e)
					}
				})

			ctx.command('mc.actionbar <player:string> <message:text>', '向玩家发送动作栏')
				.action(async ({ session }, player, message) => {
					this.dlog('cmd.actionbar', { player, message })
					const currentAuth = Number(((session as any)?.user?.authority) ?? 0)
					if (currentAuth < authority) return '权限不足'
					if (!player || !message) return '用法: mc.actionbar <player> <message>'
					try {
						await this.wsActionbar(player, message)
						return '已发送'
					} catch (e: any) {
						return '发送失败: ' + (e?.message || e)
					}
				})

			ctx.command('mc.debug <opt:string>', '开启/关闭/切换调试日志 (on|off|toggle)')
				.action(async ({ session }, opt) => {
					const currentAuth = Number(((session as any)?.user?.authority) ?? 0)
					if (currentAuth < authority) return '权限不足'
					const v = String(opt || '').toLowerCase()
					if (v === 'on') { this.setDebug(true); return '调试已开启' }
					if (v === 'off') { this.setDebug(false); return '调试已关闭' }
					if (v === 'toggle') { this.setDebug(!this.debugEnabled); return `调试已${this.debugEnabled ? '开启' : '关闭'}` }
					return '用法: mc.debug <on|off|toggle>'
				})
		}
	}

	private registerWebhook() {
		const { path = '/minecraft/webhook', secret, verifyMode = 'header-secret', signatureHeader = 'x-queqiao-signature', secretHeader = 'x-queqiao-secret' } = this.config.webhook!
		const router = (this.ctx as any).router
		if (!router) {
			logger.warn('未检测到 Koishi 服务器(router)，Webhook 将不会启用。请安装并启用 @koishijs/plugin-server。')
			return
		}
		router.post(path, async (koaCtx: any) => {
			try {
				const req = koaCtx.request as any
				const body = req.body || {}
				this.dlog('webhook.inbound', { headers: maskHeaders(koaCtx.headers), body })

				// 验证
				if (verifyMode === 'header-secret' && secret) {
					const provided = (koaCtx.headers[secretHeader] as string) || (koaCtx.query['secret'] as string) || ''
					if (provided !== secret) {
						koaCtx.status = 401
						koaCtx.body = 'invalid secret'
						return
					}
				} else if (verifyMode === 'hmac-sha256' && secret) {
					const sig = (koaCtx.headers[signatureHeader] as string) || ''
					const raw = req.rawBody ?? JSON.stringify(body)
					if (!verifyHmacSha256(raw, secret, sig)) {
						koaCtx.status = 401
						koaCtx.body = 'invalid signature'
						return
					}
				}

				// 兼容常见事件格式：{ type, data }
				const type = body.type || body.event || 'unknown'
				const data = body.data ?? body
				const mapped = mapQueqiaoEvent(type, data)
				// 派发 Koishi 事件，名称按 "minecraft/<type>"
				this.dlog('webhook.dispatch', { type: mapped.type, payload: mapped.payload })
				this.ctx.emit(`minecraft/${mapped.type}`, mapped.payload)
				koaCtx.body = { ok: true }
			} catch (e) {
				logger.warn(e)
				koaCtx.status = 500
				koaCtx.body = 'internal error'
			}
		})
		logger.info(`已注册鹊桥 Webhook 路由: ${path}`)
	}

	start() {
		if (this.config.rcon?.enabled) {
			this.ensureConnected()
		}
		if (this.config.websocket?.enabled) {
			this.ensureWsConnected()
		}
		if (this.config.adapter?.enabled) {
			// 若还未初始化，运行期创建适配器与 Bot
			if (!this.adapterInstance || !this.runtimeBot) {
				const selfId = this.config.adapter.selfId || this.config.websocket?.serverName || 'minecraft'
				this.adapterInstance = new MinecraftAdapter(this.ctx, this)
				this.runtimeBot = new MinecraftBot(this.ctx, { selfId }, this)
				;(this.runtimeBot as any).adapter = this.adapterInstance
				try {
					const bots = (this.ctx as any).bots
					if (Array.isArray(bots) && !bots.includes(this.runtimeBot)) bots.push(this.runtimeBot)
					this.dlog('adapter.register.bot', { selfId })
				} catch {}
			}
			this.dlog('adapter.enabled', {})
			if (this.adapterInstance && this.runtimeBot) {
				this.dlog('adapter.connecting', {})
				void this.adapterInstance.connect(this.runtimeBot)
			} else {
				this.dlog('adapter.missing', {})
			}
		}
	}

	stop() {
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer)
			this.reconnectTimer = undefined
		}
		this.disconnect()
		if (this.wsReconnectTimer) {
			clearTimeout(this.wsReconnectTimer)
			this.wsReconnectTimer = undefined
		}
		this.disconnectWs()
		if (this.adapterInstance && this.runtimeBot) {
			void this.adapterInstance.disconnect(this.runtimeBot)
		}
	}

	private async connectRcon(): Promise<void> {
		if (this.isConnecting || this.rcon) return
		this.isConnecting = true
		const { host, port, password, timeout } = this.config.rcon!
		try {
			logger.info(`RCON 连接中: ${host}:${port}`)
			const conn = await Rcon.connect({ host, port, password, timeout })
			this.rcon = conn
			this.isConnecting = false
			logger.info('RCON 连接成功')
			conn.on('end', () => {
				logger.warn('RCON 连接断开')
				this.rcon = undefined
				this.scheduleReconnect()
			})
			conn.on('error', (err: any) => {
				logger.warn('RCON 错误: ' + (err?.message || err))
			})
		} catch (err: any) {
			this.isConnecting = false
			logger.warn('RCON 连接失败: ' + (err?.message || err))
			this.scheduleReconnect()
		}
	}

	private scheduleReconnect() {
		const base = this.config.rcon?.reconnectInterval ?? 5000
		const strategy = this.config.rcon?.reconnectStrategy ?? 'fixed'
		const maxInterval = this.config.rcon?.maxReconnectInterval ?? 60000
		if (this.currentReconnectInterval == null) this.currentReconnectInterval = base
		const interval = strategy === 'exponential' ? Math.min(this.currentReconnectInterval * 2, maxInterval) : base
		if (!this.config.rcon?.enabled) return
		if (this.reconnectTimer) return
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = undefined
			this.currentReconnectInterval = interval
			this.ensureConnected()
		}, interval)
	}

	private ensureConnected() {
		if (this.rcon) return
		void this.connectRcon()
	}

	private disconnect() {
		if (this.rcon) {
			try { this.rcon.end(); } catch {}
			this.rcon = undefined
		}
	}

	private connectWs() {
		if (this.ws) return
		const { url, serverName, accessToken, extraHeaders } = this.config.websocket!
		logger.info('WS 连接中: ' + url)
		const headers: Record<string, string> = { 'x-self-name': serverName, ...(extraHeaders || {}) }
		if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`
		const ws = new WebSocket(url, { headers })
		this.ws = ws
		this.dlog('ws.connect', { url, headers: maskHeaders(headers) })
		ws.on('open', () => {
			logger.info('WS 连接成功')
		})
		ws.on('message', (data: WebSocket.RawData) => {
			try {
				const text = data.toString('utf8')
				this.dlog('ws.inbound', { text: truncate(text, 2000) })
				const obj = JSON.parse(text)
				const type = obj.type || obj.event || 'unknown'
				const payload = obj.data ?? obj
				const mapped = mapQueqiaoEvent(type, payload)
				this.dlog('ws.dispatch', { type: mapped.type, payload: mapped.payload })
				this.ctx.emit(`minecraft/${mapped.type}`, mapped.payload)
				// 实验性：将聊天注入 Koishi 标准消息事件，便于指令触发
				if (this.config.adapterCompat?.injectMessage === true && mapped.type === 'chat') {
					const userId = mapped.payload.player || 'player'
					const content = String(mapped.payload.message ?? '')
					const channelId = `mc:${userId}`
					const session: any = {
						platform: 'minecraft',
						selfId: this.config.websocket?.serverName || 'minecraft',
						timestamp: Date.now(),
						type: 'message',
						subtype: 'private',
						userId,
						username: userId,
						channelId,
						guildId: 'minecraft',
						content,
						// 预填必要字段，避免部分插件访问 undefined
						_messageReceived: true,
						stripped: { content, hasAt: false, prefix: '', appellative: null, interjections: [] },
						user: { id: userId, name: userId, authority: 0 },
						channel: { id: channelId, type: 1 },
					}
					this.dlog('inject.message', { session: { ...session, content: truncate(session.content, 200) } })
					this.ctx.emit('message', session)
				}
			} catch (e) {
				logger.warn('WS 处理失败: ' + (e as any)?.message)
			}
		})
		ws.on('close', () => {
			logger.warn('WS 连接断开')
			this.ws = undefined
			this.scheduleWsReconnect()
		})
		ws.on('error', (err) => {
			logger.warn('WS 错误: ' + (err as any)?.message)
		})
	}

	private disconnectWs() {
		if (this.ws) {
			try { this.ws.terminate() } catch {}
			this.ws = undefined
		}
	}

	private ensureWsConnected() {
		if (this.ws) return
		this.connectWs()
	}

	private scheduleWsReconnect() {
		const base = this.config.websocket?.reconnectInterval ?? 5000
		const strategy = this.config.websocket?.reconnectStrategy ?? 'fixed'
		const maxInterval = this.config.websocket?.maxReconnectInterval ?? 60000
		if (this.wsCurrentInterval == null) this.wsCurrentInterval = base
		const interval = strategy === 'exponential' ? Math.min(this.wsCurrentInterval * 2, maxInterval) : base
		if (!this.config.websocket?.enabled) return
		if (this.wsReconnectTimer) return
		this.wsReconnectTimer = setTimeout(() => {
			this.wsReconnectTimer = undefined
			this.wsCurrentInterval = interval
			this.ensureWsConnected()
		}, interval)
	}

	async execute(command: string): Promise<string> {
		if (!this.config.rcon?.enabled) throw new Error('RCON 未启用')
		this.ensureConnected()
		if (!this.rcon) throw new Error('RCON 未连接')
		this.dlog('rcon.execute', { command })
		const res = await this.enqueue(command)
		this.dlog('rcon.result', { command, res: truncate(res) })
		return res
	}

	async broadcast(message: string): Promise<string> {
		if (!this.config.rcon?.enabled) throw new Error('RCON 未启用')
		const mode = this.config.rcon.broadcastMode || 'say'
		if (mode === 'say') {
			return await this.execute(`say ${escapeForMc(message)}`)
		}
		// tellraw 使用简单 JSON 文本
		const json = JSON.stringify([{ text: message }])
		return await this.execute(`tellraw @a ${json}`)
	}

	async sendTo(player: string, message: string): Promise<string> {
		if (!this.config.rcon?.enabled) throw new Error('RCON 未启用')
		const json = JSON.stringify([{ text: message }])
		return await this.execute(`tellraw ${player} ${json}`)
	}

	private async enqueue(command: string): Promise<string> {
		return await new Promise<string>((resolve, reject) => {
			this.commandQueue.push({ command, resolve, reject })
			this.processQueue()
		})
	}

	// ========== WS 发送：优先 WS，不可用则回退 RCON ==========
	async wsBroadcast(message: string): Promise<string | void> {
		if (this.ws && this.config.websocket?.enabled) {
			const payload = buildWsOutboundPayload(this.config, 'broadcast', { message })
			this.dlog('ws.outbound', { api: 'broadcast', payload })
			this.ws.send(JSON.stringify(payload))
			return
		}
		return await this.broadcast(message)
	}

	async wsTell(player: string, message: string): Promise<string | void> {
		if (this.ws && this.config.websocket?.enabled) {
			const payload = buildWsOutboundPayload(this.config, 'tell', { player, message })
			this.dlog('ws.outbound', { api: 'tell', payload })
			this.ws.send(JSON.stringify(payload))
			return
		}
		return await this.sendTo(player, message)
	}

	async wsTitle(player: string, title: string, subtitle?: string): Promise<string | void> {
		if (this.ws && this.config.websocket?.enabled) {
			const payload = buildWsOutboundPayload(this.config, 'title', { player, title, subtitle })
			this.dlog('ws.outbound', { api: 'title', payload })
			this.ws.send(JSON.stringify(payload))
			return
		}
		// RCON 回退
		await this.execute(`title ${player} title ${JSON.stringify({ text: title })}`)
		if (subtitle) {
			await this.execute(`title ${player} subtitle ${JSON.stringify({ text: subtitle })}`)
		}
		return 'OK'
	}

	async wsActionbar(player: string, message: string): Promise<string | void> {
		if (this.ws && this.config.websocket?.enabled) {
			const payload = buildWsOutboundPayload(this.config, 'actionbar', { player, message })
			this.dlog('ws.outbound', { api: 'actionbar', payload })
			this.ws.send(JSON.stringify(payload))
			return
		}
		// RCON 回退
		await this.execute(`title ${player} actionbar ${JSON.stringify({ text: message })}`)
		return 'OK'
	}

	private async processQueue() {
		if (this.isProcessingQueue) return
		if (!this.rcon) return
		this.isProcessingQueue = true
		try {
			while (this.commandQueue.length && this.rcon) {
				const task = this.commandQueue.shift()!
				try {
					const result = await this.rcon.send(task.command)
					task.resolve(result)
				} catch (err) {
					task.reject(err)
				}
			}
		} finally {
			this.isProcessingQueue = false
		}
	}

	private setDebug(enabled: boolean) {
		this.debugEnabled = !!enabled
		logger.info(`[DEBUG] ${this.debugEnabled ? 'enabled' : 'disabled'}`)
	}

	private dlog(event: string, data?: any) {
		if (!this.debugEnabled) return
		try {
			logger.info(`[DEBUG] ${event} ${data ? JSON.stringify(data) : ''}`)
		} catch {
			logger.info(`[DEBUG] ${event}`)
		}
	}

	private checkCommandAllowed(command: string): boolean {
		const wl = this.config.security?.commandWhitelist || []
		const bl = this.config.security?.commandBlacklist || []
		const name = String(command).trim().split(/\s+/)[0]?.toLowerCase()
		if (!name) return false
		if (bl.includes(name)) return false
		if (wl.length > 0 && !wl.includes(name)) return false
		return true
	}

	private consumeBucket(category: string): boolean {
		const perMinute = this.config.security?.rateLimit?.perMinute ?? 30
		if (perMinute <= 0) return true
		const now = Date.now()
		const bucket = this.commandBuckets.get(category) || { count: 0, resetAt: now + 60_000 }
		if (now > bucket.resetAt) {
			bucket.count = 0
			bucket.resetAt = now + 60_000
		}
		if (bucket.count >= perMinute) return false
		bucket.count += 1
		this.commandBuckets.set(category, bucket)
		return true
	}
}

function escapeForMc(text: string): string {
	return text.replace(/[\n\r]/g, ' ').replace(/[§]/g, '')
}

namespace MinecraftService {
	export interface RconConfig {
		enabled: boolean
		host: string
		port: number
		password: string
		timeout: number
		reconnectInterval: number
		reconnectStrategy?: 'fixed' | 'exponential'
		maxReconnectInterval?: number
		broadcastMode: 'say' | 'tellraw'
	}

	export interface WebhookConfig {
		enabled: boolean
		path: string
		secret?: string
		verifyMode?: 'none' | 'header-secret' | 'hmac-sha256'
		signatureHeader?: string
		secretHeader?: string
	}

	export interface WebSocketConfig {
		enabled: boolean
		url: string
		serverName: string
		accessToken?: string
		extraHeaders?: Record<string, string>
		reconnectInterval?: number
		reconnectStrategy?: 'fixed' | 'exponential'
		maxReconnectInterval?: number
	}

	export interface Config {
		rcon?: RconConfig
		webhook?: WebhookConfig
		websocket?: WebSocketConfig
		commands?: {
			enabled?: boolean
			authority?: number
		}
		/** 调试开关：启用后打印详细日志 */
		debug?: boolean
		/** 适配器兼容选项 */
		adapterCompat?: {
			/**
			 * 将 chat 事件注入 Koishi 的 message 管线（平台 minecraft）
			 * 提供在真正的 Adapter 完成前的临时方案
			 */
			injectMessage?: boolean
		}
		/** 安全与限流设置 */
		security?: {
			commandWhitelist?: string[]
			commandBlacklist?: string[]
			rateLimit?: {
				perMinute?: number
			}
		}
		/** 正式 Adapter 设置 */
		adapter?: {
			enabled?: boolean
			selfId?: string
		}
	}

	export const Config: Schema<Config> = Schema.object({
		rcon: Schema.object({
			enabled: Schema.boolean().description('启用 RCON').default(true),
			host: Schema.string().description('RCON 主机地址').default('127.0.0.1'),
			port: Schema.number().description('RCON 端口').default(25575),
			password: Schema.string().description('RCON 密码').default(''),
			timeout: Schema.number().description('RCON 超时(ms)').default(5000),
			reconnectInterval: Schema.number().description('断线重连基础间隔(ms)').default(5000),
			reconnectStrategy: Schema.union(['fixed', 'exponential']).description('重连策略').default('fixed'),
			maxReconnectInterval: Schema.number().description('最大重连间隔(ms)，用于指数退避').default(60000),
			broadcastMode: Schema.union(['say', 'tellraw']).description('广播模式').default('say'),
		}).description('RCON 设置').default({
			enabled: true,
			host: '127.0.0.1',
			port: 25575,
			password: '',
			timeout: 5000,
			reconnectInterval: 5000,
			reconnectStrategy: 'fixed',
			maxReconnectInterval: 60000,
			broadcastMode: 'say',
		}),
		webhook: Schema.object({
			enabled: Schema.boolean().description('启用鹊桥 Webhook').default(false),
			path: Schema.string().description('Webhook 路径').default('/minecraft/webhook'),
			secret: Schema.string().role('secret').description('共享密钥（可选）'),
			verifyMode: Schema.union(['none', 'header-secret', 'hmac-sha256']).description('校验方式').default('header-secret'),
			signatureHeader: Schema.string().description('签名头(用于 HMAC)').default('x-queqiao-signature'),
			secretHeader: Schema.string().description('密钥头(用于 header-secret)').default('x-queqiao-secret'),
		}).description('Webhook 设置'),
		websocket: Schema.object({
			enabled: Schema.boolean().description('启用鹊桥 WebSocket').default(false),
			url: Schema.string().description('WebSocket 地址，如 ws://host:port').required(),
			serverName: Schema.string().description('服务器名称，需与鹊桥 config.yml 的 server_name 一致').required(),
			accessToken: Schema.string().role('secret').description('访问令牌，对应鹊桥 config.yml 的 access_token，可为空'),
			extraHeaders: Schema.dict(String).description('附加请求头，可选'),
			reconnectInterval: Schema.number().description('断线重连基础间隔(ms)').default(5000),
			reconnectStrategy: Schema.union(['fixed', 'exponential']).description('重连策略').default('fixed'),
			maxReconnectInterval: Schema.number().description('最大重连间隔(ms)').default(60000),
		}).description('WebSocket 设置'),
		commands: Schema.object({
			enabled: Schema.boolean().description('注册 Koishi 指令: mc.exec/mc.say/mc.tell').default(true),
			authority: Schema.number().description('执行这些指令所需的权限等级').default(2),
		}).description('命令设置').default({ enabled: true, authority: 2 }),
		debug: Schema.boolean().description('启用详细调试日志（仅用于排错，生产环境建议关闭）').default(false),
		adapterCompat: Schema.object({
			injectMessage: Schema.boolean().description('将 chat 事件注入 Koishi 的 message 管线（平台 minecraft）').default(false),
		}).description('适配器兼容选项').default({ injectMessage: false }),
		adapter: Schema.object({
			enabled: Schema.boolean().description('启用正式 Adapter（WsClient + Bot）').default(false),
			selfId: Schema.string().description('Bot selfId'),
		}).description('正式 Adapter 设置'),
		security: Schema.object({
			commandWhitelist: Schema.array(String).description('RCON 命令白名单（为空表示不限制）').default([]),
			commandBlacklist: Schema.array(String).description('RCON 命令黑名单（优先生效）').default([]),
			rateLimit: Schema.object({
				perMinute: Schema.number().description('每分钟最大操作数（按类别，例如 exec/say/tell/kick）').default(30),
			}),
		}).description('安全与限流设置'),
	})
}

export default MinecraftService

function verifyHmacSha256(rawBody: string, secret: string, signatureHeader: string): boolean {
	try {
		const sig = signatureHeader.replace(/^sha256=/i, '')
		// 延迟引入 crypto，避免浏览器侧打包
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const crypto = require('crypto') as typeof import('crypto')
		const h = crypto.createHmac('sha256', secret).update(rawBody).digest('hex')
		return timingSafeEqual(h, sig)
	} catch {
		return false
	}
}

function timingSafeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false
	let r = 0
	for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i)
	return r === 0
}

function mapQueqiaoEvent(type: string, data: any): { type: string; payload: any } {
	// 兼容常见事件名，向 Koishi 事件命名空间收敛
	switch (type) {
		case 'chat':
		case 'player_chat':
			return { type: 'chat', payload: { player: data.player || data.name, message: data.message || data.text, raw: data } }
		case 'join':
		case 'player_join':
			return { type: 'join', payload: { player: data.player || data.name, raw: data } }
		case 'leave':
		case 'quit':
		case 'player_quit':
			return { type: 'leave', payload: { player: data.player || data.name, reason: data.reason, raw: data } }
		case 'death':
			return { type: 'death', payload: { player: data.player || data.name, message: data.message || data.reason, raw: data } }
		case 'advancement':
		case 'advancement_earned':
			return { type: 'advancement', payload: { player: data.player || data.name, advancement: data.advancement || data.key, raw: data } }
	}

	// 回退：QueQiao 标准格式
	if (data?.post_type === 'message') {
		if (data.sub_type === 'chat' || data.event_name?.toLowerCase()?.includes('chatevent')) {
			const playerName = data.player?.nickname || data.player?.name || data.player?.display_name || data.name
			return { type: 'chat', payload: { player: playerName, message: data.message || data.text, raw: data } }
		}
	}
	if (data?.post_type === 'notice') {
		if (data.sub_type === 'join' || data.event_name?.toLowerCase()?.includes('loggedinevent')) {
			const playerName = data.player?.nickname || data.player?.name || data.player?.display_name || data.name
			return { type: 'join', payload: { player: playerName, raw: data } }
		}
		if (data.sub_type === 'quit' || data.event_name?.toLowerCase()?.includes('loggedoutevent')) {
			const playerName = data.player?.nickname || data.player?.name || data.player?.display_name || data.name
			return { type: 'leave', payload: { player: playerName, raw: data } }
		}
		if (data.sub_type === 'achievement' || data.event_name?.toLowerCase()?.includes('advancement')) {
			const playerName = data.player?.nickname || data.player?.name || data.player?.display_name || data.name
			return { type: 'advancement', payload: { player: playerName, advancement: data.advancement?.name || data.advancement?.key, raw: data } }
		}
	}

	return { type, payload: data }
}

function buildWsOutboundPayload(config: MinecraftService.Config, api: 'broadcast' | 'tell' | 'title' | 'actionbar', data: any) {
	// 参考 QueQiao 的 WS 入站接口语义，采用 { api, data } 基本结构
	return { api, data }
}

function maskHeaders(headers: Record<string, any>) {
	const clone: Record<string, any> = { ...headers }
	for (const k of Object.keys(clone)) {
		const key = k.toLowerCase()
		if (key.includes('authorization') || key.includes('token') || key.includes('secret')) clone[k] = '***'
	}
	return clone
}

function truncate(str: string, len = 1000) {
	if (!str) return str
	return str.length > len ? str.slice(0, len) + '…' : str
}

// 极简 Bot：用于让 session.bot 存在，避免 Koishi Processor 报错
class MinecraftBot extends Bot {
	constructor(ctx: Context, public readonly config: { selfId: string }, private readonly svc: MinecraftService) {
		super(
			ctx,
			{
				platform: 'minecraft',
				selfId: config.selfId,
			},
			{} as any,
		)
	}

	async sendMessage(channelId: string, content: string) {
		await this.svc.wsBroadcast(content)
		return []
	}

	async sendPrivateMessage(userId: string, content: string) {
		await this.svc.wsTell(userId, content)
		return []
	}
}

class DummyAdapter extends Adapter {
	constructor(ctx: Context) {
		super(ctx)
	}

	async connect() {}
	async disconnect() {}
}

// 简化版正式 Adapter：直接使用现有的 WS 连接回调，转发为标准消息
class MinecraftAdapter extends Adapter {
	private bound = false
	constructor(ctx: Context, private readonly svc: MinecraftService) {
		super(ctx)
	}

	async connect(bot: MinecraftBot) {
		// 不再重复主动连接 WS，依赖外层 ensureWsConnected
		if (!this.bound) {
			(this.svc.ctx as any).on('minecraft/chat', ({ player, message }: any) => {
				(this.svc as any).dlog?.('adapter.forward.chat', { player, message })
				const content = String(message ?? '')
				void bot.dispatch({
					type: 'message',
					subtype: 'private',
					userId: player,
					channelId: `mc:${player}`,
					guildId: 'minecraft',
					content,
				} as any)
			})
			this.bound = true
		}
		(this.svc as any).dlog?.('adapter.connect', { selfId: bot.config.selfId })
		bot.online()
	}

	async disconnect(bot: MinecraftBot) {
		(this.svc as any).dlog?.('adapter.disconnect', { selfId: bot.config.selfId })
		bot.offline()
	}
}


