import { Adapter, Bot, Context, Schema } from 'koishi';
import { Rcon } from 'rcon-client';
import WebSocket from 'ws';
/**
 * Minecraft 文本组件格式
 * 参考: https://zh.minecraft.wiki/w/原始JSON文本格式
 */
export interface MinecraftTextComponent {
    text?: string;
    color?: string;
    bold?: boolean;
    italic?: boolean;
    underlined?: boolean;
    strikethrough?: boolean;
    obfuscated?: boolean;
    extra?: MinecraftTextComponent[];
}
/**
 * 鹊桥 V2 Player 对象
 * 注意：不同服务端实现可能缺少部分字段
 */
export interface QueqiaoPlayer {
    nickname: string;
    uuid?: string;
    is_op?: boolean;
    address?: string;
    health?: number;
    max_health?: number;
    experience_level?: number;
    experience_progress?: number;
    total_experience?: number;
    walk_speed?: number;
    x?: number;
    y?: number;
    z?: number;
}
/**
 * 鹊桥 V2 Death 对象
 */
export interface QueqiaoDeath {
    key?: string;
    args?: string;
    text?: string;
}
/**
 * 鹊桥 V2 Achievement 对象
 */
export interface QueqiaoAchievement {
    display?: {
        title?: string;
        description?: string;
        frame?: string;
    };
    text?: string;
}
/**
 * 鹊桥 V2 事件基础结构
 */
export interface QueqiaoEventBase {
    timestamp: number;
    post_type: 'message' | 'notice' | 'response';
    event_name: string;
    server_name: string;
    server_version?: string;
    server_type?: string;
}
/**
 * 玩家聊天事件 (PlayerChatEvent)
 */
export interface PlayerChatEvent extends QueqiaoEventBase {
    post_type: 'message';
    event_name: 'PlayerChatEvent';
    message: string;
    rawMessage?: string;
    message_id?: string;
    player: QueqiaoPlayer;
}
/**
 * 玩家命令事件 (PlayerCommandEvent)
 */
export interface PlayerCommandEvent extends QueqiaoEventBase {
    post_type: 'message';
    event_name: 'PlayerCommandEvent';
    command: string;
    rawMessage?: string;
    message_id?: string;
    player: QueqiaoPlayer;
}
/**
 * 玩家加入事件 (PlayerJoinEvent)
 */
export interface PlayerJoinEvent extends QueqiaoEventBase {
    post_type: 'notice';
    event_name: 'PlayerJoinEvent';
    sub_type: 'player_join';
    player: QueqiaoPlayer;
}
/**
 * 玩家离开事件 (PlayerQuitEvent)
 */
export interface PlayerQuitEvent extends QueqiaoEventBase {
    post_type: 'notice';
    event_name: 'PlayerQuitEvent';
    sub_type: 'player_quit';
    player: QueqiaoPlayer;
}
/**
 * 玩家死亡事件 (PlayerDeathEvent)
 */
export interface PlayerDeathEvent extends QueqiaoEventBase {
    post_type: 'notice';
    event_name: 'PlayerDeathEvent';
    sub_type: 'player_death';
    death?: QueqiaoDeath;
    player: QueqiaoPlayer;
}
/**
 * 玩家成就事件 (PlayerAchievementEvent)
 */
export interface PlayerAchievementEvent extends QueqiaoEventBase {
    post_type: 'notice';
    event_name: 'PlayerAchievementEvent';
    sub_type: 'player_achievement';
    achievement?: QueqiaoAchievement;
    player: QueqiaoPlayer;
}
export type QueqiaoEvent = PlayerChatEvent | PlayerCommandEvent | PlayerJoinEvent | PlayerQuitEvent | PlayerDeathEvent | PlayerAchievementEvent;
/**
 * 鹊桥 V2 API 请求格式
 */
export interface QueqiaoApiRequest<T = any> {
    api: string;
    data: T;
    echo?: string | number;
}
/**
 * 鹊桥 V2 API 响应格式
 */
export interface QueqiaoApiResponse<T = any> {
    code: number;
    api: string;
    post_type: 'response';
    status: 'SUCCESS' | 'FAILED';
    message: string;
    data?: T;
    echo?: string | number;
}
/**
 * 单个服务器的配置（扁平化结构）
 * 每个服务器对应一个独立的 bot 实例
 */
