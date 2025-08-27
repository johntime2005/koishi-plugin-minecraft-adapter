# koishi-plugin-minecraft-adapter

Koishi 的 Minecraft 适配器插件，支持通过 RCON 和 WebSocket 与 Minecraft 服务器交互。

## 功能特性

- **RCON 连接**: 连接 Minecraft 服务器的 RCON 接口，执行命令和广播消息
- **WebSocket 连接**: 通过鹊桥(QueQiao) WebSocket 接收服务器事件
- **事件支持**: 聊天消息、玩家加入/离开、死亡事件、成就事件等
- **自动重连**: WebSocket 断开后自动重连机制
- **多机器人支持**: 支持配置多个 Minecraft 服务器实例

## 安装

```bash
npm install koishi-plugin-minecraft-adapter
```

## 配置

适配器支持以下配置选项：

### 基本配置
- `debug`: 启用调试模式，输出详细的连接和消息日志
- `reconnectInterval`: 重连间隔时间(毫秒)，默认为5000ms
- `maxReconnectAttempts`: 最大重连尝试次数，默认为10次
- `bots`: 机器人配置列表

### 机器人配置
每个机器人可以配置以下选项：

#### 基本信息
- `selfId`: 机器人ID（必需）
- `serverName`: 服务器名称

#### RCON 配置
```yaml
rcon:
  enabled: true
  host: '127.0.0.1'
  port: 25575
  password: 'your_rcon_password'
  timeout: 5000
```

#### WebSocket 配置
```yaml
websocket:
  enabled: true
  url: 'ws://127.0.0.1:8080'
  serverName: 'MyMinecraftServer'  # 必须与鹊桥配置一致
  accessToken: 'your_access_token'  # 可选
  extraHeaders: {}  # 可选的额外请求头
```

## 使用方法

### 在 Koishi 中使用

```typescript
// 执行 RCON 命令
await ctx.minecraft.execute('list')

// 广播消息
await ctx.minecraft.broadcast('服务器即将重启')

// 向指定玩家发送消息
await ctx.minecraft.sendTo('Steve', '你好')

// 监听聊天事件
ctx.on('message', (session) => {
  if (session.platform === 'minecraft') {
    console.log(`玩家 ${session.author.username}: ${session.content}`)
  }
})

// 监听玩家加入事件
ctx.on('guild-member-added', (session) => {
  if (session.platform === 'minecraft') {
    console.log(`玩家 ${session.author.username} 加入了服务器`)
  }
})

// 监听玩家离开事件
ctx.on('guild-member-removed', (session) => {
  if (session.platform === 'minecraft') {
    console.log(`玩家 ${session.author.username} 离开了服务器`)
  }
})
```

### 事件类型

适配器支持以下 Minecraft 事件：

- `chat` / `player_chat`: 玩家聊天消息
- `join` / `player_join`: 玩家加入服务器
- `leave` / `quit` / `player_quit`: 玩家离开服务器
- `death` / `player_death`: 玩家死亡事件
- `advancement` / `achievement`: 玩家成就事件

## 调试功能

启用调试模式后，适配器会输出详细的连接和消息处理日志，帮助诊断连接和消息接收问题：

```yaml
debug: true  # 启用调试模式
```

调试模式会显示：
- **初始化过程**: 适配器启动和机器人初始化详情
- **连接过程**: WebSocket 和 RCON 连接建立过程
- **消息接收**: 接收到的原始消息数据和解析过程
- **会话创建**: 消息如何转换为 Koishi 会话
- **事件分发**: 会话如何分发到 Koishi 事件系统
- **心跳检测**: WebSocket 心跳包收发状态
- **连接状态**: 定期报告 WebSocket 连接状态
- **重连过程**: 断线重连的详细过程
- **错误详情**: 详细的错误信息和堆栈跟踪

**注意**: 调试模式会产生大量日志，请仅在排查问题时启用。

### 调试配置

```yaml
# 调试和重连配置
debug: true                    # 启用调试模式
reconnectInterval: 5000       # 初始重连间隔(ms)
maxReconnectAttempts: 10      # 最大重连次数
```
