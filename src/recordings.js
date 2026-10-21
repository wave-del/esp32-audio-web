import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const PREFIX = 'esp32c3/b08184aed020/audio';
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RATE = 16000;
export function wavHeader(samples) {
  const b = Buffer.alloc(44);
  b.write('RIFF'); b.writeUInt32LE(36 + samples * 2, 4); b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(RATE, 24); b.writeUInt32LE(RATE * 2, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36);
  b.writeUInt32LE(samples * 2, 40); return b;
}
export class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export class Recordings {
  constructor({ directory, publish, now = Date.now }) {
    this.directory = path.resolve(directory); this.publish = publish; this.now = now;
    this.items = new Map(); this.active = null; this.broker = false; this.lastSeen = 0;
    this.microphoneReady = false;
    this.socketConnected = false;
    fs.mkdirSync(this.directory, { recursive: true });
    for (const file of fs.readdirSync(this.directory)) {
      if (file.endsWith('.part')) fs.unlinkSync(path.join(this.directory, file));
      if (file.endsWith('.json') && UUID.test(file.slice(0, -5))) {
        try {
          const item = JSON.parse(fs.readFileSync(path.join(this.directory, file), 'utf8'));
          if (item.id !== file.slice(0, -5)) continue;
          if (['pending', 'recording'].includes(item.state)) {
            item.state = 'failed'; item.error = '服务重启，录音已中断';
          }
          if (item.state === 'ready' && !fs.existsSync(this.file(item.id, '.wav'))) {
            item.state = 'failed'; item.error = '录音文件不存在';
          }
          this.items.set(item.id, item); this.save(item);
        } catch (error) { console.error('Cannot load recording metadata:', file, error.message); }
      }
    }
    this.pruneRecordings();
  }
  pruneRecordings() {
    const expired = this.list().filter(item => item.state === 'ready').slice(5);
    for (const item of expired) {
      fs.rmSync(this.file(item.id, '.wav'), { force: true });
      fs.rmSync(this.file(item.id, '.json'), { force: true });
      this.items.delete(item.id);
    }
  }
  file(id, suffix) { return path.join(this.directory, `${id}${suffix}`); }
  save(item) {
    const temporary = this.file(item.id, '.json.tmp');
    fs.writeFileSync(temporary, JSON.stringify(item, null, 2));
    fs.renameSync(temporary, this.file(item.id, '.json'));
  }
  status() {
    const online = this.broker && this.lastSeen > 0 && this.now() - this.lastSeen < 15000;
    return { broker: this.broker, websocket: this.socketConnected, device: online,
      microphone: online && this.microphoneReady && this.socketConnected,
      active: this.active ? this.items.get(this.active.id) : null };
  }
  list() { return [...this.items.values()].sort((a, b) => b.created_at.localeCompare(a.created_at)); }
  setBroker(connected) {
    this.broker = connected; this.lastSeen = 0; this.microphoneReady = false;
    if (!connected && this.active) this.fail('MQTT 连接中断，录音未完成');
  }
  setSocket(connected) {
    this.socketConnected = connected;
    if (!connected && this.active) this.fail('音频 WebSocket 连接中断，录音未完成');
  }
  start(duration) {
    if (![5, 10, 20, 30].includes(duration)) throw new ApiError(400, '请选择 5、10、20 或 30 秒');
    if (this.active) throw new ApiError(409, '已有录音正在进行');
    if (!this.status().microphone) throw new ApiError(503, '麦克风设备未就绪，请检查设备与 MQTT 连接');
    const disk = fs.statfsSync(this.directory);
    if (Number(disk.bavail) * Number(disk.bsize) < 100 * 1024 * 1024) throw new ApiError(507, 'A7S 可用空间不足 100MB');
    const id = randomUUID();
    const item = { id, duration, state: 'pending', created_at: new Date(this.now()).toISOString(),
      sample_rate: RATE, channels: 1, bits: 16, gain: 4, received_samples: 0, error: null };
    const fd = fs.openSync(this.file(id, '.part'), 'wx');
    try { fs.writeSync(fd, Buffer.alloc(44)); }
    catch (error) { fs.closeSync(fd); fs.unlinkSync(this.file(id, '.part')); throw error; }
    this.active = { id, fd, sequence: 0, deadline: this.now() + 5000, ended: false };
    this.items.set(id, item);
    try {
      this.save(item);
      this.publish(`${PREFIX}/command`, JSON.stringify({ id, duration }), (error) => {
        if (error && this.active?.id === id) this.fail('录音命令发送失败');
      });
    } catch (error) { this.fail('无法发送录音命令'); throw error; }
    return item;
  }
  fail(message) {
    const active = this.active; if (!active) return;
    this.active = null;
    const item = this.items.get(active.id); item.state = 'failed'; item.error = message;
    try { fs.closeSync(active.fd); } catch {}
    fs.rmSync(this.file(active.id, '.part'), { force: true });
    this.save(item);
    console.warn('Recording failed:', active.id, message);
  }
  finishIfReady() {
    const active = this.active; if (!active?.ended) return;
    const item = this.items.get(active.id);
    if (item.received_samples !== item.duration * RATE) return;
    fs.writeSync(active.fd, wavHeader(item.received_samples), 0, 44, 0);
    fs.fsyncSync(active.fd); fs.closeSync(active.fd); active.fd = -1;
    fs.renameSync(this.file(item.id, '.part'), this.file(item.id, '.wav'));
    item.state = 'ready'; item.bytes = 44 + item.received_samples * 2;
    item.completed_at = new Date(this.now()).toISOString();
    this.save(item); this.active = null;
    this.pruneRecordings();
    console.info('Recording ready:', item.id, item.bytes, 'bytes');
  }
  tick() {
    if (this.active && this.now() > this.active.deadline) {
      const item = this.items.get(this.active.id);
      this.fail(item.state === 'pending' ? '设备未在 5 秒内确认录音命令' : '音频传输超时或缺少数据');
    }
  }
  ingest(topic, payload) {
    try {
      if (topic === `${PREFIX}/status`) {
        const status = JSON.parse(payload.toString());
        this.lastSeen = status.online === true ? this.now() : 0;
        this.microphoneReady = status.microphone_ready === true;
        if (!status.online && this.active) this.fail('设备已离线，录音中断');
      } else if (topic === `${PREFIX}/event`) {
        const event = JSON.parse(payload.toString());
        if (!this.active || event.id !== this.active.id) return;
        const item = this.items.get(event.id);
        if (event.state === 'failed') { this.fail(`设备报告录音失败：${event.reason || 'unknown'}`); return; }
        if (event.sample_rate !== RATE || event.channels !== 1 || event.bits !== 16) {
          this.fail('设备报告的音频格式不匹配'); return;
        }
        if (event.state === 'started' && item.state === 'pending') {
          item.state = 'recording'; item.started_at = new Date(this.now()).toISOString();
          this.active.deadline = this.now() + (item.duration + 10) * 1000;
          this.save(item);
        } else if (event.state === 'complete') {
          if (event.samples !== item.duration * RATE) { this.fail('设备报告的总样本数不匹配'); return; }
          this.active.ended = true; this.active.deadline = this.now() + 5000;
          this.finishIfReady();
        }
      }
    } catch (error) {
      console.error('Audio message error:', error.message);
      if (this.active) this.fail('音频消息处理失败，请重新录音');
    }
  }
  chunk(payload) {
    if (!this.active || payload.length < 24) return;
    const hex = payload.subarray(0, 16).toString('hex');
    const id = `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
    if (id !== this.active.id) return;
    const item = this.items.get(id);
    const sequence = payload.readUInt32LE(16), count = payload.readUInt16LE(20);
    if (sequence < this.active.sequence) return; // QoS 1 duplicate.
    if (sequence !== this.active.sequence) { this.fail('音频分块缺失，未保存不完整录音'); return; }
    if (count < 1 || count > 1600 || payload.length !== 24 + count * 2 || payload.readUInt16LE(22) !== 0 ||
        item.received_samples + count > item.duration * RATE) {
      this.fail('音频分块长度或样本数错误'); return;
    }
    const data = payload.subarray(24);
    let written = 0;
    while (written < data.length) written += fs.writeSync(this.active.fd, data, written, data.length - written);
    item.received_samples += count; ++this.active.sequence;
    this.finishIfReady();
  }
  audio(id) {
    const item = this.items.get(id);
    if (!UUID.test(id) || !item || item.state !== 'ready') throw new ApiError(404, '录音不存在或尚未完成');
    return { item, filename: this.file(id, '.wav') };
  }
  close() { if (this.active) this.fail('服务已停止，录音中断'); }
}
