import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Device,CONTROL} from '../src/device.js';
import {createApp} from '../src/app.js';

function fixture(t){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'device-test-'));
  let clock=100000,online=true,closed=false;
  const sent=[];
  const recordings={status:()=>({device:online,broker:online,websocket:true,microphone:online,active:null}),list:()=>[]};
  const d=new Device({directory,recordings,now:()=>clock,publish:(...args)=>sent.push(args)});
  const state={led_mode:'off',buzzer_on:false,version:0,boot_id:1,uptime_ms:1000};
  const ingest=(topic,value)=>d.ingest(topic,Buffer.from(JSON.stringify(value)));
  ingest(`${CONTROL}/state`,state);
  t.after(()=>{if(!closed)d.close();fs.rmSync(directory,{recursive:true,force:true});});
  return {d,recordings,sent,ingest,state,directory,advance:ms=>{clock+=ms;d.tick();},offline:()=>{online=false;d.tick();},close:()=>{d.close();closed=true;}};
}
test('only execution result confirms controls; timeout, busy and stale results',t=>{
  const {d,ingest,state,sent,advance}=fixture(t);
  const command=d.command('led',{mode:'on'});
  assert.equal(command.status,'pending');assert.equal(d.snapshot().led.mode,'off');
  assert.equal(sent[0][0],`${CONTROL}/command`);
  assert.throws(()=>d.command('led',{mode:'blink'}),{status:409});
  ingest(`${CONTROL}/result`,{id:command.id,status:'applied',state:{...state,led_mode:'on',version:1,uptime_ms:1100}});
  assert.equal(command.status,'applied');assert.equal(d.snapshot().led.mode,'on');
  const newer=d.command('led',{mode:'blink'});
  ingest(`${CONTROL}/state`,{...state,led_mode:'blink',version:3,uptime_ms:3000});
  ingest(`${CONTROL}/result`,{id:newer.id,status:'applied',state:{...state,led_mode:'on',version:2,uptime_ms:2000}});
  assert.equal(d.snapshot().led.mode,'blink');
  const lost=d.command('led',{mode:'off'});advance(5000);
  assert.equal(lost.status,'timeout');assert.equal(d.snapshot().led.mode,'blink');
  ingest(`${CONTROL}/result`,{id:lost.id,status:'applied',state:{...state,version:4,uptime_ms:4000}});
  assert.equal(lost.status,'timeout');
  ingest(`${CONTROL}/state`,{...state,buzzer_on:true,version:5,uptime_ms:5000});
  assert.throws(()=>d.command('buzzer',{mode:'beep',duration_ms:500}),{status:409});
  assert.equal(d.command('buzzer',{mode:'stop'}).status,'pending');
  assert.throws(()=>d.command('buzzer',{mode:'beep',duration_ms:60000}),{status:400});
});
test('sensor failures retain last good reading, persist and leave chart gaps',t=>{
  const {d,ingest,advance,directory,close,recordings}=fixture(t);
  ingest('esp32c3/dht11',{valid:true,temperature_c:24.4,humidity_percent:56});
  assert.equal(d.snapshot().sensor.temperature_c,24.4);
  advance(1000);ingest('esp32c3/dht11',{valid:false,error:'ESP_ERR_TIMEOUT'});
  assert.equal(d.snapshot().sensor.valid,false);assert.equal(d.snapshot().sensor.temperature_c,24.4);
  assert.equal(d.history(1).points.filter(p=>p.valid).length,0);
  advance(60000);ingest('esp32c3/dht11',{valid:true,temperature_c:25,humidity_percent:60});
  assert.equal(d.history(1).points.filter(p=>p.valid).length,1);
  close();const restored=new Device({directory,recordings,publish:()=>{},now:()=>161000});
  assert.equal(restored.snapshot().sensor.temperature_c,25);assert.ok(restored.snapshot().sensor.stale);
  restored.close();assert.throws(()=>d.history(2),{status:400});
});
test('offline commands fail, device reboot establishes fresh state',t=>{
  const {d,ingest,state,advance,offline}=fixture(t);
  d.command('led',{mode:'on'});offline();assert.equal([...d.commands.values()][0].status,'failed');
  assert.throws(()=>d.command('buzzer',{mode:'stop'}),{status:503});
  ingest(`${CONTROL}/state`,{...state,version:99,uptime_ms:99999});
  ingest(`${CONTROL}/state`,{...state,boot_id:2,version:0,uptime_ms:100});
  assert.equal(d.state.boot_id,2);advance(15000);assert.equal(d.snapshot().online,false);
});
test('24-hour retention removes expired samples',t=>{
  const {d,ingest,advance}=fixture(t);
  ingest('esp32c3/dht11',{temperature_c:22,humidity_percent:50});
  advance(86400001);
  assert.equal(d.db.prepare('SELECT COUNT(*) AS n FROM sensor').get().n,0);
  assert.equal(d.history(24).points.filter(p=>p.valid).length,0);
});
test('device HTTP API and SSE send a fresh complete snapshot',async t=>{
  const {d,recordings}=fixture(t);
  const server=createApp(recordings,d).listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
  const base=`http://127.0.0.1:${server.address().port}`;
  const response=await fetch(base+'/api/device/led',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"mode":"on"}'});
  assert.equal(response.status,202);const command=await response.json();
  assert.equal((await fetch(base+'/api/commands/'+command.id).then(r=>r.json())).status,'pending');
  const abort=new AbortController();
  const sse=await fetch(base+'/api/events',{signal:abort.signal});
  assert.match(sse.headers.get('content-type'),/text\/event-stream/);
  const reader=sse.body.getReader();const block=await reader.read();
  const text=new TextDecoder().decode(block.value);assert.match(text,/event: snapshot/);assert.match(text,/"led_mode"|"led"/);
  abort.abort();await reader.cancel().catch(()=>{});
  assert.equal((await fetch(base+'/api/telemetry/history?hours=2')).status,400);
});
test('half-hour sensor cadence stays fresh between samples and expires after grace period',t=>{
  const {d,ingest,state,advance}=fixture(t);
  ingest('esp32c3/dht11',{valid:true,temperature_c:23,humidity_percent:55});
  const heartbeat=()=>ingest(`${CONTROL}/state`,state);
  advance(29*60*1000);heartbeat();
  assert.equal(d.snapshot().sensor.stale,false);
  assert.equal(d.snapshot().sensor.sample_interval_ms,1800000);
  advance(60*1000);heartbeat();assert.equal(d.snapshot().sensor.stale,false);
  advance(60*1000);heartbeat();assert.equal(d.snapshot().sensor.stale,true);
  ingest('esp32c3/dht11',{valid:false,error:'ESP_ERR_TIMEOUT'});
  assert.equal(d.snapshot().sensor.stale,false);assert.equal(d.snapshot().sensor.valid,false);
  assert.equal(d.snapshot().sensor.temperature_c,23);
});
