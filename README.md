# koishi-plugin-minecraft-adapter

Koishi 的 Minecraft 适配器：支持 RCON、鹊桥(Queqiao) Webhook 与 WebSocket。

- RCON：连接并发送命令/广播
- Webhook/WS：接收聊天、加入、离开等事件并在 Koishi 中触发

参考实现：
- https://github.com/17TheWord/nonebot-adapter-minecraft
- https://github.com/KroMiose/nekro-agent/tree/main/nekro_agent/adapters/minecraft

## 安装

```bash
npm i koishi-plugin-minecraft-adapter
```

## 配置

- RCON：host/port/password/timeout/reconnectInterval/reconnectStrategy/maxReconnectInterval/broadcastMode
- Webhook：enabled/path/secret/verifyMode/signatureHeader/secretHeader
- WebSocket（对齐鹊桥官方）
  - enabled: 是否启用
  - url: WS 地址，例如 `ws://127.0.0.1:8080`
  - serverName: 必填，需与鹊桥 `config.yml` 的 `server_name` 完全一致
  - accessToken: 可选，对应鹊桥 `config.yml` 的 `access_token`
  - extraHeaders: 可选，附加自定义请求头
  - reconnectStrategy: `fixed | exponential`
  - reconnectInterval / maxReconnectInterval: 断线重连间隔

握手头部：

```
x-self-name: <serverName>
Authorization: Bearer <accessToken>   // 若 accessToken 不为空
```

鹊桥项目参考：

- QueQiao: https://github.com/17TheWord/QueQiao

## 用法

```ts
await ctx.minecraft.execute('list')
await ctx.minecraft.broadcast('服务器即将重启')
await ctx.minecraft.sendTo('Steve', '你好')

ctx.on('minecraft/chat', (p) => {
  // p: { player, message, raw }
})
```

### ChatLuna（AI）联动

启用后可直接在 Koishi 中使用以下命令，便于 ChatLuna 的“指令模型/函数调用/意图解析”触发：

- `mc.exec <command>`：通过 RCON 执行任意指令
- `mc.say <message>`：向全服广播（优先走 WS，失败回退 RCON）
- `mc.tell <player> <message>`：向指定玩家发送消息（优先 WS，失败回退 RCON）
- `mc.title <player> <title> [subtitle]`：标题/子标题（WS 或 RCON 回退）
- `mc.actionbar <player> <message>`：动作栏（WS 或 RCON 回退）

可在插件配置中调整：
- `commands.enabled`：是否注册上述命令（默认开启）
- `commands.authority`：执行所需权限（默认 2），避免普通用户误触发

MIT
