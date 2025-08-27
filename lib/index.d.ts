import { Context, Schema, Service } from 'koishi';
export interface MinecraftServiceAPI {
    /** 发送任意 RCON 指令，返回原始响应字符串 */
    execute(command: string): Promise<string>;
    /** 广播一条消息（基于配置选择 say 或 tellraw） */
    broadcast(message: string): Promise<string>;
    /** 向指定玩家发送消息（tellraw） */
    sendTo(player: string, message: string): Promise<string>;
    /** 通过 WS 广播（可回退 RCON） */
    wsBroadcast(message: string): Promise<string | void>;
    /** 通过 WS 私聊（可回退 RCON） */
    wsTell(player: string, message: string): Promise<string | void>;
    /** 通过 WS 或 RCON 发送标题、子标题 */
    wsTitle(player: string, title: string, subtitle?: string): Promise<string | void>;
    /** 通过 WS 或 RCON 发送动作栏 */
    wsActionbar(player: string, message: string): Promise<string | void>;
}
declare class MinecraftService extends Service implements MinecraftServiceAPI {
    ctx: Context;
    config: MinecraftService.Config;
    static inject: {
        required: any[];
        optional: string[];
    };
    private rcon?;
    private isConnecting;
    private reconnectTimer?;
    private currentReconnectInterval?;
    private commandQueue;
    private isProcessingQueue;
    private ws?;
    private wsReconnectTimer?;
    private wsCurrentInterval?;
    private debugEnabled;
    private commandBuckets;
    private internalBot?;
    private adapterInstance?;
    private runtimeBot?;
    constructor(ctx: Context, config: MinecraftService.Config);
    private registerWebhook;
    start(): void;
    stop(): void;
    private connectRcon;
    private scheduleReconnect;
    private ensureConnected;
    private disconnect;
    private connectWs;
    private disconnectWs;
    private ensureWsConnected;
    private scheduleWsReconnect;
    execute(command: string): Promise<string>;
    broadcast(message: string): Promise<string>;
    sendTo(player: string, message: string): Promise<string>;
    private enqueue;
    wsBroadcast(message: string): Promise<string | void>;
    wsTell(player: string, message: string): Promise<string | void>;
    wsTitle(player: string, title: string, subtitle?: string): Promise<string | void>;
    wsActionbar(player: string, message: string): Promise<string | void>;
    private processQueue;
    private setDebug;
    private dlog;
    private checkCommandAllowed;
    private consumeBucket;
}
declare namespace MinecraftService {
    interface RconConfig {
        enabled: boolean;
        host: string;
        port: number;
        password: string;
        timeout: number;
        reconnectInterval: number;
        reconnectStrategy?: 'fixed' | 'exponential';
        maxReconnectInterval?: number;
        broadcastMode: 'say' | 'tellraw';
    }
    interface WebhookConfig {
        enabled: boolean;
        path: string;
        secret?: string;
        verifyMode?: 'none' | 'header-secret' | 'hmac-sha256';
        signatureHeader?: string;
        secretHeader?: string;
    }
    interface WebSocketConfig {
        enabled: boolean;
        url: string;
        serverName: string;
        accessToken?: string;
        extraHeaders?: Record<string, string>;
        reconnectInterval?: number;
        reconnectStrategy?: 'fixed' | 'exponential';
        maxReconnectInterval?: number;
    }
    interface Config {
        rcon?: RconConfig;
        webhook?: WebhookConfig;
        websocket?: WebSocketConfig;
        commands?: {
            enabled?: boolean;
            authority?: number;
        };
        /** 调试开关：启用后打印详细日志 */
        debug?: boolean;
        /** 适配器兼容选项 */
        adapterCompat?: {
            /**
             * 将 chat 事件注入 Koishi 的 message 管线（平台 minecraft）
             * 提供在真正的 Adapter 完成前的临时方案
             */
            injectMessage?: boolean;
        };
        /** 安全与限流设置 */
        security?: {
            commandWhitelist?: string[];
            commandBlacklist?: string[];
            rateLimit?: {
                perMinute?: number;
            };
        };
        /** 正式 Adapter 设置 */
        adapter?: {
            enabled?: boolean;
            selfId?: string;
        };
    }
    const Config: Schema<Config>;
}
export default MinecraftService;
