const $ = id => document.getElementById(id);
const rows = new Map();
let submitting = false;
const states = {pending:'等待设备',recording:'录制中',ready:'已完成',failed:'录音失败'};
async function api(url, options) {
  const response = await fetch(url, options);
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '请求失败');
  return result;
}
function renderRows(items) {
  $('empty').hidden = items.length > 0;
  $('count').textContent = `${items.filter(item => item.state === 'ready').length} 段可播放`;
  for (const item of [...items].reverse()) {
    let row = rows.get(item.id);
    if (!row) {
      row = document.createElement('article'); row.className = 'recording';
      const info = document.createElement('div');
      const title = document.createElement('h3'); title.className = 'recording-title';
      title.textContent = new Date(item.created_at).toLocaleString('zh-CN', {hour12:false});
      const meta = document.createElement('p'); meta.className = 'recording-meta';
      info.append(title, meta);
      const state = document.createElement('span'); state.className = 'recording-state';
      row.append(info, state); row.dataset.state = '';
      $('recordings').prepend(row); rows.set(item.id, row);
    }
    const label = row.querySelector('.recording-state');
    label.textContent = states[item.state] || item.state;
    label.classList.toggle('failed', item.state === 'failed');
    row.querySelector('.recording-meta').textContent = item.error || `${item.duration} 秒 · WAV · ${item.bytes ? (item.bytes/1024).toFixed(1)+' KB' : '正在接收音频'}`;
    if (item.state === 'ready' && row.dataset.state !== 'ready') {
      const audio = document.createElement('audio'); audio.controls = true; audio.preload = 'metadata';
      audio.src = `/api/recordings/${item.id}/audio`; audio.setAttribute('aria-label', '试听这段录音');
      const link = document.createElement('a'); link.className = 'download';
      link.href = `/api/recordings/${item.id}/download`; link.textContent = '下载 WAV ↓';
      row.append(audio, link);
    }
    row.dataset.state = item.state;
  }
}
function renderStatus(status) {
  const ready = status.microphone && !status.active;
  $('connection').classList.toggle('online', status.microphone);
  $('connection').querySelector('span').textContent = !status.broker ? 'MQTT 控制未连接' : !status.device ? '等待 ESP32 上线' : !status.websocket ? '音频通道连接中' : !status.microphone ? '麦克风尚未就绪' : '麦克风已连接';
  $('record').disabled = !ready || submitting;
  $('duration').disabled = Boolean(status.active) || submitting;
  const active = status.active;
  let percent = 0;
  if (active) {
    percent = Math.min(100, active.received_samples / (active.duration * 16000) * 100);
    $('record-label').textContent = active.state === 'pending' ? '等待设备…' : '正在录音…';
    $('hint').textContent = active.state === 'pending' ? '正在通知麦克风开始采集' : `已接收 ${(active.received_samples/16000).toFixed(1)} / ${active.duration} 秒`;
  } else {
    $('record-label').textContent = '开始录音';
    $('hint').textContent = ready ? '准备好了，点击开始录音' : '设备就绪后即可开始录音';
  }
  $('progress').style.width = `${percent}%`;
  document.querySelector('[role="progressbar"]').setAttribute('aria-valuenow', Math.round(percent));
}

