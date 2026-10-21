import assert from 'node:assert/strict';

const lan='http://192.168.1.37:8080',tail='http://100.119.243.21:8080';
for(const base of [lan,tail]){
  assert.equal((await fetch(base)).status,200);
  const device=await fetch(base+'/api/device').then(r=>r.json());assert.ok(device.online);
  assert.ok(device.sensor.valid&&!device.sensor.stale);
  const history=await fetch(base+'/api/telemetry/history?hours=24').then(r=>r.json());
  assert.ok(history.points.some(p=>p.valid));
  const abort=new AbortController();const sse=await fetch(base+'/api/events',{signal:abort.signal});
  assert.match(sse.headers.get('content-type'),/text\/event-stream/);
  const reader=sse.body.getReader();const block=await reader.read();
  assert.match(new TextDecoder().decode(block.value),/event: snapshot/);
  abort.abort();await reader.cancel().catch(()=>{});
  const recording=(await fetch(base+'/api/recordings').then(r=>r.json())).find(r=>r.state==='ready');assert.ok(recording);
  const response=await fetch(`${base}/api/recordings/${recording.id}/audio`,{headers:{Range:'bytes=0-43'}});
  assert.equal(response.status,206);assert.equal((await response.arrayBuffer()).byteLength,44);
  const download=await fetch(`${base}/api/recordings/${recording.id}/download`);
  assert.match(download.headers.get('content-disposition'),/attachment/);assert.equal((await download.arrayBuffer()).byteLength,recording.bytes);
  console.log('PASS: listener HTML, telemetry, SSE, WAV Range and download',base);
}
const response=await fetch(tail+'/api/device/led',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"mode":"off"}'});
assert.equal(response.status,202);let command=await response.json();
for(let i=0;i<50&&command.status==='pending';i++){
  await new Promise(resolve=>setTimeout(resolve,100));command=await fetch(tail+'/api/commands/'+command.id).then(r=>r.json());
}
assert.equal(command.status,'applied');assert.equal((await fetch(lan+'/api/device').then(r=>r.json())).led.mode,'off');
console.log('PASS: Tailscale listener command applied and visible via LAN');
console.log('Scope: this check runs on A7S itself; remote Windows Tailscale verification is separate.');
