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
- `serverName`: 服务器名称，用于标识不同的 Minecraft 服务器
- `platform`: 平台标识符，默认为 'minecraft'

### RCON 配置
```yaml
rcon:
  enabled: true
  host: '127.0.0.1'
  port: 25575
  password: 'your_rcon_password'
  timeout: 5000
```

### WebSocket 配置
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

## 依赖项目

- [QueQiao](https://github.com/17TheWord/QueQiao): Minecraft WebSocket 插件
- [RCON Client](https://github.com/sirh3e/rcon-client): RCON 协议客户端

## 许可证

MIT
