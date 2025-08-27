import { Adapter, Bot, Context, Schema } from 'koishi';
import { Rcon } from 'rcon-client';
import WebSocket from 'ws';
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
    sendMessage(channelId: string, content: string): Promise<string[]>;
    sendPrivateMessage(userId: string, content: string): Promise<string[]>;
    executeCommand(command: string): Promise<string>;
}
export interface MinecraftAdapterConfig {
    bots: MinecraftBotConfig[];
    debug?: boolean;
    reconnectInterval?: number;
    maxReconnectAttempts?: number;
}
export declare class MinecraftAdapter<C extends Context = Context> extends Adapter<C, MinecraftBot<C>> {
    private rconConnections;
    private wsConnections;
    private reconnectAttempts;
    private debug;
    private reconnectInterval;
    private maxReconnectAttempts;
    constructor(ctx: C, config: MinecraftAdapterConfig);
    private serializeOutgoingMessage;
    private getWebSocketCloseCode;
    private getWebSocketStateString;
    private connectWebSocket;
    private createSession;
    sendPrivateMessage(player: string, message: string): Promise<void>;
    broadcast(message: string): Promise<void>;
    stop(): Promise<void>;
}
export declare namespace MinecraftAdapter {
    const Config: Schema<MinecraftAdapterConfig>;
}
export default MinecraftAdapter;