export interface ServerConfig {
    /** 机器人 ID（唯一标识） */
    selfId: string;
    /** 服务器名称（需与鹊桥 config.yml 中的 server_name 一致） */
    serverName?: string;
    /** WebSocket 地址（如 ws://127.0.0.1:8080） */
    url: string;
    /** 访问令牌（需与鹊桥 config.yml 中的 access_token 一致） */
    accessToken?: string;
    /** 额外请求头 */
    extraHeaders?: Record<string, string>;
    /** 启用 RCON 远程命令执行 */
    enableRcon?: boolean;
    /** RCON 主机地址 */
    rconHost?: string;
    /** RCON 端口 */
    rconPort?: number;
    /** RCON 密码 */
    rconPassword?: string;
    /** RCON 超时时间(ms) */
    rconTimeout?: number;
    /** 启用 ChatImage CICode 图片发送（需客户端安装 ChatImage Mod） */
    enableChatImage?: boolean;
    /** 图片在聊天栏中的默认显示名称 */
    chatImageDefaultName?: string;
}
/** @deprecated 请使用 ServerConfig */
export type MinecraftBotConfig = ServerConfig;
export interface MinecraftAdapterConfig {
    /** 服务器配置列表 */
    servers: ServerConfig[];
    /** 启用调试模式 */
    debug?: boolean;
    /** 启用详细调试日志 */
    detailedLogging?: boolean;
    /** 入站消息分词模式 */
    tokenizeMode?: 'split' | 'none';
    /** 重连间隔时间(ms) */
    reconnectInterval?: number;
    /** 最大重连尝试次数 */
    maxReconnectAttempts?: number;
    /** 是否在消息前添加默认前缀 */
    useMessagePrefix?: boolean;
}
export declare class MinecraftBot<C extends Context = Context> extends Bot<C, ServerConfig> {
    rcon?: Rcon;
    ws?: WebSocket;
    /** 此服务器是否启用 ChatImage CICode */
    chatImageEnabled: boolean;
    /** 此服务器的 ChatImage 默认图片名称 */
    chatImageDefaultName: string;
    constructor(ctx: C, config: ServerConfig);
    /**
     * 发送消息到频道或私聊
     */
    sendMessage(channelId: string, content: string): Promise<string[]>;
    /**
     * 发送私聊消息
     */
    sendPrivateMessage(userId: string, content: string): Promise<string[]>;
    /**
     * 执行 RCON 命令（用于执行服务器命令，与 WebSocket 并行工作）
     */
    executeCommand(command: string): Promise<string>;
}
export declare class MinecraftAdapter<C extends Context = Context> extends Adapter<C, MinecraftBot<C>> {
    static reusable: boolean;
    private rconConnections;
    private wsConnections;
    private reconnectAttempts;
    private pendingRequests;
    private requestCounter;
    /** 事件去重缓存：防止鹊桥服务端对同一事件发送多次 */
    private recentEventKeys;
    private debug;
    private detailedLogging;
    private tokenizeMode;
    private reconnectInterval;
    private maxReconnectAttempts;
    private useMessagePrefix;
    constructor(ctx: C, rawConfig: MinecraftAdapterConfig);
    private static readonly DEDUP_WINDOW_MS;
    private static readonly DEDUP_CLEANUP_INTERVAL_MS;
    private isDuplicateEvent;
    private startDedupCleanup;
    /**
     * 生成唯一的请求 ID
     */
    private generateEcho;
    private toTextComponent;
    private extractRawText;
    /**
     * 生成 ChatImage CICode: [[CICode,url=<url>,name=<name>]]
     */
    private buildCICode;
    /**
     * 解析出站消息中的 Koishi 元素标签 (<img src="..."/>, <image url="..."/>)
     */
    private parseOutboundMessage;
    private extractAttr;
    private decodeHtmlEntities;
    /**
     * 发送 WebSocket API 请求并等待响应
     */
    private sendApiRequest;
    /**
     * 处理 API 响应
     */
    private handleApiResponse;
    private getWebSocketCloseCode;
    private getWebSocketStateString;
    private connectWebSocket;
    private sessionCounter;
    /**
     * 根据鹊桥 V2 事件创建 Koishi Session
     */
    private createSession;
    /**
     * 解析消息文本为 Koishi 元素数组
     * 入站方向始终解析 CICode 和裸图片 URL（不受 chatImage.enabled 控制）
     */
    private parseMessageToElements;
    private extractCICodeParam;
    private addTextElements;
    /**
     * 发送私聊消息 (send_private_msg)
     */
    sendPrivateMessage(player: string, message: string, bot?: MinecraftBot<C>): Promise<void>;
    broadcast(message: string, bot?: MinecraftBot<C>): Promise<void>;
    executeRconCommand(command: string, bot?: MinecraftBot<C>): Promise<string>;
    sendTitle(title: string | MinecraftTextComponent, subtitle?: string | MinecraftTextComponent, player?: string, bot?: MinecraftBot<C>): Promise<void>;
    sendActionBar(message: string | MinecraftTextComponent, player?: string, bot?: MinecraftBot<C>): Promise<void>;
    stop(): Promise<void>;
}
export declare namespace MinecraftAdapter {
    const Config: Schema<MinecraftAdapterConfig>;
}
export default MinecraftAdapter;
