import mqtt from 'mqtt';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { Recordings, PREFIX } from './recordings.js';
import { createApp } from './app.js';
import { attachAudioSocket } from './audio-socket.js';
import { Device, CONTROL } from './device.js';

const hosts=[...new Set((process.env.HOSTS||process.env.HOST||'192.168.1.37,100.119.243.21').split(',').map(s=>s.trim()).filter(Boolean))];
const port=Number(process.env.PORT||8080);
const client=mqtt.connect(process.env.MQTT_URL||'mqtt://192.168.1.37:1883',{
  protocolVersion:4,clean:true,reconnectPeriod:2000,connectTimeout:5000,
  clientId:`a7s-control-web-${process.pid}`,queueQoSZero:false,
});
const directory=process.env.DATA_DIR||fileURLToPath(new URL('../data',import.meta.url));
const publish=(topic,data,callback)=>{
  if(!client.connected){callback?.(new Error('MQTT offline'));return;}
  client.publish(topic,data,{qos:1,retain:false},callback);
};
const recordings=new Recordings({directory,publish});
const device=new Device({directory,recordings,publish});
client.on('connect',()=>{
  client.subscribe([`${PREFIX}/status`,`${PREFIX}/event`,`${CONTROL}/state`,`${CONTROL}/result`,`${CONTROL}/microphone`,'esp32c3/dht11'],{qos:1},(error,granted)=>{
    if(error||granted?.some(g=>g.qos===128)){console.error('MQTT subscription failed',error);recordings.setBroker(false);return;}
    recordings.setBroker(true);console.info('MQTT device subscriptions ready');
  });
});
client.on('message',(topic,data)=>{recordings.ingest(topic,data);device.ingest(topic,data);});
client.on('offline',()=>recordings.setBroker(false));
client.on('close',()=>recordings.setBroker(false));
client.on('error',error=>console.warn('MQTT:',error.message));
const timer=setInterval(()=>{recordings.tick();device.tick();},250);
const app=createApp(recordings,device);
const servers=hosts.map(()=>http.createServer(app));
const audioSocket=attachAudioSocket(servers,recordings);
let stopping=false;
const retries=new Set();
function listen(server,host){
  if(stopping)return;
  server.listen(port,host,()=>console.info(`ESP32 console: http://${host}:${port}`));
}
for(let i=0;i<servers.length;i++){
  const server=servers[i],host=hosts[i];
  server.on('error',error=>{
    console.error(`Listener ${host}:${port}:`,error.message);
    if(stopping)return;
    const retry=setTimeout(()=>{retries.delete(retry);listen(server,host);},10000);retries.add(retry);
  });
  listen(server,host);
}
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{
  if(stopping)return;stopping=true;
  clearInterval(timer);for(const retry of retries)clearTimeout(retry);
  recordings.close();audioSocket.close();device.close();
  for(const server of servers)server.close();
  client.end(true,()=>process.exit(0));
  setTimeout(()=>process.exit(0),2000).unref();
});
