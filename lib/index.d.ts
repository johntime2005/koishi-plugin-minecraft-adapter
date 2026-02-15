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
export interface MinecraftBotConfig {
    selfId: string;
    serverName?: string;
    rcon?: {
        host: string;
        port: number;
        password: string;
        timeout?: number;
    };
    websocket?: {
        url: string;
        accessToken?: string;
        extraHeaders?: Record<string, string>;
    };
}
export declare class MinecraftBot<C extends Context = Context> extends Bot<C, MinecraftBotConfig> {
    rcon?: Rcon;
    ws?: WebSocket;
    constructor(ctx: C, config: MinecraftBotConfig);
    /**
     * 发送消息到频道或私聊
     */
    sendMessage(channelId: string, content: string): Promise<string[]>;
    /**
     * 发送私聊消息
     */
    sendPrivateMessage(userId: string, content: string): Promise<string[]>;
    /**
     * 执行 RCON 命令
     */
    executeCommand(command: string): Promise<string>;
}
export interface ChatImageConfig {
    /** 是否启用 ChatImage CICode 生成（出站方向），默认关闭 */
    enabled?: boolean;
    /** 图片在聊天栏中的默认显示名称 */
    defaultImageName?: string;
}
export interface MinecraftAdapterConfig {
    bots: MinecraftBotConfig[];
    debug?: boolean;
    detailedLogging?: boolean;
    tokenizeMode?: 'split' | 'none';
    reconnectInterval?: number;
    maxReconnectAttempts?: number;
    /** 是否在消息前添加默认前缀 [鹊桥]，默认不添加（由服务端配置） */
    useMessagePrefix?: boolean;
    /** ChatImage 集成配置 */
    chatImage?: ChatImageConfig;
}
export declare class MinecraftAdapter<C extends Context = Context> extends Adapter<C, MinecraftBot<C>> {
    static reusable: boolean;
    private rconConnections;
    private wsConnections;
    private reconnectAttempts;
    private pendingRequests;
    private requestCounter;
    private debug;
    private detailedLogging;
    private tokenizeMode;
    private reconnectInterval;
    private maxReconnectAttempts;
    private useMessagePrefix;
    private chatImageEnabled;
    private chatImageDefaultName;
    constructor(ctx: C, config: MinecraftAdapterConfig);
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
    sendPrivateMessage(player: string, message: string): Promise<void>;
    /**
     * 广播消息 (broadcast)
     */
    broadcast(message: string): Promise<void>;
    /**
     * 执行 RCON 命令 (send_rcon_command)
     */
    executeRconCommand(command: string): Promise<string>;
    /**
     * 发送标题消息 (title)
     */
    sendTitle(title: string | MinecraftTextComponent, subtitle?: string | MinecraftTextComponent, player?: string): Promise<void>;
    /**
     * 发送动画栏消息 (action_bar)
     */
    sendActionBar(message: string | MinecraftTextComponent, player?: string): Promise<void>;
    stop(): Promise<void>;
}
export declare namespace MinecraftAdapter {
    const Config: Schema<MinecraftAdapterConfig>;
}
export default MinecraftAdapter;
