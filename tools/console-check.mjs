import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
import mqtt from 'mqtt';
import {fileURLToPath} from 'node:url';
import fs from 'node:fs';
import {CONTROL} from '../src/device.js';

const base=process.env.AUDIO_WEB_URL||'http://192.168.1.37:8080';
const artifacts=fileURLToPath(new URL('../../build/console-check/',import.meta.url));fs.mkdirSync(artifacts,{recursive:true});
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function json(url,options){const r=await fetch(base+url,options);const data=await r.json();if(!r.ok)throw new Error(data.error);return data;}
async function wait(fn,timeout=15000){const until=Date.now()+timeout;while(Date.now()<until){const result=await fn();if(result)return result;await delay(100);}throw new Error('Console test timeout');}
async function command(target,payload){
  const c=await json('/api/device/'+target,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
  return wait(async()=>{const current=await json('/api/commands/'+c.id);if(current.status==='pending')return false;assert.equal(current.status,'applied',JSON.stringify(current));return current;});
}
const browser=await chromium.launch({channel:'msedge',headless:true});
const client=mqtt.connect('mqtt://192.168.1.37:1883',{protocolVersion:4,clean:true});
try{
  await new Promise((resolve,reject)=>{client.once('connect',resolve);client.once('error',reject);});
  await new Promise((resolve,reject)=>client.subscribe(`${CONTROL}/result`,{qos:1},e=>e?reject(e):resolve()));
  const page=await browser.newPage({viewport:{width:1280,height:1000}}),second=await browser.newPage();
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await Promise.all([page.goto(base),second.goto(base)]);
  await page.getByRole('button',{name:'开启 LED',exact:true}).waitFor();
  await page.waitForFunction(()=>!document.querySelector('[data-control=led]').disabled);
  for(const [button,text]of [['开启 LED','已开启'],['LED 闪烁','闪烁中'],['关闭 LED','已关闭']]){
    await page.getByRole('button',{name:button,exact:true}).click();
    await page.waitForFunction(expected=>document.getElementById('led-state').textContent===expected,text);
    await second.waitForFunction(expected=>document.getElementById('led-state').textContent===expected,text);
  }
  console.log('PASS: LED on/off/blink and two-browser SSE synchronization');
  const beep=await command('buzzer',{mode:'beep',duration_ms:500});
  await wait(async()=>!(await json('/api/device')).buzzer.on);
  let duplicateReply=false;
  client.on('message',(topic,data)=>{const result=JSON.parse(data.toString());if(result.id===beep.id)duplicateReply=true;});
  await new Promise((resolve,reject)=>client.publish(`${CONTROL}/command`,JSON.stringify({id:beep.id,target:'buzzer',mode:'beep',duration_ms:500}),{qos:1,retain:false},e=>e?reject(e):resolve()));
  await wait(()=>duplicateReply);
  for(let i=0;i<8;i++){assert.equal((await json('/api/device')).buzzer.on,false);await delay(100);}
  console.log('PASS: short beep automatically stops; duplicate UUID acknowledged without retriggering');
  await page.getByRole('button',{name:'2 秒',exact:true}).click();
  await page.waitForFunction(()=>document.getElementById('buzzer-state').textContent==='正在鸣叫');
  await page.getByRole('button',{name:'立即停止',exact:true}).click();
  await page.waitForFunction(()=>document.getElementById('buzzer-state').textContent==='已停止');
  console.log('PASS: buzzer webpage beep and immediate stop');
  const device=await json('/api/device');assert.ok(device.sensor.valid&&!device.sensor.stale);assert.ok(!device.microphone.stale);
  assert.ok((await json('/api/telemetry/history?hours=24')).points.some(p=>p.valid));
  await page.reload();await page.waitForFunction(()=>document.getElementById('push-status').textContent==='实时推送已连接');
  assert.equal((await json('/api/device')).led.mode,'off');
  await page.screenshot({path:artifacts+'desktop.png',fullPage:true});
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:artifacts+'mobile.png',fullPage:true});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  assert.deepEqual(errors,[]);
  console.log('PASS: live sensor/microphone, persisted history, SSE reload and responsive layout');
  await second.context().setOffline(true);
  await second.waitForFunction(()=>document.getElementById('push-status').textContent==='实时推送重连中');
  assert.equal(await second.getByRole('button',{name:'开启 LED',exact:true}).isDisabled(),true);
  await second.context().setOffline(false);
  await second.waitForFunction(()=>document.getElementById('push-status').textContent==='实时推送已连接');
  await second.waitForFunction(()=>!document.querySelector('[data-control=led]').disabled);
  assert.equal(await second.locator('#led-state').textContent(),'已关闭');
  console.log('PASS: browser SSE interruption disables controls and reconnect restores a fresh snapshot');
}finally{client.end(true);await browser.close();}
