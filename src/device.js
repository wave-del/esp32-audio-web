import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { ApiError, PREFIX } from './recordings.js';

export const CONTROL = 'esp32c3/b08184aed020/control';
export class Device {
  constructor({directory, recordings, publish, now=Date.now}) {
    this.recordings=recordings; this.publish=publish; this.now=now;
    this.state=null; this.stateAt=0; this.commands=new Map(); this.mic=null; this.micAt=0;
    fs.mkdirSync(directory,{recursive:true});
    this.db=new DatabaseSync(path.join(directory,'telemetry.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS sensor(id INTEGER PRIMARY KEY,at INTEGER NOT NULL,valid INTEGER NOT NULL,temperature REAL,humidity REAL,error TEXT);
      CREATE INDEX IF NOT EXISTS sensor_at ON sensor(at);`);
    this.insert=this.db.prepare('INSERT INTO sensor(at,valid,temperature,humidity,error) VALUES(?,?,?,?,?)');
    this.prune=this.db.prepare('DELETE FROM sensor WHERE at < ?');
    this.prune.run(this.now()-86400000); this.prunedAt=this.now();
    this.last=this.db.prepare('SELECT * FROM sensor ORDER BY id DESC LIMIT 1').get() || null;
    this.lastGood=this.db.prepare('SELECT * FROM sensor WHERE valid=1 ORDER BY id DESC LIMIT 1').get() || null;
  }
  snapshot() {
    const connection=this.recordings.status();
    const online=connection.device && this.stateAt>0 && this.now()-this.stateAt<15000;
    const last=this.last, good=this.lastGood;
    return {online,connections:connection,
      led:{mode:this.state?.led_mode??'unknown',confirmed_at:this.stateAt||null},
      buzzer:{on:this.state?.buzzer_on??false,confirmed_at:this.stateAt||null},
      sensor:{temperature_c:good?.temperature??null,humidity_percent:good?.humidity??null,
        valid:Boolean(last?.valid),stale:!online||!last||this.now()-last.at>=30*60*1000+60000,
        sample_interval_ms:30*60*1000,updated_at:last?.at??null,last_good_at:good?.at??null,error:last?.error??null},
      microphone:{...this.mic,stale:!online||!this.micAt||this.now()-this.micAt>=5000},
      commands:[...this.commands.values()].slice(-16)};
  }
  stateUpdate(state, result=false) {
    if (!state || !['off','on','blink'].includes(state.led_mode) || typeof state.buzzer_on!=='boolean' ||
        !Number.isInteger(state.version) || !Number.isFinite(state.uptime_ms)) return false;
    if(!Number.isInteger(state.boot_id))return false;
    // Only device heartbeats may establish a new boot. Cached results never roll state back.
    if(this.state){
      if(result&&state.boot_id!==this.state.boot_id)return false;
      if(state.boot_id===this.state.boot_id&&(state.version<this.state.version||state.uptime_ms<this.state.uptime_ms))return false;
    }
    this.state=state; this.stateAt=this.now(); return true;
  }
  ingest(topic,payload) {
    try {
      const value=JSON.parse(payload.toString());
      if (topic===`${CONTROL}/state`) this.stateUpdate(value);
      else if (topic===`${CONTROL}/result`) {
        const command=this.commands.get(value.id);
        if (!command || command.status!=='pending' || !['applied','rejected'].includes(value.status)) return;
        command.status=value.status; command.reason=value.reason||null; command.completed_at=this.now();
        this.stateUpdate(value.state,true);
      } else if (topic===`${CONTROL}/microphone`) {
        if (Number.isFinite(value.rms)&&Number.isFinite(value.peak)&&value.rms>=0&&value.peak>=0) {
          this.mic={rms:value.rms,peak:value.peak,signal:value.signal===true,updated_at:this.now()}; this.micAt=this.now();
        }
      } else if (topic==='esp32c3/dht11') {
        const valid=value.valid!==false&&Number.isFinite(value.temperature_c)&&Number.isFinite(value.humidity_percent)&&
          value.temperature_c>=-20&&value.temperature_c<=80&&value.humidity_percent>=0&&value.humidity_percent<=100;
        const row={at:this.now(),valid:valid?1:0,temperature:valid?value.temperature_c:null,
          humidity:valid?value.humidity_percent:null,error:valid?null:String(value.error||'invalid_sensor_data').slice(0,160)};
        this.insert.run(row.at,row.valid,row.temperature,row.humidity,row.error);
        this.last=row;if(valid)this.lastGood=row;
      }
    } catch(error){console.warn('Device message rejected:',topic,error.message);}
  }
  command(target,body) {
    if (!this.snapshot().online) throw new ApiError(503,'设备离线，无法执行操作');
    let payload;
    if(target==='led'&&['off','on','blink'].includes(body?.mode))payload={target,mode:body.mode};
    else if(target==='buzzer'&&body?.mode==='stop')payload={target,mode:'stop'};
    else if(target==='buzzer'&&body?.mode==='beep'&&[500,1000,2000].includes(body.duration_ms))
      payload={target,mode:'beep',duration_ms:body.duration_ms};
    else throw new ApiError(400,'控制参数无效');
    if(payload.mode!=='stop'&&[...this.commands.values()].some(c=>c.target===target&&c.status==='pending'))
      throw new ApiError(409,'该外设已有命令正在执行');
    if(target==='buzzer'&&payload.mode==='beep'&&this.state.buzzer_on)throw new ApiError(409,'蜂鸣器正在响，请先停止或等待结束');
    const command={...payload,id:randomUUID(),status:'pending',created_at:this.now(),reason:null};
    this.commands.set(command.id,command);
    if(this.commands.size>128)for(const [id,c]of this.commands){if(c.status!=='pending'){this.commands.delete(id);break;}}
    this.publish(`${CONTROL}/command`,JSON.stringify({...payload,id:command.id}),(error)=>{
      if(error&&command.status==='pending'){command.status='failed';command.reason='命令发送失败';}
    });
    return command;
  }
  getCommand(id){const command=this.commands.get(id);if(!command)throw new ApiError(404,'命令不存在');return command;}
  tick() {
    const online=this.snapshot().online;
    for(const command of this.commands.values())if(command.status==='pending'){
      if(!online){command.status='failed';command.reason='设备连接已中断';}
      else if(this.now()-command.created_at>=5000){command.status='timeout';command.reason='5 秒内未收到设备执行确认，请以最新状态为准';}
    }
    if(this.now()-this.prunedAt>=60000){this.prune.run(this.now()-86400000);this.prunedAt=this.now();}
  }
  history(hours) {
    if(![1,6,24].includes(hours))throw new ApiError(400,'历史范围只支持 1、6、24 小时');
    const end=Math.floor(this.now()/60000)*60000,start=end-hours*3600000;
    const rows=this.db.prepare(`SELECT CAST(at/60000 AS INTEGER)*60000 AS bucket,MIN(valid) AS valid,
      AVG(temperature) AS temperature,AVG(humidity) AS humidity FROM sensor WHERE at>=? GROUP BY bucket`).all(this.now()-hours*3600000);
    const map=new Map(rows.map(row=>[Number(row.bucket),row]));
    const points=[];
    for(let at=start;at<=end;at+=60000){const row=map.get(at),valid=Boolean(row?.valid);
      points.push({at,valid,temperature_c:valid?row.temperature:null,humidity_percent:valid?row.humidity:null});}
    return {hours,points};
  }
  close(){this.db.close();}
}
