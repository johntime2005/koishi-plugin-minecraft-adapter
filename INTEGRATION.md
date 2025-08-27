# 集成调查报告 — Minecraft Adapter ↔ QueQiao (鹊桥)

目的：记录插件与鹊桥之间的对接细节、数据契约、样例、常见问题与调试流程，供日后修改和排查使用。

## 1. 概览
- 对接双方：
  - Koishi 插件端（本仓库 `minecraft-adapter`）——负责把 WebSocket / RCON 的 Minecraft 消息转成 Koishi Session，并把 Koishi 的出站消息发送回 Minecraft/QueQiao。
  - QueQiao（鹊桥，Spigot 插件/服务端）——提供 WebSocket HTTP 接口与 Minecraft 服务端交互，接收广播/私聊/标题/动作条请求并在游戏内展示。

## 2. 总体数据流（简化）
1. 玩家在服务器说话或事件触发 → QueQiao 将事件通过 WebSocket 转发给 Koishi 插件（作为 JSON payload）。
2. 插件解析 payload —— 构建 Koishi Event/Session（关键是 `event.message.elements`），调用 `bot.dispatch(session)`。
3. Koishi 产生回复 → 插件将回复序列化为兼容格式并通过 WebSocket 提交给 QueQiao；如果 WebSocket 不可用，则通过 RCON 发送 tellraw/say 等命令。
4. QueQiao 将接收到的消息转换为 Spigot `TextComponent` 并调用 `spigot().broadcast()` 或私聊 API。 

## 3. 双方协定（契约）
### 3.1 入站（QueQiao -> Adapter）
- 常见请求体字段（JSON）：
  - `type`：事件类型，例如 `playerChat`、`playerCommand`、`asyncPlayerChatEvent` 等（实现中以 `type` 或 `action` 识别）。
  - `player` / `sender`：玩家标识（姓名或 UUID），视实现而定。
  - `message`：消息文本，期望为 string 或数组（但为兼容 Koishi Session，最终应当被转换为 string）。
- 必要头部（WebSocket 握手/HTTP）:
  - `x-self-name`：客户端标识（QueQiao 要求的 header）
  - `Authorization`：若 QueQiao 配置了 token，则需此 header
- Adapter 要点：
  - Koishi 的 `Session.content` 从 `event.message.elements.join('')` 读取，因此在 `createSession` 中必须设置 `event.message.elements = [payload.message]`（确保是字符串数组）。
  - 若 payload.message 为复杂 component（JSON object），应解析其文本字段（例如 `content`、`text` 或 `attrs.content`）以填充元素。

### 3.2 出站（Adapter -> QueQiao）
- 支持的 API 方法（常见）：
  - `broadcast`：群体广播
  - `send_private_msg`：发送私聊
  - `send_title` / `send_actionbar`：显示标题/动作条
- 建议请求体格式：
  - 最简单兼容：
    - `{ "message": "plain string" }` 或 `{ "message": ["part1","part2"] }`。
    - 如果要支持复杂交互（click/hover），需按 QueQiao 的 MessageSegment schema 发送数组对象，但目前优先使用简单字符串以保证可靠性。
- 认证与 headers：同上（x-self-name/Authorization）。

### 3.3 RCON 回退
- 当 WebSocket 无法发送时，使用 RCON 执行 `tellraw`（JSON 文本组件数组）或 `say`（简单文本）。
- Adapter 将字符串/数组转换为 tellraw 所需的 text component 对象：
  - 字符串项 → `{ "text": "..." }`
  - 对象项（如果已构造）→ 直接用作 component

## 4. 关键字段与数据样例
### 4.1 入站示例（QueQiao -> Adapter）
- 简单字符串：
```json
{
  "type": "asyncPlayerChatEvent",
  "player": "Steve",
  "message": "#help"
}
```

- 复杂 component（可能的形式）：
```json
{
  "type": "asyncPlayerChatEvent",
  "player": "Alex",
  "message": { "attrs": { "content": "#help" }, "type": "text" }
}
```

Adapter 处理策略：若 `message` 为对象，尝试按优先级读取 `attrs.content`、`content`、`text`；得到字符串后放入 `event.message.elements = [thatString]`。

