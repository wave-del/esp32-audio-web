# ESP32-C3 四功能控制台

## 访问与操作

- 局域网：**http://192.168.1.37:8080**。
- Tailscale：**http://100.119.243.21:8080**，访问设备需要已连接同一个 tailnet 且允许访问 A7S。
- 保留原有 `https://radxa-cubie-a7s.tail327228.ts.net` 入口，它仍代理原来的服务。

| 外设 | 接线 | 控制台功能 |
| --- | --- | --- |
| LED | GPIO10，高电平点亮 | 开、关、亮半秒灭半秒闪烁 |
| 蜂鸣器 | GPIO3，低电平触发 | 0.5/1/2 秒短鸣、立即停止 |
| DHT11 | DATA=GPIO2 | 每 30 分钟温湿度、故障提示、近 1/6/24 小时趋势 |
| INMP441 | WS=6、SCK=7、SD=4，L/R 接地 | 每秒相对声音强度；5/10/20/30 秒录音、试听与 WAV 下载 |

上电 LED 与蜂鸣器均关闭，不再开机鸣叫。断网立即停止蜂鸣器，LED 保持原模式。
LED/蜂鸣器显示设备确认的输出配置，没有光线或声音反馈传感器证明实际物理效果。
录音仍为 16kHz、单声道、16 位 PCM，只保留最新 5 个成功录音；每次录音成功后及服务启动时自动删除较旧 WAV 与对应元数据。蜂鸣器短鸣会被附近麦克风录入，
靠近声源可能出现削波；采样和传输完整不等于音质经过评价。

## 通信与状态

设备使用 A7S 局域网地址：MQTT 控制、状态、温湿度和声音强度；WebSocket 传输音频。
浏览器无论从哪个入口访问，均使用相对地址 HTTP API 与 SSE，不能直接连设备或 MQTT。

控制主题前缀为 `esp32c3/b08184aed020/control`：

- `/command`：UUID `id`、`target`（led/buzzer）、`mode`（LED 为 off/on/blink；蜂鸣器为 beep/stop）、
  `duration_ms`（响铃时为 500/1000/2000）。QoS 1、retain=false，离线不缓存重放。
- `/result`：`id`、`status`（applied/rejected）、`reason` 和 `state`。只有执行回报才确认成功。
- `/state`：LED 模式、蜂鸣器状态、版本、启动随机标识与运行时长，每 5 秒及变化时发送。
- `/microphone`：每秒 RMS、峰值和是否存在非零采样，属于相对强度，不是校准分贝。

最近 16 个命令结果在 ESP32 内存中去重；重发同一 UUID 不重复鸣叫。
蜂鸣器响铃中拒绝新的响铃命令，停止始终可用；本地定时结束不依赖 A7S。
服务端等待确认最多 5 秒，超时显示不确定结果、不自动重发；最新设备状态用于后续同步。
启动标识与状态版本防止旧执行结果覆盖新状态。

DHT11 保留 `esp32c3/dht11` 主题，成功含 `valid:true` 和数值，失败含 `valid:false` 与错误。
网页保留最后有效温湿度；超过 31 分钟未更新或设备离线时标记过期，失败不能作为新有效值。
SQLite 数据库位于 A7S `~/esp32-audio-web/data/telemetry.sqlite`，保存近 24 小时原始采样和失败记录，
每分钟清理过期行。按分钟聚合曲线，有失败或缺失的区间留空，不插值。历史从本功能启用后开始累积。

## API

| 接口 | 功能 |
| --- | --- |
| `GET /api/device` | 外设、连接和最近命令状态 |
| `POST /api/device/led` | `{"mode":"on"}` 或 off/blink |
| `POST /api/device/buzzer` | `{"mode":"beep","duration_ms":500}` 或 `{"mode":"stop"}` |
| `GET /api/commands/:id` | pending/applied/rejected/timeout/failed |
| `GET /api/telemetry/history?hours=24` | 1/6/24 小时分钟聚合与空缺 |
| `GET /api/events` | `snapshot` SSE 事件，包含设备、录音状态与录音列表 |

控制 POST 返回 202 表示请求已提交，不表示已执行；参数错误 400，外设已有待执行命令或忙碌 409，离线 503。
已有 `/api/status`、录音列表、创建录音、播放与下载接口保持兼容，见 [音频说明](audio-web/README.md)。

## 运行与部署

本机工程 `D:/esp32/ESP32_projects/sample_project`，A7S 服务目录 `~/esp32-audio-web`。

```powershell
ssh a7s 'bash ~/esp32-audio-web/service.sh start'
ssh a7s 'bash ~/esp32-audio-web/service.sh status'
ssh a7s 'tail -f ~/esp32-audio-web/service.log'
ssh a7s 'bash ~/esp32-audio-web/service.sh stop'
```

默认分别监听 `192.168.1.37:8080` 和 `100.119.243.21:8080`。`HOSTS` 可设置逗号分隔地址；
兼容单个 `HOST`，`PORT` 默认 8080。某个地址暂不可绑定时其他入口继续服务，并每 10 秒重试。
service.sh 统一管理网页和必需的 MQTT Broker；broker.sh 可单独管理 Broker。旧的 a7s-mqtt.sh 已删除，不再启动 Hello World 后台订阅。
没有设置开机启动，没有修改已有 Tailscale Serve 配置，没有开放公网监听。
部署脚本、Node 运行时及安装方式沿用音频说明。更新时只复制源码和脚本，不覆盖 `data/`。

## 测试及当前边界

```powershell
Set-Location D:/esp32/ESP32_projects/sample_project/audio-web
npm test
node tools/console-check.mjs
npm run test:device
node tools/reconnect-check.mjs
```

自动测试覆盖确认后更新、超时、离线、旧结果、历史持久化、失败空缺、24 小时清理、SSE、
音频重组、WebSocket 断线、播放 Range 和下载。
实机测试包括 LED 三种模式、短鸣自动停止、重复 UUID 不重触发、立即停止、双浏览器同步；
10 秒录音期间同时控制 LED/蜂鸣器，样本数保持 160,000，WAV 320,044 字节。

2026-10-19：局域网与 A7S 本机到 Tailscale 监听地址通过检查。
10 项自动测试通过；实机验证浏览器断网时禁用控制、恢复后重新同步状态。
A7S 服务重启前后均保留 98 条已收到的历史采样。10 秒录音同时执行 LED/蜂鸣器控制，
文件长度与样本数完整；该测试录入了蜂鸣器声音并出现部分削波，不宣称音质已通过人工试听。
用户已于 2026-10-19 确认 Tailscale 访问正常。旧版 Hello World 后台订阅和管理脚本已移除；只保留四合一网页及必要的 MQTT Broker。
