# ESP32 音频录制网页

现已整合 LED、蜂鸣器、声音强度与温湿度控制台。双入口、控制 API 和历史存储见
[四功能控制台说明](../CONSOLE.md)。本页保留音频协议与录音部署说明。

网页地址：**http://192.168.1.37:8080**。电脑或手机需与 A7S 在同一可互通局域网。

## 使用

1. 等待「麦克风已连接」。MQTT 控制与音频 WebSocket 两个通道都就绪才允许录音。
2. 选择 5、10、20、30 秒之一，点击「开始录音」。默认 10 秒。
3. 对着 INMP441 说话或拍手，完成后使用播放器试听或下载 WAV。

音频为 16kHz、单声道、16 位小端 PCM 的 WAV，10 秒文件为 320,044 字节。
左声道滤除直流，再施加固定 4 倍增益并饱和限制；不代表校准声压级。
接线：WS→IO06、SCK→IO07、SD→IO04、L/R→GND、VDD→3.3V、GND 共地。
GPIO11 的 eFuse 没有修改。DHT11 保持工作，LED 与蜂鸣器现由网页控制，上电均关闭。

## 通道与文件

- MQTT：温湿度、录音命令、设备状态、开始/完成/失败事件。
- WebSocket：ESP32 直连 `ws://192.168.1.37:8080/ws/audio?device=b08184aed020`，只发送二进制音频块。
- HTTP：网页、状态查询、WAV 播放与下载，支持 Range 拖动进度。

音频只在网页发起录音后上传，不通过 MQTT。ESP32 持续排空 I2S，使用固定四块队列与独立发送任务，
每块最多 100ms。网络发送不持有采样锁，超时或队列满则中止录音。
MQTT 保留 32KB outbox 上限、20ms 轮询与 4096 字节缓冲；Wi-Fi 省电关闭。

源码在工程 `audio-web/`，A7S 部署在 `~/esp32-audio-web`。
WAV 与元数据位于其 `data/`，仅保留最新 5 个成功录音；完成新录音和服务启动时自动清理更早的录音。未完成文件不提供播放或下载；
服务重启会清理 `.part`，将中断录音标记失败。可用空间不足 100MB 时拒绝录音。
网页保留失败记录并显示原因；失败记录没有可播放文件。

## 启动与停止

```powershell
ssh a7s 'bash ~/esp32-audio-web/service.sh start'
ssh a7s 'bash ~/esp32-audio-web/service.sh status'
ssh a7s 'tail -f ~/esp32-audio-web/service.log'
ssh a7s 'bash ~/esp32-audio-web/service.sh stop'
```

四合一管理脚本统一启动和停止网页及其 MQTT Broker，不启动旧版后台订阅。服务不设置开机启动。A7S 重启后需要重新运行启动命令。
网页和 WebSocket 分别监听 `192.168.1.37:8080` 与 `100.119.243.21:8080`，Broker 监听 `192.168.1.37:1883`。
默认无登录和 MQTT 认证，作为可信局域网工具运行，不部署到外部托管平台。
WebSocket 的 device 参数用于区分设备，不是认证凭据。

## 部署更新

在本目录执行：

```powershell
ssh a7s 'mkdir -p ~/esp32-audio-web'
scp -r src public test tools package.json package-lock.json service.sh broker.sh README.md a7s:esp32-audio-web/
ssh a7s 'bash ~/esp32-audio-web/service.sh setup'
ssh a7s 'bash ~/esp32-audio-web/service.sh stop'
ssh a7s 'bash ~/esp32-audio-web/service.sh start'
```

`setup` 下载官方 Node.js 24 LTS Linux arm64，校验 SHA-256，解压到 `runtime/node`，
按锁文件安装生产依赖。无需 sudo，不修改系统 Node/Python，不依赖 VS Code 的 Node。
已安装的运行时不会随重复 setup 自动升级。环境变量：`HOST`、`PORT`、`MQTT_URL`、`DATA_DIR`。
ESP32 的音频 URI 在 menuconfig → MQTT Hello World → Audio WebSocket URI 中配置。
组件 `espressif/esp_websocket_client` 固定为 1.8.0，依赖由 `dependencies.lock` 锁定。

## 协议与 API

MQTT 3.1.1、QoS 1、retain=false，前缀 `esp32c3/b08184aed020/audio`：

| 后缀 | 内容 |
| --- | --- |
| `command` | `{"id":"UUID","duration":10}`，接受 5/10/20/30 秒 |
| `event` | `id`、`state`（started/complete/failed）、`reason`、`sample_rate`、`channels`、`bits`、`samples` |
| `status` | 每 5 秒心跳，包含 `online`、`microphone_ready`；有离线遗嘱 |

WebSocket 每条二进制消息的前 24 字节：UUID 原始字节 16 字节、uint32 序号、uint16 样本数、
uint16 保留零；整数为小端，随后是 PCM，每块最多 1600 个样本。没有 MQTT 音频 chunk 订阅。
采样不依赖服务器处理速度缓存整段录音。最近八次命令 UUID 去重，忙碌时拒绝新命令。

A7S 按 UUID 和序号检查样本连续性，重复块去重，缺块失败；完整接收到预期样本数和完成事件后
才生成 WAV。开始确认超时 5 秒，总超时为时长加 10 秒；先收到完成事件可再等最多 5 秒。
WebSocket 使用 Ping/Pong 检测断线，断线立即标记当前录音失败，ESP32 每 2 秒自动重连。
重连后需新建录音，不拼接中断前的数据。

| HTTP 接口 | 功能 |
| --- | --- |
| `GET /api/status` | `broker`、`websocket`、`device`、`microphone`、`active` |
| `POST /api/recordings` | JSON `{"duration":10}`，返回 202；忙碌 409、未就绪 503 |
| `GET /api/recordings` | 录音列表和接收进度 |
| `GET /api/recordings/:id/audio` | WAV 播放，支持 Range |
| `GET /api/recordings/:id/download` | WAV 附件下载 |

网页与 API 同源；拒绝不同源网页的录音 POST 请求。音频设备 WebSocket 拒绝带浏览器 Origin 的连接。

## 测试

```powershell
npm ci
npm test
npm run test:device
node tools/reconnect-check.mjs
```

`npm test` 测试完整 WAV、重复块、缺块、超时、并发、重启恢复、Range、下载以及真实本地
WebSocket 二进制收发与断线处理。
`test:device` 使用电脑已有的 Edge，通过真实网页录制 10 秒，验证媒体解码播放与下载。
结果和截图保存到工程 `build/audio-web-check/`。
`reconnect-check` 进行真实录音并重启 Broker、断开音频 WebSocket，检查失败隔离和重连后恢复。
后两项要求实机在线，会留下测试录音或明确的失败记录。

设备采样值、文件非零和浏览器解码都不等同于音质评价；音质以实际试听为准。

## 当前实测结果

2026-10-17：固件通过 COM14 烧录，WebSocket 实机录音与浏览器检查通过。
10 秒音频含 160,000 个样本，文件 320,044 字节；浏览器可解码播放与下载，
检查到 159,694 个非零样本，未出现满量程削波。桌面、手机宽度页面无横向溢出。
MQTT Broker 中断和音频 WebSocket 单独中断均正确终止当前录音，不暴露半成品；
恢复后分别完成新一段 5 秒录音。DHT11 同时通过校验。
测试生成的失败记录会留在页面中，用于显示中断原因；不含可播放的半成品音频。