### 4.2 出站示例（Adapter -> QueQiao）
- 广播普通字符串：
```json
{
  "type": "broadcast",
  "message": "Koishi: 帮助信息在此。"
}
```

- 广播数组（将被 join 或转换为 tellraw）：
```json
{
  "type": "broadcast",
  "message": ["Koishi:", " 帮助信息在此。"]
}
```

## 5. 边缘情况与建议策略
- QueQiao 接收复杂 JSON component 时，可能会把其转为 `TextComponent`；但如果传入未按预期结构的对象，可能被忽略或导致无画面展示。建议：
  - 优先发送简单字符串；只有在需要 click/hover 时才构造 component 数组。
  - 在适配层为常见 component 对象提供显式序列化路径（例如处理 `attrs.content`、`text`、`color` 等）。
- 字符编码：确保发送/接收 JSON 均为 UTF-8 编码，避免中文被转义或截断。
- 认证失败：若 QueQiao 返回 401/403，检查 `Authorization` header 与 `x-self-name`。
- 版本/协议差异：不同 QueQiao 版本可能对字段名有所不同（如 `message` 还是 `messageList`）；增加兼容兜底解析（尝试多字段名）。

## 6. 日志与调试模板
- 入站日志（建议包含）：
  - 时间戳
  - 收到的原始 payload（JSON stringify）
  - 解析后填充的 `event.message.elements`
  - 最终 `session.content`
- 出站日志（建议包含）：
  - 时间戳
  - 要发送的原始 Koishi 输出（可能是 Element/MessageSegment）
  - `serializeOutgoingMessage` 的返回值（string | string[] | component[]）
  - WebSocket send 的最终 payload
  - RCON fallback 使用的命令
- 采样日志行（建议格式）：
```
[2025-08-27T12:00:00Z] IN << {type: "asyncPlayerChatEvent", player: "Steve", message: "#help"}
[2025-08-27T12:00:00Z] PARSED -> event.message.elements = ["#help"], session.content = "#help"
[2025-08-27T12:00:01Z] OUT >> serializeOutgoingMessage -> "已加载帮助"; WS payload -> {action: "broadcast", message: "已加载帮助"}
[2025-08-27T12:00:01Z] QUEQIAO RESP <- {code:200, message:"success"}
```

## 7. 推荐变更与注意事项（供后续修改参考）
- 在 `createSession` 中对 `payload.message` 做更多容错解析（支持 string、数组、object），并记录未识别表单以便排查。
- 保留 `serializeOutgoingMessage` 的扩展点：当配置 `enableComponents: true` 时，允许输出 message component 数组以支持 clickable/hoverable 文本，否则默认发 plain string。
- 增加一个 `compatibilityMode` 配置：
  - `strictString`（默认）：总是发送字符串，兼容性最高。
  - `richComponents`：在 Koishi 输出包含组件时，尝试发送组件数组。
- 增加一个 debug 命令或 HTTP 端点用于回放最近 N 条入站/出站消息，便于复现问题。

## 8. 测试矩阵（建议）
- 场景 A：玩家发送 `#help`（纯文本） → Koishi 收到，发送回复为纯文本 → 验证游戏内可见。
- 场景 B：Koishi 发送包含 click/hover 的组件（如果启用 `richComponents`）→ QueQiao 能否正确解析并在客户端展示交互。
- 场景 C：WebSocket 不可用 → RCON 回退；验证 tellraw/say 文本在游戏内的展示情况。
- 场景 D：中文/Emoji/特殊字符的 round-trip 测试。

## 9. 后续步骤（优先级）
1. 在服务器上运行 3 次场景 A、B、C 的完整回环测试，收集日志（见第6节模板）。
2. 若场景 B 失败，进一步获取并分析 QueQiao 的 `websocketManager`/`tool` 模块源码以理解复杂 component 的路由与解析逻辑。
3. 根据测试结果决定是否把 `compatibilityMode` 写入 `src/index.ts` 并发布稳定版。

---
文件位置：`plugins/minecraft-adapter/INTEGRATION.md`
创建时间：2025-08-27
