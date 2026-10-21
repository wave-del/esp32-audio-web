import { WebSocketServer, WebSocket } from 'ws';

export function attachAudioSocket(server, recordings) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 3224, perMessageDeflate: false });
  let current = null;
  for(const listener of (Array.isArray(server)?server:[server]))listener.on('upgrade', (request, socket, head) => {
    let url;
    try { url = new URL(request.url, 'http://localhost'); } catch { socket.destroy(); return; }
    if (url.pathname !== '/ws/audio' || url.searchParams.get('device') !== 'b08184aed020' || request.headers.origin) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
    }
    wss.handleUpgrade(request, socket, head, ws => wss.emit('connection', ws));
  });
  wss.on('connection', ws => {
    if (current) { recordings.setSocket(false); current.terminate(); }
    current = ws; ws.alive = true; recordings.setSocket(true);
    console.info('ESP32 audio WebSocket connected');
    ws.on('pong', () => { ws.alive = true; });
    ws.on('message', (data, binary) => {
      if (ws !== current) return;
      if (!binary) { ws.close(1003, 'Binary PCM required'); return; }
      try { recordings.chunk(data); }
      catch (error) { console.error('Audio write:', error.message); recordings.fail('音频写入失败'); ws.close(1011); }
    });
    ws.on('close', () => {
      if (ws === current) { current = null; recordings.setSocket(false); console.info('ESP32 audio WebSocket disconnected'); }
    });
    ws.on('error', error => console.warn('Audio WebSocket:', error.message));
  });
  const timer = setInterval(() => {
    if (!current || current.readyState !== WebSocket.OPEN) return;
    if (!current.alive) { current.terminate(); return; }
    current.alive = false; current.ping();
  }, 5000);
  return {
    close() { clearInterval(timer); for (const ws of wss.clients) ws.terminate(); wss.close(); },
  };
}
