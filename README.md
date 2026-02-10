# koishi-plugin-minecraft-adapter

Koishi 的 Minecraft 适配器插件，基于 [鹊桥 (QueQiao)](https://github.com/17TheWord/QueQiao) V2 协议，支持通过 WebSocket 和 RCON 与 Minecraft 服务器交互。

## 功能特性

- **鹊桥 V2 协议**: 完整支持鹊桥 V2 WebSocket 协议
- **WebSocket 连接**: 通过鹊桥 WebSocket Server 实时接收/发送事件和消息
- **RCON 回退**: 当 WebSocket 不可用时自动回退到 RCON
- **完整事件支持**:
  - 玩家聊天 (`PlayerChatEvent`)
  - 玩家命令 (`PlayerCommandEvent`)
  - 玩家加入 (`PlayerJoinEvent`)
  - 玩家离开 (`PlayerQuitEvent`)
  - 玩家死亡 (`PlayerDeathEvent`)
  - 玩家成就 (`PlayerAchievementEvent`)
- **完整 API 支持**:
  - 广播消息 (`broadcast`)
  - 私聊消息 (`send_private_msg`)
  - RCON 命令 (`send_rcon_command`)
  - 标题显示 (`title`)
  - 动画栏 (`action_bar`)
- **自动重连**: WebSocket 断开后指数退避自动重连
- **多机器人支持**: 支持配置多个 Minecraft 服务器实例

## 前置需求

- [Koishi](https://koishi.chat/) v4.17.9+
- [鹊桥 (QueQiao)](https://github.com/17TheWord/QueQiao) v0.3.0+ 服务端插件/Mod

## 安装

```bash
npm install koishi-plugin-minecraft-adapter
```

## 配置

### 基本配置

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `debug` | `boolean` | `false` | 启用调试模式，输出详细日志 |
| `detailedLogging` | `boolean` | `false` | 启用详细日志（入站解析和 dispatch 快照） |
| `tokenizeMode` | `'split' \| 'none'` | `'split'` | 入站消息分词模式 |
| `reconnectInterval` | `number` | `5000` | 重连间隔时间(ms) |
| `maxReconnectAttempts` | `number` | `10` | 最大重连尝试次数 |
| `useMessagePrefix` | `boolean` | `false` | 是否使用消息前缀 |
| `bots` | `array` | `[]` | 机器人配置列表 |

### 机器人配置

| 配置项 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| `selfId` | `string` | ✅ | 机器人唯一标识 |
| `serverName` | `string` | ❌ | 服务器名称，**需与鹊桥 `config.yml` 中的 `server_name` 一致** |
| `websocket` | `object` | ❌ | WebSocket 配置 |
| `rcon` | `object` | ❌ | RCON 配置（回退用） |

#### WebSocket 配置

```yaml
websocket:
  url: 'ws://127.0.0.1:8080'     # 鹊桥 WebSocket Server 地址
  accessToken: 'your_token'       # 访问令牌（与鹊桥 config.yml 中的 access_token 一致）
  extraHeaders: {}                # 额外请求头（可选）
```

#### RCON 配置

```yaml
rcon:
  host: '127.0.0.1'
  port: 25575
  password: 'your_rcon_password'
  timeout: 5000
```

### 完整配置示例

```yaml
plugins:
  minecraft-adapter:
    debug: false
    detailedLogging: false
    tokenizeMode: split
    reconnectInterval: 5000
    maxReconnectAttempts: 10
    bots:
      - selfId: 'mc-server-1'
        serverName: 'TestServer'        # 与鹊桥 config.yml 中 server_name 一致
        websocket:
          url: 'ws://127.0.0.1:8080'
          accessToken: 'your_token'     # 与鹊桥 config.yml 中 access_token 一致
        rcon:
          host: '127.0.0.1'
          port: 25575
          password: 'your_password'
```

## 使用方法

### 监听事件

```typescript
// 监听聊天事件
ctx.on('message', (session) => {
  if (session.platform === 'minecraft') {
    console.log(`[${session.event.guild?.name}] ${session.event.user?.name}: ${session.content}`)
  }
})

// 监听玩家加入事件
ctx.on('guild-member-added', (session) => {
  if (session.platform === 'minecraft') {
    console.log(`${session.event.user?.name} 加入了服务器`)
  }
})

// 监听玩家离开事件
ctx.on('guild-member-removed', (session) => {
  if (session.platform === 'minecraft') {
    console.log(`${session.event.user?.name} 离开了服务器`)
  }
})
```

### 发送消息

```typescript
// 广播消息
await bot.sendMessage('server-channel', '服务器即将重启')

// 向指定玩家发送私聊消息
await bot.sendPrivateMessage('Steve', '你好')

// 执行 RCON 命令（支持通过 WebSocket send_rcon_command 或直接 RCON）
const result = await bot.executeCommand('list')
```

### 鹊桥 V2 事件映射

| 鹊桥事件 | Koishi 事件类型 |
|----------|----------------|
| `PlayerChatEvent` | `message` |
| `PlayerCommandEvent` | `message` (subtype: command) |
| `PlayerJoinEvent` | `guild-member-added` |
| `PlayerQuitEvent` | `guild-member-removed` |
| `PlayerDeathEvent` | `notice` (subtype: player-death) |
| `PlayerAchievementEvent` | `notice` (subtype: player-achievement) |

### 鹊桥 V2 API 映射

| 功能 | 鹊桥 API | 说明 |
|------|----------|------|
| 广播消息 | `broadcast` | 向所有在线玩家广播 |
| 私聊消息 | `send_private_msg` | 向指定玩家发送消息 |
| RCON 命令 | `send_rcon_command` | 远程执行服务器命令 |
| 标题显示 | `title` | 显示标题和副标题 |
| 动画栏 | `action_bar` | 显示动画栏消息 |

## 调试

启用 `debug: true` 后会输出详细日志，包括：

- 适配器初始化过程
- WebSocket/RCON 连接状态
- 接收到的原始消息数据
- 事件解析和会话创建过程
- API 请求和响应
- 断线重连过程
- 错误详情和堆栈跟踪

**注意**: 调试模式会产生大量日志，请仅在排查问题时启用。

## 协议参考

- [鹊桥文档](https://queqiao-docs.pages.dev)
- [鹊桥 API 文档](https://queqiao.apifox.cn/)
- [鹊桥 GitHub](https://github.com/17TheWord/QueQiao)

## 许可证

[MIT](LICENSE)
