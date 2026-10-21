import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Recordings, PREFIX } from '../src/recordings.js';
import { createApp } from '../src/app.js';
import { attachAudioSocket } from '../src/audio-socket.js';
import WebSocket from 'ws';
import { once } from 'node:events';

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-test-'));
  let clock = 100000;
  const sent = [];
  const r = new Recordings({ directory, now: () => clock, publish: (...args) => sent.push(args) });
  r.setSocket(true); r.setBroker(true); r.ingest(`${PREFIX}/status`, Buffer.from('{"online":true,"microphone_ready":true}'));
  t.after(() => { r.close(); fs.rmSync(directory, {recursive:true,force:true}); });
  return { r, directory, sent, advance: ms => { clock += ms; r.tick(); } };
}
function event(r, item, state, samples = 0) {
  r.ingest(`${PREFIX}/event`, Buffer.from(JSON.stringify({id:item.id,state,sample_rate:16000,channels:1,bits:16,samples})));
}
function chunk(item, sequence, count = 1600) {
  const b = Buffer.alloc(24 + count * 2);
  Buffer.from(item.id.replaceAll('-',''),'hex').copy(b);
  b.writeUInt32LE(sequence,16); b.writeUInt16LE(count,20);
  for (let i=0; i<count; i++) b.writeInt16LE(Math.round(Math.sin((sequence*1600+i)/10)*1000),24+i*2);
  return b;
}
function complete(r, item) {
  event(r,item,'started');
  for (let n=0;n<item.duration*10;n++) r.chunk(chunk(item,n));
  event(r,item,'complete',item.duration*16000);
}
test('complete WAV has correct header, samples and duplicate suppression', t => {
  const {r,directory,sent}=fixture(t); const item=r.start(5);
  assert.equal(sent[0][0],`${PREFIX}/command`);
  event(r,item,'started');
  r.chunk(chunk(item,0)); r.chunk(chunk(item,0));
  assert.equal(item.received_samples,1600);
  for(let n=1;n<50;n++) r.chunk(chunk(item,n));
  assert.equal(item.state,'recording');
  event(r,item,'complete',80000);
  const b=fs.readFileSync(path.join(directory,`${item.id}.wav`));
  assert.equal(item.state,'ready'); assert.equal(b.length,160044);
  assert.equal(b.toString('ascii',0,4),'RIFF'); assert.equal(b.toString('ascii',8,12),'WAVE');
  assert.equal(b.readUInt16LE(22),1); assert.equal(b.readUInt32LE(24),16000);
  assert.equal(b.readUInt16LE(34),16); assert.equal(b.readUInt32LE(40),160000);
});
test('gap, invalid block, timeout and broker loss never expose WAV', t => {
  const {r,directory,advance}=fixture(t);
  let item=r.start(5); event(r,item,'started'); r.chunk(chunk(item,1));
  assert.equal(item.state,'failed'); assert.throws(()=>r.audio(item.id));
  item=r.start(5); const bad=chunk(item,0); bad.writeUInt16LE(1601,20);
  r.chunk(bad); assert.equal(item.state,'failed');
  item=r.start(5); advance(5001); assert.equal(item.state,'failed');
  item=r.start(5); event(r,item,'started'); event(r,item,'complete',80000); advance(5001);
  assert.equal(item.state,'failed');
  item=r.start(5); r.setBroker(false); assert.equal(item.state,'failed');
  assert.throws(()=>r.start(5),{status:503});
  assert.equal(fs.readdirSync(directory).filter(f=>f.endsWith('.wav')||f.endsWith('.part')).length,0);
});
test('concurrent requests and unsupported durations are rejected; restart fails interrupted capture',t=>{
  const {r,directory}=fixture(t);
  assert.throws(()=>r.start(11),{status:400});
  const item=r.start(10); assert.throws(()=>r.start(5),{status:409});
  const recovered=new Recordings({directory,publish:()=>{}});
  assert.equal(recovered.list()[0].state,'failed'); assert.equal(fs.existsSync(path.join(directory,`${item.id}.part`)),false);
});
test('HTTP audio supports Range, download and API validation',async t=>{
  const {r}=fixture(t); const item=r.start(5); complete(r,item);
  const server=createApp(r).listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base=`http://127.0.0.1:${server.address().port}`;
  const range=await fetch(`${base}/api/recordings/${item.id}/audio`,{headers:{Range:'bytes=0-43'}});
  assert.equal(range.status,206); assert.equal((await range.arrayBuffer()).byteLength,44);
  assert.equal(range.headers.get('content-range'),'bytes 0-43/160044');
  const download=await fetch(`${base}/api/recordings/${item.id}/download`);
  assert.equal(download.status,200); assert.match(download.headers.get('content-disposition'),/attachment/);
  assert.equal((await download.arrayBuffer()).byteLength,160044);
  const bad=await fetch(`${base}/api/recordings`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{"duration":2}'});
  assert.equal(bad.status,400);
  const foreign=await fetch(`${base}/api/recordings`,{method:'POST',headers:{Origin:'https://example.com','Content-Type':'application/json'},body:'{"duration":5}'});
  assert.equal(foreign.status,403);
  assert.equal((await fetch(`${base}/api/missing`)).status,404);
});

test('WebSocket receives binary PCM and disconnect fails active recording',async t=>{
  const {r}=fixture(t); r.setSocket(false);
  const server=createApp(r).listen(0,'127.0.0.1');
  const socketServer=attachAudioSocket(server,r);
  await once(server,'listening');
  t.after(async()=>{socketServer.close();await new Promise(resolve=>server.close(resolve));});
  const socket=new WebSocket(`ws://127.0.0.1:${server.address().port}/ws/audio?device=b08184aed020`);
  await once(socket,'open'); assert.equal(r.status().websocket,true);
  let item=r.start(5); event(r,item,'started');
  for(let i=0;i<50;i++)socket.send(chunk(item,i));
  for(let i=0;i<100&&item.received_samples<80000;i++)await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(item.received_samples,80000); event(r,item,'complete',80000);
  assert.equal(item.state,'ready');
  item=r.start(5); socket.terminate();
  for(let i=0;i<100&&item.state!=='failed';i++)await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(item.state,'failed'); assert.equal(r.status().websocket,false);
  assert.throws(()=>r.start(5),{status:503});
});

test('retention keeps newest five WAVs after completion and startup, preserving unrelated data', t => {
  const {r,directory,advance}=fixture(t);
  const completed=[];
  for(let i=0;i<6;i++){
    const item=r.start(5);complete(r,item);completed.push(item);advance(100);
  }
  assert.equal(r.list().filter(item=>item.state==='ready').length,5);
  assert.throws(()=>r.audio(completed[0].id),{status:404});
  assert.equal(fs.existsSync(r.file(completed[0].id,'.wav')),false);
  assert.equal(fs.existsSync(r.file(completed[0].id,'.json')),false);
  for(const item of completed.slice(1))assert.ok(fs.existsSync(r.audio(item.id).filename));
  // Simulate a pre-upgrade directory containing more than five complete recordings.
  fs.writeFileSync(r.file(completed[0].id,'.wav'),Buffer.alloc(44));
  fs.writeFileSync(r.file(completed[0].id,'.json'),JSON.stringify(completed[0]));
  fs.writeFileSync(path.join(directory,'telemetry.sqlite'),'keep');
  const restored=new Recordings({directory,publish:()=>{}});
  assert.deepEqual(restored.list().map(item=>item.id),completed.slice(1).reverse().map(item=>item.id));
  assert.equal(fs.readdirSync(directory).filter(f=>f.endsWith('.wav')).length,5);
  assert.equal(fs.readFileSync(path.join(directory,'telemetry.sqlite'),'utf8'),'keep');
});