let latest=null,streamReady=false;
const modeNames={on:'已开启',off:'已关闭',blink:'闪烁中',unknown:'等待确认'};
function badge(id,text,good){$(id).textContent=text;$(id).className=good?'good':'bad';}
function renderDevice(device){
  latest=device;
  const online=streamReady&&device.online;
  badge('device-status',device.online?'设备在线':'设备离线',device.online);
  badge('mqtt-status',device.connections.broker?'MQTT 已连接':'MQTT 未连接',device.connections.broker);
  badge('ws-status',device.connections.websocket?'音频已连接':'音频未连接',device.connections.websocket);
  $('access').textContent=location.hostname.startsWith('100.')?'A7S · Tailscale 访问':'A7S · 局域网访问';
  $('led-state').textContent=modeNames[device.led.mode];
  $('led-indicator').className='lamp '+(device.led.mode==='on'?'on':device.led.mode==='blink'?'blink':'');
  $('buzzer-state').textContent=device.buzzer.confirmed_at?(device.buzzer.on?'正在鸣叫':'已停止'):'等待确认';
  $('buzzer-icon').classList.toggle('on',device.buzzer.on);
  for(const button of document.querySelectorAll('[data-control]')){
    const target=button.dataset.control;
    const pending=device.commands.some(c=>c.target===target&&c.status==='pending');
    button.disabled=!online||(button.dataset.mode!=='stop'&&(pending||(target==='buzzer'&&device.buzzer.on)));
    if(target==='led')button.setAttribute('aria-pressed',device.led.mode===button.dataset.mode);
  }
  for(const target of ['led','buzzer']){
    const command=[...device.commands].reverse().find(c=>c.target===target);
    const line=$(target+'-feedback');
    if(command){
      const names={pending:'执行中，等待设备确认…',applied:'设备已确认执行',rejected:'设备拒绝：'+(command.reason==='busy'?'蜂鸣器正在响':command.reason),timeout:command.reason,failed:command.reason};
      line.textContent=names[command.status]||command.status;
      line.classList.toggle('bad',['rejected','timeout','failed'].includes(command.status));
    }else line.textContent=online?'设备已连接，可操作':'等待设备回报';
  }
  const s=device.sensor;
  $('temperature').textContent=s.temperature_c===null?'—':s.temperature_c.toFixed(1);
  $('humidity').textContent=s.humidity_percent===null?'—':s.humidity_percent.toFixed(1);
  const age=s.updated_at?Math.max(0,Math.floor((Date.now()-s.updated_at)/1000)):null;
  const elapsed=age===null?'':age<60?`${age} 秒`:`${Math.floor(age/60)} 分钟`;
  $('sensor-status').textContent=!s.updated_at?'等待首次采样':s.stale?`数据已过期 · ${elapsed}前更新`:!s.valid?`读取失败：${s.error} · 显示上次有效值`:`每 30 分钟采样 · ${elapsed}前更新`;
  $('sensor-status').classList.toggle('bad',s.stale||!s.valid);
  const mic=device.microphone;
  $('mic-state').textContent=mic.stale?'等待采集':mic.signal?'正在采集':'暂无有效信号';
  $('mic-rms').textContent=mic.stale?'RMS —':`RMS ${Math.round(mic.rms).toLocaleString()}`;
  $('mic-peak').textContent=mic.stale?'峰值 —':`峰值 ${Math.round(mic.peak).toLocaleString()}`;
  const level=mic.stale?0:Math.min(100,Math.max(0,(Math.log10(Math.max(1,mic.rms))-2)*25));
  $('sound-level').style.width=level+'%';document.querySelector('[role=meter]').setAttribute('aria-valuenow',Math.round(level));
}
let lastHistory=0;
function chart(id,label,points,key){
  const svg=$(id);svg.replaceChildren();
  const values=points.filter(p=>p.valid).map(p=>p[key]);
  if(!values.length){$(label).textContent='暂无数据';return;}
  const low=Math.min(...values),high=Math.max(...values),spread=Math.max(1,high-low),baseline=high===low?low-0.5:low;
  $(label).textContent=`${low.toFixed(1)} — ${high.toFixed(1)}`;
  let d='',drawing=false;
  points.forEach((p,i)=>{
    if(!p.valid){drawing=false;return;}
    const x=4+i/(points.length-1)*412,y=110-(p[key]-baseline)/spread*100;
    d+=`${drawing?'L':'M'}${x.toFixed(2)} ${y.toFixed(2)} `;drawing=true;
    if(!points[i-1]?.valid&&!points[i+1]?.valid){const dot=document.createElementNS('http://www.w3.org/2000/svg','circle');dot.setAttribute('cx',x);dot.setAttribute('cy',y);dot.setAttribute('r','2.5');svg.append(dot);}
  });
  const path=document.createElementNS('http://www.w3.org/2000/svg','path');path.setAttribute('d',d);svg.append(path);
}
async function history(){
  try{
    const result=await api('/api/telemetry/history?hours='+$('history-range').value);
    chart('temp-chart','temp-range',result.points,'temperature_c');chart('humidity-chart','humidity-range',result.points,'humidity_percent');
    $('history-note').textContent=`近 ${result.hours} 小时 · 每 30 分钟采样 · 缺失和失败区间留空`;lastHistory=Date.now();
  }catch{$('history-note').textContent='历史读取失败，稍后重试';}
}
function consume(snapshot){
  renderDevice(snapshot.device);renderStatus({...snapshot.audio,microphone:snapshot.audio.microphone&&snapshot.device.online&&streamReady});renderRows(snapshot.recordings);
  if(Date.now()-lastHistory>30000)history();
}
async function sync(){
  try{const [device,audio,recordings]=await Promise.all([api('/api/device'),api('/api/status'),api('/api/recordings')]);consume({device,audio,recordings});}catch{disconnected();}
}
function disconnected(){
  streamReady=false;badge('push-status','实时推送重连中',false);
  document.querySelectorAll('[data-control]').forEach(b=>b.disabled=true);$('record').disabled=true;
}
let events=null,lastSnapshot=performance.now();
function connectStream(){
  events?.close();
  if(!navigator.onLine){disconnected();return;}
  events=new EventSource('/api/events');
  events.addEventListener('open',()=>{streamReady=true;lastSnapshot=performance.now();badge('push-status','实时推送已连接',true);sync();});
  events.addEventListener('snapshot',event=>{
    if(!navigator.onLine){events.close();disconnected();return;}
    try{lastSnapshot=performance.now();streamReady=true;badge('push-status','实时推送已连接',true);consume(JSON.parse(event.data));}
    catch{disconnected();}
  });
  events.addEventListener('error',disconnected);
}
window.addEventListener('offline',()=>{events?.close();disconnected();});
window.addEventListener('online',connectStream);
connectStream();
$('history-range').addEventListener('change',history);
for(const button of document.querySelectorAll('[data-control]'))button.addEventListener('click',async()=>{
  const target=button.dataset.control;button.disabled=true;
  const body={mode:button.dataset.mode};if(button.dataset.duration)body.duration_ms=Number(button.dataset.duration);
  try{await api('/api/device/'+target,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});await sync();}
  catch(error){const line=$(target+'-feedback');line.textContent=error.message;line.classList.add('bad');}
});
$('record').addEventListener('click',async()=>{
  if(submitting)return;submitting=true;$('record').disabled=true;$('error').hidden=true;
  try{await api('/api/recordings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({duration:Number($('duration').value)})});}
  catch(error){$('error').textContent=error.message;$('error').hidden=false;}
  finally{submitting=false;await sync();}
});
sync();
setInterval(()=>{
  if(streamReady&&performance.now()-lastSnapshot>15000){disconnected();connectStream();}
  if(latest&&streamReady)renderDevice(latest);
},1000);
