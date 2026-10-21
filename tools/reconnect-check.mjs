import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import WebSocket from 'ws';
import { once } from 'node:events';

const base=process.env.AUDIO_WEB_URL || 'http://192.168.1.37:8080';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function json(route,options) {
  const response=await fetch(base+route,options); return {status:response.status,data:await response.json()};
}
async function waitFor(callback, timeout=25000) {
  const until=Date.now()+timeout;
  while(Date.now()<until){const result=await callback();if(result)return result;await sleep(500);}
  throw new Error('Device integration timeout');
}
function broker(action){
  const result=execFileSync('ssh',['-o','BatchMode=yes','-o','ConnectTimeout=8','a7s',`bash ~/esp32-audio-web/broker.sh ${action}`],{encoding:'utf8'});
  console.log(result.trim());
}
const post=()=>json('/api/recordings',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"duration":5}'});
await waitFor(async()=> (await json('/api/status')).data.microphone);
const initial=await post(); assert.equal(initial.status,202);
await waitFor(async()=> (await json('/api/recordings')).data.find(r=>r.id===initial.data.id&&r.received_samples>=3200));
try {
  broker('stop');
  await waitFor(async()=> !(await json('/api/status')).data.broker);
  const offline=await post(); assert.equal(offline.status,503);
  const broken=(await json('/api/recordings')).data.find(r=>r.id===initial.data.id);
  assert.equal(broken.state,'failed');
  assert.equal((await fetch(`${base}/api/recordings/${broken.id}/audio`)).status,404);
  console.log('PASS: broker loss fails capture, partial audio hidden, offline start rejected');
} finally {broker('start');}
await waitFor(async()=> (await json('/api/status')).data.microphone,30000);
const recovered=await post(); assert.equal(recovered.status,202);
const ready=await waitFor(async()=>{
  const item=(await json('/api/recordings')).data.find(r=>r.id===recovered.data.id);
  if(item.state==='failed')throw new Error(item.error);
  return item.state==='ready'&&item;
},25000);
assert.equal(ready.received_samples,80000); assert.equal(ready.bytes,160044);
console.log('PASS: reconnect and new physical recording',JSON.stringify(ready));

// Replace the device socket briefly to force a real audio-only disconnect, while MQTT stays up.
const interrupted=await post();assert.equal(interrupted.status,202);
await waitFor(async()=> (await json('/api/recordings')).data.find(r=>r.id===interrupted.data.id&&r.received_samples>=3200));
const probe=new WebSocket(base.replace(/^http/,'ws')+'/ws/audio?device=b08184aed020');
await once(probe,'open');probe.terminate();
await waitFor(async()=> (await json('/api/recordings')).data.find(r=>r.id===interrupted.data.id&&r.state==='failed'));
assert.equal((await json('/api/status')).data.broker,true);
assert.equal((await fetch(`${base}/api/recordings/${interrupted.data.id}/audio`)).status,404);
await waitFor(async()=> (await json('/api/status')).data.microphone,30000);
const wsRecovered=await post();assert.equal(wsRecovered.status,202);
const wsReady=await waitFor(async()=>{
  const item=(await json('/api/recordings')).data.find(r=>r.id===wsRecovered.data.id);
  if(item.state==='failed')throw new Error(item.error);
  return item.state==='ready'&&item;
},25000);
assert.equal(wsReady.bytes,160044);
console.log('PASS: audio-only WebSocket interruption, automatic reconnect and new recording',wsReady.id);
