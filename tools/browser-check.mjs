import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const base = process.env.AUDIO_WEB_URL || 'http://192.168.1.37:8080';
const artifacts = fileURLToPath(new URL('../../build/audio-web-check/', import.meta.url));
fs.mkdirSync(artifacts, {recursive:true});
const browser = await chromium.launch({channel:'msedge',headless:true,args:['--autoplay-policy=no-user-gesture-required']});
try {
  const page=await browser.newPage({viewport:{width:1280,height:960}});
  const errors=[]; page.on('pageerror', error=>errors.push(error.message));
  await page.goto(base);
  await page.getByRole('button',{name:'开始录音'}).waitFor();
  await page.waitForFunction(()=>!document.getElementById('record').disabled,{},{timeout:25000});
  await page.getByLabel('录音时长').selectOption('10');
  const responsePromise=page.waitForResponse(response=>response.url().endsWith('/api/recordings')&&response.request().method()==='POST');
  await page.getByRole('button',{name:'开始录音'}).click();
  const response=await responsePromise;
  assert.equal(response.status(),202);
  const item=await response.json();
  console.log('Started physical ESP32 recording:',item.id);
  // Exercise independent GPIO controls while I2S capture and WebSocket upload are active.
  async function control(target,data){
    const response=await page.request.post(`${base}/api/device/${target}`,{data});
    if(response.status()===404)return; // Older standalone audio service compatibility.
    assert.equal(response.status(),202);
    const command=await response.json();
    for(let i=0;i<50;i++){
      const result=await page.request.get(`${base}/api/commands/${command.id}`);const state=await result.json();
      if(state.status!=='pending'){assert.equal(state.status,'applied');return;}
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    throw new Error('GPIO command timed out during recording');
  }
  await control('led',{mode:'blink'});
  await control('buzzer',{mode:'beep',duration_ms:500});
  await control('led',{mode:'off'});
  const duplicate=await page.request.post(`${base}/api/recordings`,{data:{duration:10}});
  assert.equal(duplicate.status(),409,'Concurrent recording request must be rejected');
  await page.waitForFunction(id=>{
    const player=document.querySelector(`audio[src="/api/recordings/${id}/audio"]`);
    return player && player.readyState>=1;
  },item.id,{timeout:45000});
  const player=page.locator(`audio[src="/api/recordings/${item.id}/audio"]`);
  const duration=await player.evaluate(audio=>audio.duration);
  assert.ok(Math.abs(duration-10)<0.001,`Expected 10 sec, got ${duration}`);
  const playback=await player.evaluate(async audio=>{
    // Headless QA verifies decoding and playback without sending sound to the PC speakers.
    audio.muted = true;
    await audio.play();
    for(let i=0;i<30&&audio.currentTime===0;i++)await new Promise(resolve=>setTimeout(resolve,100));
    const state={time:audio.currentTime,error:audio.error?.message,readyState:audio.readyState,paused:audio.paused};
    audio.pause(); return state;
  });
  assert.ok(playback.time>0); assert.equal(playback.error,undefined);
  const row=page.locator('article').filter({has:player});
  const downloadPromise=page.waitForEvent('download');
  await row.getByRole('link',{name:'下载 WAV ↓'}).click();
  const download=await downloadPromise;
  const filename=path.join(artifacts,'recording-10s.wav'); await download.saveAs(filename);
  const wav=fs.readFileSync(filename);
  assert.equal(wav.length,320044); assert.equal(wav.toString('ascii',0,4),'RIFF');
  assert.equal(wav.readUInt32LE(24),16000); assert.equal(wav.readUInt16LE(22),1);
  assert.equal(wav.readUInt16LE(34),16); assert.equal(wav.readUInt32LE(40),320000);
  let nonzero=0,squares=0,peak=0,clipped=0;
  for(let i=44;i<wav.length;i+=2){const n=wav.readInt16LE(i);nonzero+=n!==0;squares+=n*n;peak=Math.max(peak,Math.abs(n));clipped+=Math.abs(n)>=32767;}
  assert.ok(nonzero>1000,'Recorded PCM is silent or missing');
  await page.screenshot({path:path.join(artifacts,'desktop.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:path.join(artifacts,'mobile.png'),fullPage:true});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({id:item.id,duration,bytes:wav.length,samples:160000,nonzero,peak,rms:Math.sqrt(squares/160000),clipped,playback,filename},null,2));
  console.log('PASS: browser record, WAV decoding/playback, download, mobile layout');
} finally { await browser.close(); }
