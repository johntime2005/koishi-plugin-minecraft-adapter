export interface RconOptions {
    host: string;
    port?: number;
    password: string;
    timeout?: number;
    debug?: boolean;
}
/**
 * 轻量级 Minecraft RCON 客户端
 * 替换已停止维护的 rcon-client 库，修复认证兼容性问题
 *
 * 主要改进：
 * - 正确处理 Minecraft 服务端的认证响应（兼容 Vanilla/Paper/Spigot/Fabric）
 * - 稳健的 TCP 分包/合包缓冲处理
 * - 独立的 TCP 连接超时和认证超时
 * - 密码类型安全（防止 YAML 解析为非字符串）
 */
export declare class Rcon {
    private socket;
    private emitter;
    private buf;
    private nextId;
    private authenticated;
    private authCb;
    private pending;
    private host;
    private port;
    private password;
    private timeout;
    private debug;
    constructor(options: RconOptions);
    static connect(options: RconOptions): Promise<Rcon>;
    on(event: string, listener: (...args: any[]) => void): void;
    once(event: string, listener: (...args: any[]) => void): void;
    off(event: string, listener: (...args: any[]) => void): void;
    connect(): Promise<void>;
    send(command: string): Promise<string>;
    end(): void;
    /**
     * 编码 RCON 数据包
     * 格式: [4:size][4:id][4:type][body][0x00][0x00]
     */
    private encode;
    /**
     * 从缓冲区中提取并处理完整的 RCON 数据包
     * 正确处理 TCP 分包和合包
     */
    private drain;
    /**
     * 处理接收到的 RCON 数据包
     *
     * 认证阶段：
     *   Minecraft 服务端对认证请求的响应因实现而异：
     *   - Vanilla: 仅发送 Auth_Response (type=2, id=请求id 或 -1)
     *   - 部分实现: 先发送空 Response_Value (type=0) 再发送 Auth_Response
     *
     *   处理策略：
     *   1. 收到 type=2（Auth_Response）→ 立即判断认证结果
     *   2. 收到 id=-1 → 认证失败（无论 type）
     *   3. 其他包 → 忽略（可能是前导空响应）
     */
    private onPacket;
}
