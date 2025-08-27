"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.MinecraftAdapter = exports.MinecraftBot = void 0;
const koishi_1 = require("koishi");
const rcon_client_1 = require("rcon-client");
const ws_1 = __importDefault(require("ws"));
const logger = new koishi_1.Logger('minecraft');
class MinecraftBot extends koishi_1.Bot {
    rcon;
    ws;
    constructor(ctx, config) {
        super(ctx, config, 'minecraft');
        this.selfId = config.selfId;
    }
    async sendMessage(channelId, content) {
        if (channelId.startsWith('mc:')) {
            const player = channelId.slice(3);
            return await this.sendPrivateMessage(player, content);
        }
        else {
            if (this.adapter instanceof MinecraftAdapter) {
                await this.adapter.broadcast(content);
                return [];
            }
            return [];
        }
    }
    async sendPrivateMessage(userId, content) {
        if (this.adapter instanceof MinecraftAdapter) {
            await this.adapter.sendPrivateMessage(userId, content);
            return [];
        }
        return [];
    }
    async executeCommand(command) {
        if (!this.rcon)
            throw new Error('RCON not connected');
        return await this.rcon.send(command);
    }
}
exports.MinecraftBot = MinecraftBot;
class MinecraftAdapter extends koishi_1.Adapter {
    rconConnections = new Map();
    wsConnections = new Map();
    reconnectAttempts = new Map();
    debug;
    reconnectInterval;
    maxReconnectAttempts;
    constructor(ctx, config) {
        super(ctx);
        this.debug = config.debug ?? false;
        this.reconnectInterval = config.reconnectInterval ?? 5000;
        this.maxReconnectAttempts = config.maxReconnectAttempts ?? 10;
        if (this.debug) {
            logger.info(`[DEBUG] MinecraftAdapter initialized with config:`, {
                debug: this.debug,
                reconnectInterval: this.reconnectInterval,
                maxReconnectAttempts: this.maxReconnectAttempts,
                botCount: config.bots.length
            });
        }
        // 为每个配置创建机器人
        ctx.on('ready', async () => {
            if (this.debug) {
                logger.info(`[DEBUG] Koishi ready event triggered, initializing ${config.bots.length} bots`);
            }
            for (const botConfig of config.bots) {
                if (this.debug) {
                    logger.info(`[DEBUG] Initializing bot ${botConfig.selfId}`);
                }
                const bot = new MinecraftBot(ctx, botConfig);
                bot.adapter = this;
                this.bots.push(bot);
                // 初始化 RCON 连接
                if (botConfig.rcon) {
                    try {
                        if (this.debug) {
                            logger.info(`[DEBUG] Connecting RCON for bot ${botConfig.selfId} to ${botConfig.rcon.host}:${botConfig.rcon.port}`);
                        }
                        const rcon = await rcon_client_1.Rcon.connect({
                            host: botConfig.rcon.host,
                            port: botConfig.rcon.port,
                            password: botConfig.rcon.password,
                            timeout: botConfig.rcon.timeout || 5000,
                        });
                        this.rconConnections.set(botConfig.selfId, rcon);
                        bot.rcon = rcon;
                        logger.info(`RCON connected for bot ${botConfig.selfId}`);
                    }
                    catch (error) {
                        logger.warn(`Failed to connect RCON for bot ${botConfig.selfId}:`, error);
                        if (this.debug) {
                            logger.info(`[DEBUG] RCON connection error details:`, error.message, error.stack);
                        }
                    }
                }
                else {
                    if (this.debug) {
                        logger.info(`[DEBUG] No RCON config for bot ${botConfig.selfId}`);
                    }
                }
                // 初始化 WebSocket 连接
                if (botConfig.websocket) {
                    if (this.debug) {
                        logger.info(`[DEBUG] Initializing WebSocket for bot ${botConfig.selfId}`);
                    }
                    await this.connectWebSocket(bot, botConfig.websocket);
                }
                else {
                    if (this.debug) {
                        logger.info(`[DEBUG] No WebSocket config for bot ${botConfig.selfId}`);
                    }
                }
            }
        });
    }
    getWebSocketCloseCode(code) {
        const codes = {
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
        };
        return codes[code] || `Unknown Code ${code}`;
    }
    getWebSocketStateString(state) {
        const states = {
            0: 'CONNECTING',
            1: 'OPEN',
            2: 'CLOSING',
            3: 'CLOSED'
        };
        return states[state] || `UNKNOWN(${state})`;
    }
    async connectWebSocket(bot, wsConfig) {
        const headers = {
            'x-self-name': bot.config.serverName || bot.selfId,
            ...(wsConfig.extraHeaders || {}),
        };
        if (wsConfig.accessToken) {
            headers['Authorization'] = `Bearer ${wsConfig.accessToken}`;
        }
        if (this.debug) {
            logger.info(`[DEBUG] Connecting to WebSocket: ${wsConfig.url}`);
            logger.info(`[DEBUG] Headers:`, headers);
        }
        const ws = new ws_1.default(wsConfig.url, { headers });
        this.wsConnections.set(bot.selfId, ws);
        bot.ws = ws;
        // 添加连接状态监控
        const connectionMonitor = setInterval(() => {
            if (this.debug) {
                logger.info(`[DEBUG] WebSocket state for bot ${bot.selfId}: ${ws.readyState} (${this.getWebSocketStateString(ws.readyState)})`);
            }
        }, 10000); // 每10秒检查一次状态
        // 添加心跳检测
        let heartbeatInterval = null;
        const startHeartbeat = () => {
            if (heartbeatInterval)
                clearInterval(heartbeatInterval);
            heartbeatInterval = setInterval(() => {
                if (ws.readyState === ws_1.default.OPEN) {
                    if (this.debug) {
                        logger.info(`[DEBUG] Sending heartbeat ping for bot ${bot.selfId}`);
                    }
                    ws.ping();
                }
            }, 30000); // 每30秒发送一次心跳
        };
        // 添加连接超时处理
        const connectionTimeout = setTimeout(() => {
            if (ws.readyState === ws_1.default.CONNECTING) {
                if (this.debug) {
                    logger.info(`[DEBUG] WebSocket connection timeout for bot ${bot.selfId}`);
                }
                ws.close();
            }
        }, 10000); // 10秒超时
        ws.on('open', () => {
            logger.info(`WebSocket connected for bot ${bot.selfId}`);
            if (this.debug) {
                logger.info(`[DEBUG] WebSocket opened successfully for bot ${bot.selfId}`);
                logger.info(`[DEBUG] WebSocket protocol: ${ws.protocol}`);
                logger.info(`[DEBUG] WebSocket extensions: ${ws.extensions}`);
            }
            // 重置重连尝试次数
            this.reconnectAttempts.set(bot.selfId, 0);
            bot.online();
            clearTimeout(connectionTimeout);
            startHeartbeat();
        });
        ws.on('message', (data) => {
            try {
                const text = data.toString('utf8');
                if (this.debug) {
                    logger.info(`[DEBUG] Received WebSocket message for bot ${bot.selfId}:`, text);
                    logger.info(`[DEBUG] Message length: ${text.length} characters`);
                }
                const obj = JSON.parse(text);
                const type = obj.type || obj.event || 'unknown';
                const payload = obj.data ?? obj;
                if (this.debug) {
                    logger.info(`[DEBUG] Parsed message type: ${type}, payload:`, payload);
                }
                const session = this.createSession(bot, type, payload);
                if (session) {
                    if (this.debug) {
                        logger.info(`[DEBUG] Created session:`, session);
                        logger.info(`[DEBUG] Dispatching session to bot ${bot.selfId}`);
                    }
                    bot.dispatch(session);
                    if (this.debug) {
                        logger.info(`[DEBUG] Session dispatched successfully`);
                    }
                }
                else {
                    if (this.debug) {
                        logger.info(`[DEBUG] No session created for message type: ${type}`);
                    }
                }
            }
            catch (error) {
                logger.warn('Failed to process WebSocket message:', error);
                if (this.debug) {
                    logger.info(`[DEBUG] Raw message data:`, data.toString('utf8'));
                    logger.info(`[DEBUG] Parse error:`, error.message, error.stack);
                }
            }
        });
        ws.on('close', (code, reason) => {
            logger.warn(`WebSocket disconnected for bot ${bot.selfId} (code: ${code}, reason: ${reason.toString()})`);
            if (this.debug) {
                logger.info(`[DEBUG] Close code details:`, this.getWebSocketCloseCode(code));
                logger.info(`[DEBUG] Close reason:`, reason.toString());
            }
            bot.offline();
            // 清理心跳和监控
            if (heartbeatInterval) {
                clearInterval(heartbeatInterval);
                heartbeatInterval = null;
            }
            clearInterval(connectionMonitor);
            const attempts = this.reconnectAttempts.get(bot.selfId) || 0;
            if (attempts < this.maxReconnectAttempts) {
                this.reconnectAttempts.set(bot.selfId, attempts + 1);
                const delay = this.reconnectInterval * Math.pow(2, attempts); // 指数退避
                if (this.debug) {
                    logger.info(`[DEBUG] Attempting to reconnect WebSocket for bot ${bot.selfId} in ${delay}ms (attempt ${attempts + 1}/${this.maxReconnectAttempts})`);
                }
                setTimeout(() => {
                    if (!this.wsConnections.has(bot.selfId)) {
                        this.connectWebSocket(bot, wsConfig);
                    }
                }, delay);
            }
            else {
                logger.error(`Max reconnect attempts reached for bot ${bot.selfId}`);
            }
        });
        ws.on('error', (error) => {
            logger.warn(`WebSocket error for bot ${bot.selfId}:`, error);
            if (this.debug) {
                logger.info(`[DEBUG] WebSocket error details:`, error.message, error.stack);
            }
        });
        ws.on('ping', () => {
            if (this.debug) {
                logger.info(`[DEBUG] Received ping from server for bot ${bot.selfId}`);
            }
        });
        ws.on('pong', () => {
            if (this.debug) {
                logger.info(`[DEBUG] Received pong from server for bot ${bot.selfId}`);
            }
        });
    }
    createSession(bot, type, payload) {
        if (this.debug) {
            logger.info(`[DEBUG] Creating session for event type: ${type}, payload:`, payload);
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
                };
            case 'join':
            case 'player_join':
                return {
                    type: 'guild-member-added',
                    platform: 'minecraft',
                    selfId: bot.selfId,
                    userId: payload.player || payload.name || 'unknown',
                    guildId: 'minecraft',
                    timestamp: Date.now(),
                };
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
                };
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
                };
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
                };
            default:
                // 自定义事件可以通过其他方式处理
                if (this.debug) {
                    logger.info(`[DEBUG] Unhandled event type: ${type}, payload:`, payload);
                }
                logger.debug(`Unhandled event type: ${type}`, payload);
                return undefined;
        }
    }
    async sendPrivateMessage(player, message) {
        if (this.debug) {
            logger.info(`[DEBUG] Sending private message to player ${player}: ${message}`);
        }
        // 优先使用 WebSocket 发送
        for (const [botId, ws] of this.wsConnections) {
            if (ws.readyState === ws_1.default.OPEN) {
                const payload = {
                    api: 'tell',
                    data: { player, message }
                };
                if (this.debug) {
                    logger.info(`[DEBUG] Sending via WebSocket:`, payload);
                }
                ws.send(JSON.stringify(payload));
                return;
            }
        }
        // 回退到 RCON
        for (const [botId, rcon] of this.rconConnections) {
            try {
                const json = JSON.stringify([{ text: message }]);
                if (this.debug) {
                    logger.info(`[DEBUG] Sending via RCON: tellraw ${player} ${json}`);
                }
                await rcon.send(`tellraw ${player} ${json}`);
                return;
            }
            catch (error) {
                logger.warn(`Failed to send message via RCON for bot ${botId}:`, error);
            }
        }
        throw new Error('No available connection to send message');
    }
    async broadcast(message) {
        if (this.debug) {
            logger.info(`[DEBUG] Broadcasting message: ${message}`);
        }
        // 优先使用 WebSocket 发送
        for (const [botId, ws] of this.wsConnections) {
            if (ws.readyState === ws_1.default.OPEN) {
                const payload = {
                    api: 'broadcast',
                    data: { message }
                };
                if (this.debug) {
                    logger.info(`[DEBUG] Broadcasting via WebSocket:`, payload);
                }
                ws.send(JSON.stringify(payload));
                return;
            }
        }
        // 回退到 RCON
        for (const [botId, rcon] of this.rconConnections) {
            try {
                if (this.debug) {
                    logger.info(`[DEBUG] Broadcasting via RCON: say ${message}`);
                }
                await rcon.send(`say ${message}`);
                return;
            }
            catch (error) {
                logger.warn(`Failed to broadcast via RCON for bot ${botId}:`, error);
            }
        }
        throw new Error('No available connection to broadcast message');
    }
    async stop() {
        if (this.debug) {
            logger.info(`[DEBUG] Stopping MinecraftAdapter`);
        }
        for (const [botId, ws] of this.wsConnections) {
            try {
                ws.close();
            }
            catch (error) {
                logger.warn(`Failed to close WebSocket for bot ${botId}:`, error);
            }
        }
        this.wsConnections.clear();
        for (const [botId, rcon] of this.rconConnections) {
            try {
                rcon.end();
            }
            catch (error) {
                logger.warn(`Failed to close RCON for bot ${botId}:`, error);
            }
        }
        this.rconConnections.clear();
    }
}
exports.MinecraftAdapter = MinecraftAdapter;
(function (MinecraftAdapter) {
    MinecraftAdapter.Config = koishi_1.Schema.object({
        debug: koishi_1.Schema.boolean().description('启用调试模式，输出详细日志').default(false),
        reconnectInterval: koishi_1.Schema.number().description('重连间隔时间(ms)').default(5000),
        maxReconnectAttempts: koishi_1.Schema.number().description('最大重连尝试次数').default(10),
        bots: koishi_1.Schema.array(koishi_1.Schema.object({
            selfId: koishi_1.Schema.string().description('机器人 ID').required(),
            serverName: koishi_1.Schema.string().description('服务器名称'),
            rcon: koishi_1.Schema.object({
                host: koishi_1.Schema.string().description('RCON 主机地址').default('127.0.0.1'),
                port: koishi_1.Schema.number().description('RCON 端口').default(25575),
                password: koishi_1.Schema.string().description('RCON 密码').required(),
                timeout: koishi_1.Schema.number().description('RCON 超时时间(ms)').default(5000),
            }).description('RCON 配置'),
            websocket: koishi_1.Schema.object({
                url: koishi_1.Schema.string().description('WebSocket 地址').required(),
                accessToken: koishi_1.Schema.string().description('访问令牌'),
                extraHeaders: koishi_1.Schema.dict(koishi_1.Schema.string()).description('额外请求头'),
            }).description('WebSocket 配置'),
        })).description('机器人配置列表').default([]),
    });
})(MinecraftAdapter || (exports.MinecraftAdapter = MinecraftAdapter = {}));
exports.default = MinecraftAdapter;
