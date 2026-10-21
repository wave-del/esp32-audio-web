import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function createApp(recordings, device = null) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1kb' }));
  // This is a LAN tool. Reject cross-origin commands from unrelated websites.
  app.use((req, res, next) => {
    if (req.method === 'POST' && req.get('origin')) {
      try {
        if (new URL(req.get('origin')).host !== req.get('host')) return res.status(403).json({ error: '请求来源不匹配' });
      } catch { return res.status(403).json({ error: '无效请求来源' }); }
    }
    next();
  });
  app.get('/api/status', (req, res) => res.json(recordings.status()));
  app.get('/api/recordings', (req, res) => res.json(recordings.list()));
  app.post('/api/recordings', (req, res) => {
    if(device && !device.snapshot().online)return res.status(503).json({error:'设备未就绪'});
    res.status(202).json(recordings.start(req.body?.duration));
  });
  if(device){
    app.get('/api/device',(req,res)=>res.json(device.snapshot()));
    app.post('/api/device/led',(req,res)=>res.status(202).json(device.command('led',req.body)));
    app.post('/api/device/buzzer',(req,res)=>res.status(202).json(device.command('buzzer',req.body)));
    app.get('/api/commands/:id',(req,res)=>res.json(device.getCommand(req.params.id)));
    app.get('/api/telemetry/history',(req,res)=>res.json(device.history(Number(req.query.hours||24))));
    app.get('/api/events',(req,res)=>{
      res.set({'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive'});
      res.flushHeaders();
      let previous='',blocked=false;
      const send=()=>{
        if(blocked)return;
        const data=JSON.stringify({device:device.snapshot(),audio:recordings.status(),recordings:recordings.list()});
        if(data!==previous){previous=data;blocked=!res.write(`event: snapshot\ndata: ${data}\n\n`);}
      };
      res.on('drain',()=>{blocked=false;send();});
      send();const timer=setInterval(send,1000);
      const ping=setInterval(()=>{if(!blocked)blocked=!res.write(': keepalive\n\n');},10000);
      req.on('close',()=>{clearInterval(timer);clearInterval(ping);});
    });
  }
  app.get('/api/recordings/:id/audio', (req, res) => {
    const { filename } = recordings.audio(req.params.id);
    res.type('audio/wav').sendFile(filename);
  });
  app.get('/api/recordings/:id/download', (req, res) => {
    const { filename, item } = recordings.audio(req.params.id);
    res.download(filename, `esp32-${item.created_at.replace(/[:.]/g, '-')}.wav`);
  });
  app.use('/api', (req, res) => res.status(404).json({ error: '接口不存在' }));
  app.use(express.static(path.join(path.dirname(fileURLToPath(import.meta.url)), '../public')));
  app.use((error, req, res, next) => {
    console.error(error.message);
    if (!res.headersSent) res.status(error.status || 500).json({ error: error.status ? error.message : '服务错误，请检查 A7S 日志' });
    else next(error);
  });
  return app;
}
