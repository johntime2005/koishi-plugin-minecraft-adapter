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
        this.platform = 'minecraft';
    }
    /**
     * 发送消息到频道或私聊
     */
    async sendMessage(channelId, content) {
        if (channelId.startsWith('private:')) {
            const player = channelId.slice(8);
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
    /**
     * 发送私聊消息
     */
    async sendPrivateMessage(userId, content) {
        if (this.adapter instanceof MinecraftAdapter) {
            await this.adapter.sendPrivateMessage(userId, content);
            return [];
        }
        return [];
    }
    /**
     * 执行 RCON 命令
     * 优先使用 WebSocket send_rcon_command 接口，回退到直接 RCON 连接
     */
    async executeCommand(command) {
        if (this.adapter instanceof MinecraftAdapter) {
            return await this.adapter.executeRconCommand(command);
        }
        if (!this.rcon)
            throw new Error('RCON not connected');
        return await this.rcon.send(command);
    }
}
exports.MinecraftBot = MinecraftBot;
class MinecraftAdapter extends koishi_1.Adapter {
    static reusable = true;
    rconConnections = new Map();
    wsConnections = new Map();
    reconnectAttempts = new Map();
    pendingRequests = new Map();
    requestCounter = 0;
    debug;
    detailedLogging;
    tokenizeMode;
    reconnectInterval;
    maxReconnectAttempts;
    useMessagePrefix;
    constructor(ctx, config) {
        super(ctx);
        try {
            this.debug = config.debug ?? false;
            this.detailedLogging = config.detailedLogging ?? false;
            this.tokenizeMode = config.tokenizeMode ?? 'split';
            this.reconnectInterval = config.reconnectInterval ?? 5000;
            this.maxReconnectAttempts = config.maxReconnectAttempts ?? 10;
            this.useMessagePrefix = config.useMessagePrefix ?? false;
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
                    if (botConfig.rcon && botConfig.rcon.host && botConfig.rcon.port && botConfig.rcon.password) {
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
                            if (botConfig.rcon) {
                                logger.info(`[DEBUG] RCON config incomplete for bot ${botConfig.selfId}, skipping (need host, port, password)`);
                            }
                            else {
                                logger.info(`[DEBUG] No RCON config for bot ${botConfig.selfId}`);
                            }
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
        catch (err) {
            logger.error('MinecraftAdapter initialization failed:', err);
            throw err;
        }
    }
    /**
     * 生成唯一的请求 ID
     */
    generateEcho() {
        return `koishi_${Date.now()}_${++this.requestCounter}`;
    }
    /**
     * 将消息转换为 Minecraft 文本组件格式
     */
    toTextComponent(message) {
        const extractText = (item) => {
            if (item == null)
                return '';
            if (typeof item === 'string')
                return item;
            if (typeof item === 'number' || typeof item === 'boolean')
                return String(item);
            if (Array.isArray(item))
                return item.map(extractText).join('');
            if (typeof item === 'object') {
                if (item.attrs && typeof item.attrs.content === 'string')
                    return item.attrs.content;
                if (typeof item.content === 'string')
                    return item.content;
                if (typeof item.text === 'string')
                    return item.text;
                if (item.children)
                    return extractText(item.children);
                try {
                    if (typeof item.toString === 'function' && item.toString !== Object.prototype.toString) {
                        const s = item.toString();
                        if (typeof s === 'string' && s !== '[object Object]')
                            return s;
                    }
                }
                catch (e) {
                    // ignore
                }
                let acc = '';
                for (const key in item) {
                    try {
                        acc += extractText(item[key]);
                    }
                    catch (e) {
                        // ignore
                    }
                }
                return acc;
            }
            return String(item);
        };
        const text = extractText(message);
        return [{ text }];
    }
    /**
     * 发送 WebSocket API 请求并等待响应
     */
    async sendApiRequest(ws, api, data, timeout = 10000) {
        return new Promise((resolve, reject) => {
            const echo = this.generateEcho();
            const request = { api, data, echo };
            const timeoutId = setTimeout(() => {
                this.pendingRequests.delete(echo);
                reject(new Error(`API request timeout: ${api}`));
            }, timeout);
            this.pendingRequests.set(echo, { resolve, reject, timeout: timeoutId });
            if (this.debug) {
                logger.info(`[DEBUG] Sending API request:`, request);
            }
            ws.send(JSON.stringify(request));
        });
    }
    /**
     * 处理 API 响应
     */
    handleApiResponse(response) {
        if (response.echo && this.pendingRequests.has(String(response.echo))) {
            const pending = this.pendingRequests.get(String(response.echo));
            clearTimeout(pending.timeout);
            this.pendingRequests.delete(String(response.echo));
            if (response.status === 'SUCCESS') {
                pending.resolve(response);
            }
            else {
                pending.reject(new Error(response.message || 'API request failed'));
            }
        }
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
        });
        ws.on('message', (data) => {
            try {
                const text = data.toString('utf8');
                if (this.debug) {
                    logger.info(`[DEBUG] Received WebSocket message for bot ${bot.selfId}:`, text);
                    logger.info(`[DEBUG] Message length: ${text.length} characters`);
                }
                const obj = JSON.parse(text);
                // 检查是否是 API 响应
                if (obj.post_type === 'response') {
                    this.handleApiResponse(obj);
                    return;
                }
                // 处理事件
                const event = obj;
                const session = this.createSession(bot, event);
                if (session) {
                    if (this.debug) {
                        logger.info(`[DEBUG] Created session for event: ${event.event_name}`);
                    }
                    if (this.detailedLogging) {
                        try {
                            const snapshot = {
                                sessionId: session.id,
                                content: session.content,
                                elements: session.event?.message?.elements,
                                eventMessage: session.event?.message,
                                user: session.event?.user,
                                userId: session.userId || session.event?.user?.id,
                                guildId: session.guildId || session.event?.guild?.id,
                                channelId: session.channelId || session.event?.channel?.id,
                            };
                            logger.info(`[DETAILED] Pre-dispatch session snapshot for bot ${bot.selfId}:`, snapshot);
                        }
                        catch (e) {
                            logger.warn(`[DETAILED] Failed to capture pre-dispatch session snapshot:`, e);
                        }
                    }
                    try {
                        bot.dispatch(session);
                        if (this.debug)
                            logger.info(`[DEBUG] Session dispatched successfully to bot ${bot.selfId}`);
                    }
                    catch (err) {
                        logger.warn(`Dispatch threw an error for bot ${bot.selfId}:`, err);
                        if (this.debug) {
                            logger.info(`[DEBUG] Dispatch error stack:`, err?.stack || err);
                        }
                    }
                }
                else {
                    if (this.debug) {
                        logger.info(`[DEBUG] No session created for event: ${event.event_name}`);
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
            const attempts = this.reconnectAttempts.get(bot.selfId) || 0;
            if (attempts < this.maxReconnectAttempts) {
                this.reconnectAttempts.set(bot.selfId, attempts + 1);
                const delay = this.reconnectInterval * Math.pow(2, attempts); // 指数退避
                if (this.debug) {
                    logger.info(`[DEBUG] Attempting to reconnect WebSocket for bot ${bot.selfId} in ${delay}ms (attempt ${attempts + 1}/${this.maxReconnectAttempts})`);
                }
                setTimeout(() => {
                    if (this.wsConnections.get(bot.selfId)?.readyState !== ws_1.default.OPEN) {
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
    }
    sessionCounter = 0;
    /**
     * 根据鹊桥 V2 事件创建 Koishi Session
     */
    createSession(bot, payload) {
        if (this.debug) {
            logger.info(`[DEBUG] Creating session for event: ${payload.event_name}, payload:`, payload);
        }
        const event = {
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
        };
        switch (payload.event_name) {
            // 玩家聊天事件
            case 'PlayerChatEvent': {
                const chatEvent = payload;
                const player = chatEvent.player;
                const userId = player.uuid || player.nickname;
                const username = player.nickname;
                event.type = 'message';
                event.user = {
                    id: userId,
                    name: username,
                    nick: username,
                    isOp: player.is_op,
                };
                event.channel = {
                    id: chatEvent.server_name || 'minecraft',
                    type: 0, // TEXT
                };
                event.guild = {
                    id: chatEvent.server_name || 'minecraft',
                    name: chatEvent.server_name || 'Minecraft Server',
                };
                // 解析消息
                const messageText = chatEvent.message || '';
                const elements = this.parseMessageToElements(messageText);
                event.message = {
                    id: chatEvent.message_id || Date.now().toString(),
                    content: messageText,
                    timestamp: payload.timestamp * 1000,
                    user: event.user,
                    elements,
                    createdAt: payload.timestamp * 1000,
                    updatedAt: payload.timestamp * 1000,
                };
                break;
            }
            // 玩家命令事件
            case 'PlayerCommandEvent': {
                const cmdEvent = payload;
                const player = cmdEvent.player;
                const userId = player.uuid || player.nickname;
                const username = player.nickname;
                event.type = 'message';
                event.user = {
                    id: userId,
                    name: username,
                    nick: username,
                    isOp: player.is_op,
                };
                event.channel = {
                    id: cmdEvent.server_name || 'minecraft',
                    type: 0,
                };
                event.guild = {
                    id: cmdEvent.server_name || 'minecraft',
                    name: cmdEvent.server_name || 'Minecraft Server',
                };
                // 命令消息
                const commandText = cmdEvent.command || '';
                const elements = this.parseMessageToElements(commandText);
                event.message = {
                    id: cmdEvent.message_id || Date.now().toString(),
                    content: commandText,
                    timestamp: payload.timestamp * 1000,
                    user: event.user,
                    elements,
                    createdAt: payload.timestamp * 1000,
                    updatedAt: payload.timestamp * 1000,
                };
                // 标记为命令事件
                event.subtype = 'command';
                break;
            }
            // 玩家加入事件
            case 'PlayerJoinEvent': {
                const joinEvent = payload;
                const player = joinEvent.player;
                const userId = player.uuid || player.nickname;
                event.type = 'guild-member-added';
                event.user = {
                    id: userId,
                    name: player.nickname,
                    nick: player.nickname,
                    isOp: player.is_op,
                };
                event.guild = {
                    id: joinEvent.server_name || 'minecraft',
                    name: joinEvent.server_name || 'Minecraft Server',
                };
                event.member = {
                    user: event.user,
                    nick: player.nickname,
                    joinedAt: payload.timestamp * 1000,
                };
                break;
            }
            // 玩家离开事件
            case 'PlayerQuitEvent': {
                const quitEvent = payload;
                const player = quitEvent.player;
                const userId = player.uuid || player.nickname;
                event.type = 'guild-member-removed';
                event.user = {
                    id: userId,
                    name: player.nickname,
                    nick: player.nickname,
                    isOp: player.is_op,
                };
                event.guild = {
                    id: quitEvent.server_name || 'minecraft',
                    name: quitEvent.server_name || 'Minecraft Server',
                };
                event.member = {
                    user: event.user,
                    nick: player.nickname,
                };
                break;
            }
            // 玩家死亡事件
            case 'PlayerDeathEvent': {
                const deathEvent = payload;
                const player = deathEvent.player;
                const userId = player.uuid || player.nickname;
                event.type = 'notice';
                event.subtype = 'player-death';
                event.user = {
                    id: userId,
                    name: player.nickname,
                    nick: player.nickname,
                    isOp: player.is_op,
                };
                event.guild = {
                    id: deathEvent.server_name || 'minecraft',
                    name: deathEvent.server_name || 'Minecraft Server',
                };
                // 从 death 对象提取死亡消息
                const deathText = deathEvent.death?.text || '';
                if (deathText) {
                    event.message = {
                        id: Date.now().toString(),
                        content: deathText,
                        timestamp: payload.timestamp * 1000,
                    };
                }
                break;
            }
            // 玩家成就事件
            case 'PlayerAchievementEvent': {
                const achieveEvent = payload;
                const player = achieveEvent.player;
                const userId = player.uuid || player.nickname;
                event.type = 'notice';
                event.subtype = 'player-achievement';
                event.user = {
                    id: userId,
                    name: player.nickname,
                    nick: player.nickname,
                    isOp: player.is_op,
                };
                event.guild = {
                    id: achieveEvent.server_name || 'minecraft',
                    name: achieveEvent.server_name || 'Minecraft Server',
                };
                // 从 achievement 对象提取成就信息
                const achievementText = achieveEvent.achievement?.display?.title
                    || achieveEvent.achievement?.text
                    || '';
                if (achievementText) {
                    event.message = {
                        id: Date.now().toString(),
                        content: achievementText,
                        timestamp: payload.timestamp * 1000,
                    };
                }
                break;
            }
            default:
                if (this.debug) {
                    logger.info(`[DEBUG] Unhandled event type: ${payload.event_name}`);
                }
                return undefined;
        }
        // 添加兼容性字段
        try {
            const channelId = event.channel?.id || event.guild?.id || 'minecraft';
            const roomId = `minecraft:${channelId}`;
            event.room = { id: roomId };
            event.context = event.context || {};
            event.context.options = { ...(event.context.options || {}), room: roomId };
            if (event.channel)
                event.channel.altId = roomId;
        }
        catch (e) {
            if (this.debug)
                logger.warn('[DEBUG] Failed to add compatibility fields:', e);
        }
        return bot.session(event);
    }
    /**
     * 解析消息文本为 Koishi 元素数组
     */
    parseMessageToElements(messageText) {
        if (!messageText)
            return [];
        const tokens = this.tokenizeMode === 'none'
            ? [messageText]
            : messageText.split(/(\s+)/).filter((s) => s.length > 0);
        return tokens.map((token) => {
            const el = { type: 'text', attrs: { content: token } };
            el.toString = function () {
                return this.attrs?.content ?? '';
            };
            return el;
        });
    }
    /**
     * 发送私聊消息 (send_private_msg)
     */
    async sendPrivateMessage(player, message) {
        if (this.debug) {
            logger.info(`[DEBUG] Sending private message to player ${player}: ${message}`);
        }
        const messageComponent = this.toTextComponent(message);
        // 优先使用 WebSocket 发送
        for (const [botId, ws] of this.wsConnections) {
            if (ws.readyState === ws_1.default.OPEN) {
                try {
                    // 鹊桥 V2 API: send_private_msg
                    // 参数: uuid 或 nickname (至少一个), message (Minecraft 文本组件)
                    const response = await this.sendApiRequest(ws, 'send_private_msg', {
                        nickname: player, // 优先使用 nickname
                        message: messageComponent
                    });
                    if (this.debug) {
                        logger.info(`[DEBUG] Private message sent successfully:`, response);
                    }
                    return;
                }
                catch (error) {
                    logger.warn(`Failed to send private message via WebSocket for bot ${botId}:`, error);
                }
            }
        }
        // 回退到 RCON
        for (const [botId, rcon] of this.rconConnections) {
            try {
                const json = JSON.stringify(messageComponent);
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
    /**
     * 广播消息 (broadcast)
     */
    async broadcast(message) {
        if (this.debug) {
            logger.info(`[DEBUG] Broadcasting message: ${message}`);
        }
        const messageComponent = this.toTextComponent(message);
        // 优先使用 WebSocket 发送
        for (const [botId, ws] of this.wsConnections) {
            if (ws.readyState === ws_1.default.OPEN) {
                try {
                    // 鹊桥 V2 API: broadcast
                    // 参数: message (Minecraft 文本组件)
                    const response = await this.sendApiRequest(ws, 'broadcast', {
                        message: messageComponent
                    });
                    if (this.debug) {
                        logger.info(`[DEBUG] Broadcast sent successfully:`, response);
                    }
                    return;
                }
                catch (error) {
                    logger.warn(`Failed to broadcast via WebSocket for bot ${botId}:`, error);
                }
            }
        }
        // 回退到 RCON
        for (const [botId, rcon] of this.rconConnections) {
            try {
                const text = typeof message === 'string' ? message : JSON.stringify(message);
                if (this.debug) {
                    logger.info(`[DEBUG] Broadcasting via RCON: say ${text}`);
                }
                await rcon.send(`say ${text}`);
                return;
            }
            catch (error) {
                logger.warn(`Failed to broadcast via RCON for bot ${botId}:`, error);
            }
        }
        throw new Error('No available connection to broadcast message');
    }
    /**
     * 执行 RCON 命令 (send_rcon_command)
     */
    async executeRconCommand(command) {
        if (this.debug) {
            logger.info(`[DEBUG] Executing RCON command: ${command}`);
        }
        // 优先使用 WebSocket 发送
        for (const [botId, ws] of this.wsConnections) {
            if (ws.readyState === ws_1.default.OPEN) {
                try {
                    // 鹊桥 V2 API: send_rcon_command
                    // 参数: command
                    const response = await this.sendApiRequest(ws, 'send_rcon_command', {
                        command
                    });
                    if (this.debug) {
                        logger.info(`[DEBUG] RCON command executed successfully:`, response);
                    }
                    return response.data || '';
                }
                catch (error) {
                    logger.warn(`Failed to execute RCON command via WebSocket for bot ${botId}:`, error);
                }
            }
        }
        // 回退到直接 RCON
        for (const [botId, rcon] of this.rconConnections) {
            try {
                if (this.debug) {
                    logger.info(`[DEBUG] Executing via direct RCON: ${command}`);
                }
                return await rcon.send(command);
            }
            catch (error) {
                logger.warn(`Failed to execute RCON command for bot ${botId}:`, error);
            }
        }
        throw new Error('No available connection to execute RCON command');
    }
    /**
     * 发送标题消息 (title)
     */
    async sendTitle(title, subtitle, player) {
        const titleComponent = typeof title === 'string' ? { text: title } : title;
        const subtitleComponent = subtitle ? (typeof subtitle === 'string' ? { text: subtitle } : subtitle) : undefined;
        for (const [botId, ws] of this.wsConnections) {
            if (ws.readyState === ws_1.default.OPEN) {
                try {
                    const data = { title: titleComponent };
                    if (subtitleComponent)
                        data.subtitle = subtitleComponent;
                    if (player)
                        data.nickname = player;
                    await this.sendApiRequest(ws, 'send_title', data);
                    return;
                }
                catch (error) {
                    logger.warn(`Failed to send title via WebSocket for bot ${botId}:`, error);
                }
            }
        }
        throw new Error('No available connection to send title');
    }
    /**
     * 发送动画栏消息 (action_bar)
     */
    async sendActionBar(message, player) {
        const messageComponent = typeof message === 'string' ? { text: message } : message;
        for (const [botId, ws] of this.wsConnections) {
            if (ws.readyState === ws_1.default.OPEN) {
                try {
                    const data = { message: messageComponent };
                    if (player)
                        data.nickname = player;
                    await this.sendApiRequest(ws, 'send_actionbar', data);
                    return;
                }
                catch (error) {
                    logger.warn(`Failed to send action bar via WebSocket for bot ${botId}:`, error);
                }
            }
        }
        throw new Error('No available connection to send action bar');
    }
    async stop() {
        if (this.debug) {
            logger.info(`[DEBUG] Stopping MinecraftAdapter`);
        }
        // 清理所有待处理的请求
        for (const [echo, pending] of this.pendingRequests) {
            clearTimeout(pending.timeout);
            pending.reject(new Error('Adapter stopped'));
        }
        this.pendingRequests.clear();
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
// ============================================================================
// Koishi Schema 配置
// ============================================================================
(function (MinecraftAdapter) {
    MinecraftAdapter.Config = koishi_1.Schema.object({
        debug: koishi_1.Schema.boolean().description('启用调试模式，输出详细日志').default(false),
        detailedLogging: koishi_1.Schema.boolean().description('启用详细调试日志（记录入站解析和 dispatch 快照）').default(false),
        tokenizeMode: koishi_1.Schema.union([
            koishi_1.Schema.const('split').description('按空白分词（默认）'),
            koishi_1.Schema.const('none').description('不分词，保留原文')
        ]).description('入站消息的分词模式').default('split'),
        reconnectInterval: koishi_1.Schema.number().description('重连间隔时间(ms)').default(5000),
        maxReconnectAttempts: koishi_1.Schema.number().description('最大重连尝试次数').default(10),
        useMessagePrefix: koishi_1.Schema.boolean().description('是否在消息前添加默认前缀（由服务端配置）').default(false),
        bots: koishi_1.Schema.array(koishi_1.Schema.object({
            selfId: koishi_1.Schema.string().description('机器人 ID（唯一标识）').required(),
            serverName: koishi_1.Schema.string().description('服务器名称（需与鹊桥 config.yml 中的 server_name 一致）'),
            rcon: koishi_1.Schema.object({
                host: koishi_1.Schema.string().description('RCON 主机地址').default('127.0.0.1'),
                port: koishi_1.Schema.number().description('RCON 端口').default(25575),
                password: koishi_1.Schema.string().description('RCON 密码').required(),
                timeout: koishi_1.Schema.number().description('RCON 超时时间(ms)').default(5000),
            }).description('RCON 配置（可选，用于回退）'),
            websocket: koishi_1.Schema.object({
                url: koishi_1.Schema.string().description('WebSocket 地址（如 ws://127.0.0.1:8080）').required(),
                accessToken: koishi_1.Schema.string().description('访问令牌（需与鹊桥 config.yml 中的 access_token 一致）'),
                extraHeaders: koishi_1.Schema.dict(koishi_1.Schema.string()).description('额外请求头'),
            }).description('WebSocket 配置'),
        })).description('机器人配置列表').default([]),
    });
})(MinecraftAdapter || (exports.MinecraftAdapter = MinecraftAdapter = {}));
exports.default = MinecraftAdapter;
