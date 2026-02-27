# koishi-plugin-minecraft-adapter

Koishi 的 Minecraft 适配器插件，基于 [鹊桥 (QueQiao)](https://github.com/17TheWord/QueQiao) V2 协议，通过 WebSocket 与 Minecraft 服务器交互。

## 功能特性

- **鹊桥 V2 协议**: 完整支持鹊桥 V2 WebSocket 协议
- **WebSocket 连接**: 通过鹊桥 WebSocket Server 实时接收/发送事件和消息
- **RCON 命令执行**: 通过鹊桥 WebSocket API `send_rcon_command` 执行服务器命令
- **多服务器支持**: 通过 `servers` 数组配置多个 Minecraft 服务器，每个服务器独立运行
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
- **ChatImage 支持**: 按服务器独立配置 ChatImage CICode 图片显示

## 前置需求

- [Koishi](https://koishi.chat/) v4.17.9+
- [鹊桥 (QueQiao)](https://github.com/17TheWord/QueQiao) v0.3.0+ 服务端插件/Mod

## 安装

```bash
npm install koishi-plugin-minecraft-adapter
```

## 配置

### 全局配置

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `debug` | `boolean` | `false` | 启用调试模式，输出详细日志 |
| `detailedLogging` | `boolean` | `false` | 启用详细日志（入站解析和 dispatch 快照） |
| `tokenizeMode` | `'split' \| 'none'` | `'split'` | 入站消息分词模式 |
| `reconnectInterval` | `number` | `5000` | 重连间隔时间(ms) |
| `maxReconnectAttempts` | `number` | `10` | 最大重连尝试次数 |
| `useMessagePrefix` | `boolean` | `false` | 是否使用消息前缀 |
| `servers` | `array` | `[]` | 服务器配置列表 |

### 服务器配置 (`servers[]`)

每个服务器对应一个独立的 bot 实例。

| 配置项 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| `selfId` | `string` | ✅ | 机器人唯一标识 |
| `serverName` | `string` | ❌ | 服务器名称，**需与鹊桥 `config.yml` 中的 `server_name` 一致** |
| `websocket` | `object` | ✅ | WebSocket 配置（用于事件接收和消息发送） |
| `chatImage` | `object` | ❌ | ChatImage 图片显示配置（仅对此服务器生效） |

#### WebSocket 配置 (`servers[].websocket`)

| 配置项 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| `url` | `string` | ✅ | 鹊桥 WebSocket Server 地址（如 `ws://127.0.0.1:8080`） |
| `accessToken` | `string` | ❌ | 访问令牌（与鹊桥 `config.yml` 中的 `access_token` 一致） |
| `extraHeaders` | `object` | ❌ | 额外请求头 |

#### RCON（通过鹊桥 WebSocket）

插件侧不再直连 TCP RCON。执行命令时会通过鹊桥 V2 WebSocket API `send_rcon_command` 发送。

RCON 的启用与密码/端口等配置请在鹊桥端 `config.yml` 中完成。

#### ChatImage 配置 (`servers[].chatImage`)

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `enabled` | `boolean` | `false` | 启用 CICode 图片发送（需客户端安装 ChatImage Mod） |
| `defaultImageName` | `string` | `'图片'` | 图片在聊天栏中的默认显示名称 |

### 完整配置示例

#### 单服务器

```yaml
plugins:
  minecraft-adapter:
    debug: false
    tokenizeMode: split
    servers:
      - selfId: 'mc-server-1'
        serverName: 'TestServer'
        websocket:
          url: 'ws://127.0.0.1:8080'
          accessToken: 'your_token'
        chatImage:
          enabled: true
          defaultImageName: '图片'
```

#### 多服务器

```yaml
plugins:
  minecraft-adapter:
    debug: false
    servers:
      - selfId: 'survival'
        serverName: 'SurvivalServer'
        websocket:
          url: 'ws://192.168.1.10:8080'
          accessToken: 'token_survival'
        chatImage:
          enabled: true
      - selfId: 'creative'
        serverName: 'CreativeServer'
        websocket:
          url: 'ws://192.168.1.11:8080'
          accessToken: 'token_creative'
```

### 从旧版配置迁移

如果你使用的是旧版配置格式（`bots` + 全局 `chatImage`），插件会自动迁移并在日志中提示。建议尽快手动迁移到新格式：

**旧格式（已弃用）：**
```yaml
plugins:
  minecraft-adapter:
    chatImage:
      enabled: true
    bots:
      - selfId: 'mc-1'
        websocket:
          url: 'ws://127.0.0.1:8080'
```

**新格式：**
```yaml
plugins:
  minecraft-adapter:
    servers:
      - selfId: 'mc-1'
        websocket:
          url: 'ws://127.0.0.1:8080'
        chatImage:
          enabled: true
```

主要变更：
- `bots` → `servers`
- 全局 `chatImage` → 每服务器 `chatImage`
- `websocket` 现在是必填项

## 使用方法

### 监听事件

```typescript
ctx.on('message', (session) => {
  if (session.platform === 'minecraft') {
    console.log(`[${session.event.guild?.name}] ${session.event.user?.name}: ${session.content}`)
  }
})

ctx.on('guild-member-added', (session) => {
  if (session.platform === 'minecraft') {
    console.log(`${session.event.user?.name} 加入了服务器`)
  }
})

ctx.on('guild-member-removed', (session) => {
  if (session.platform === 'minecraft') {
    console.log(`${session.event.user?.name} 离开了服务器`)
  }
})
```

### 发送消息

```typescript
// 广播消息（通过 bot 实例自动定位到对应服务器）
await bot.sendMessage('server-channel', '服务器即将重启')

// 向指定玩家发送私聊消息
await bot.sendPrivateMessage('Steve', '你好')

// 执行 RCON 命令（通过鹊桥 WebSocket API 执行）
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
| RCON 命令 | `send_rcon_command` | 执行服务器命令 |
| 标题显示 | `title` | 显示标题和副标题 |
| 动画栏 | `action_bar` | 显示动画栏消息 |

## 调试

启用 `debug: true` 后会输出详细日志，包括：

- 适配器初始化过程
- WebSocket 连接状态
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
