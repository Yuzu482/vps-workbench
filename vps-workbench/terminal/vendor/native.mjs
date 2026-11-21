import { spawn as spawnProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isIP } from 'node:net';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_LINE=8192, MAX_OUTPUT=1024*1024, MAX_INPUT=4096, WRITE_TIMEOUT=5000;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const STATES=new Set(['busy','finished','failed','interrupted','not_found','unknown']);
const OPTIONS=['provider','mode','sessionId','workspace','expectedIpv4','expectedIpv6','expectedSshSource','legacy','legacyConfirmed','outerOnly','socksPort'];
function fault(code){const e=new Error(code);e.code=code;return e;}
function exact(value,keys){return value && typeof value==='object' && !Array.isArray(value) && Object.keys(value).length===keys.length && keys.every(k=>Object.hasOwn(value,k));}
function id(value){return typeof value==='string' && UUID.test(value) && value!=='00000000-0000-0000-0000-000000000000';}
function b64(value,limit){
  if(typeof value!=='string'||value.length>Math.ceil(limit/3)*4||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))return null;
  const bytes=Buffer.from(value,'base64');return bytes.length>0&&bytes.length<=limit&&bytes.toString('base64')===value?bytes:null;
}
function basicConnection(c){
  if(!exact(c,['Host','Port','User','Authentication','IdentityPath','KnownHostsPath']) ||
    !['Host','User','IdentityPath','KnownHostsPath'].every(k=>typeof c[k]==='string'&&c[k].length>0&&c[k].length<=2048&&!/[\x00-\x1f\x7f]/.test(c[k])) ||
    !Number.isInteger(c.Port)||c.Port<1||c.Port>65535||c.Authentication!=='Key')return false;
  if(!/^[A-Za-z0-9_][A-Za-z0-9_.@\\-]{0,127}$/.test(c.User)||c.Host.length>253||c.Host.includes('%'))return false;
  if(!isIP(c.Host)&&!c.Host.split('.').every(label=>/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label)))return false;
  return ['IdentityPath','KnownHostsPath'].every(k=>/^[A-Za-z]:[\\/]/.test(c[k])&&!/["%~*?<>|]/.test(c[k])&&
    !c[k].includes('${')&&!c[k].slice(3).includes(':')&&!c[k].split(/[\\/]/).some(p=>p==='.'||p==='..'));
}
function basicOptions(o){
  if(!exact(o,OPTIONS)||!['codex','claude'].includes(o.provider)||!['new','picker','resume'].includes(o.mode))return false;
  if(o.provider==='claude'&&o.mode==='resume')return false;
  if((o.mode==='resume')!==id(o.sessionId) || (o.mode!=='resume'&&o.sessionId!==null))return false;
  if(typeof o.workspace!=='string'||!o.workspace.startsWith('/')||Buffer.byteLength(o.workspace)>2048||/[\x00-\x1f\x7f]/.test(o.workspace))return false;
  if(typeof o.expectedIpv4!=='string'||isIP(o.expectedIpv4)!==4)return false;
  if(o.expectedIpv6!==null&&(typeof o.expectedIpv6!=='string'||o.expectedIpv6.includes('%')||isIP(o.expectedIpv6)!==6))return false;
  if(o.expectedSshSource!==null&&(typeof o.expectedSshSource!=='string'||o.expectedSshSource.includes('%')||!isIP(o.expectedSshSource)))return false;
  if(!['legacy','legacyConfirmed','outerOnly'].every(k=>typeof o[k]==='boolean'))return false;
  if((o.legacy&&(!o.legacyConfirmed||o.mode==='new'))||(!o.legacy&&o.legacyConfirmed)||(o.outerOnly&&o.provider!=='codex'))return false;
  if(o.socksPort!==null&&(!Number.isInteger(o.socksPort)||o.socksPort<1||o.socksPort>65535))return false;
  return (o.socksPort===null)===(o.expectedSshSource===null);
}
// Background operations fail closed unless the previously confirmed record
// uses an explicit SOCKS relay and the expected remote-observed SSH source.
// This checks configuration, not whether a third-party proxy really exits at
// the claimed address; the remote preflight checks its peer after connection.
function backgroundEligible(record){
  const o=record?.options;return o?.provider==='codex'&&!o.legacy&&!o.outerOnly&&Number.isInteger(o.socksPort)&&typeof o.expectedSshSource==='string';
}
export function createNativeReceiptStore(base=process.env.LOCALAPPDATA||join(homedir(),'AppData','Local')){
  if(!isAbsolute(base))throw fault('unavailable');
  const realBase=realpathSync(base); let root=realBase;
  for(const part of ['RemoteSsh','NativeTerminalReceipts']){
    root=join(root,part);try{mkdirSync(root);}catch(e){if(e?.code!=='EEXIST')throw e;}
    const info=lstatSync(root), actual=realpathSync(root), child=relative(realBase,actual);
    if(!info.isDirectory()||info.isSymbolicLink()||!child||isAbsolute(child)||child==='..'||child.startsWith('..'+sep))throw fault('unavailable');
  }
  function read(recordId){
    if(!id(recordId))throw fault('invalid_request');
    const path=join(root,`terminal-${recordId}.json`), info=lstatSync(path);
    if(!info.isFile()||info.isSymbolicLink()||info.size>16384)throw fault('unavailable');
    const fd=openSync(path,'r');let raw;
    try{const actual=fstatSync(fd);if(!actual.isFile()||actual.size>16384)throw fault('unavailable');raw=readFileSync(fd,'utf8');}finally{closeSync(fd);}
    const value=JSON.parse(raw);
    if(!exact(value,['version','operationId','createdAt','connection','options'])||value.version!==1||value.operationId!==recordId||
       typeof value.createdAt!=='string'||value.createdAt.length>40||!basicConnection(value.connection)||!basicOptions(value.options))throw fault('unavailable');
    return value;
  }
  return {
    save(connection,options,operationId=randomUUID()){
      if(!id(operationId))throw fault('invalid_request');
      const value={version:1,operationId,createdAt:new Date().toISOString(),connection,options};
      const path=join(root,`terminal-${operationId}.json`), bytes=Buffer.from(JSON.stringify(value),'utf8');
      if(bytes.length>16384)throw fault('invalid_request');
      const fd=openSync(path,'wx',0o600);try{writeFileSync(fd,bytes);fsyncSync(fd);}finally{closeSync(fd);}
      return value;
    },
    read,
    list(){
      const names=readdirSync(root).filter(name=>/^terminal-[0-9a-f-]{36}\.json$/.test(name));
      const candidates=names.slice(-500), records=candidates.map(name=>{
        try{return read(name.slice(9,-5));}catch{return null;}
      }).filter(Boolean).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
      return {records:records.slice(0,100),truncated:names.length>500||records.length>100,invalid:candidates.length-records.length};
    }
  };
}

export function createNativeTerminal({spawn=spawnProcess, executable=resolve(dirname(fileURLToPath(import.meta.url)),'../ssh-prototype/bin/Debug/net10.0/DshSshBridge.exe'),
                                      storeFactory=()=>createNativeReceiptStore(), leaseMs=60000, now=Date.now, checkFiles=true}={}){
  let store=null, proc=null, state='idle', current=null, events=[], size=0, sequence=0, acknowledged=0, gap=false;
  let pendingExit=null, buffer=Buffer.alloc(0), tail=Buffer.alloc(0), marker=Buffer.alloc(0), localReady=false, writeQueue=Promise.resolve(), disposed=false, lease=null;
  const statuses=new Map();let queryActive=false,backgroundOwner=null;
  const getStore=()=>store||=(storeFactory());
  const snapshot=()=>({state,sessionId:current?.operationId??null,lastSequence:sequence});
  function append(type,extra={}){events.push({sequence:++sequence,type,...extra});}
  function kill(){try{proc?.kill();}catch{}}
  function renew(){
    clearTimeout(lease);const child=proc;if(!child||disposed)return;
    lease=setTimeout(()=>{if(proc!==child||disposed)return;gap=true;state='closing';try{child.stdin.end('{"type":"close"}\n');}catch{};
      const timer=setTimeout(()=>{if(proc===child)kill();},3000);timer.unref?.();},leaseMs);lease.unref?.();
  }
  function fail(){if(state==='failed')return;gap=true;state='closing';kill();}
  function frame(value){
    if(exact(value,['type'])&&value.type==='ready'&&state==='starting'){localReady=true;return;}
    if(exact(value,['type','data'])&&value.type==='output'&&['starting','ready','closing'].includes(state)){
      const data=b64(value.data,4096);if(!data||size+data.length>MAX_OUTPUT){fail();return;}
      size+=data.length;append('output',{data:value.data});
      const scan=Buffer.concat([tail,data]);if(state==='starting'&&localReady&&scan.includes(marker))state='ready';
      tail=scan.subarray(Math.max(0,scan.length-marker.length+1));return;
    }
    if(exact(value,['type','code','error'])&&value.type==='exit'&&Number.isInteger(value.code)&&
       (value.error===null||typeof value.error==='string')&&!pendingExit){
      pendingExit={code:value.code,error:value.error===null?null:'bridge_error',requestedClose:state==='closing'};state='closing';return;
    }
    fail();
  }
  function begin(record){
    if(disposed||proc||['starting','ready','closing'].includes(state))throw fault('unavailable');
    current=record;events=[];size=0;sequence=0;acknowledged=0;gap=false;buffer=Buffer.alloc(0);tail=Buffer.alloc(0);
    marker=Buffer.from('隔离终端已就绪：'+record.operationId);
    pendingExit=null;localReady=false;writeQueue=Promise.resolve();state='starting';
    const systemRoot=process.env.SystemRoot||'C:\\Windows';
    const env={SystemRoot:systemRoot,WINDIR:systemRoot,PATH:`${systemRoot}\\System32`,TEMP:process.env.TEMP||systemRoot,TMP:process.env.TMP||systemRoot};
    if(process.env.ProgramData)env.ProgramData=process.env.ProgramData;
    let child;
    try{child=spawn(executable,['--native'],{shell:false,windowsHide:true,stdio:['pipe','pipe','ignore'],env});}
    catch{state='detached';append('disconnect',{reason:'startup_uncertain'});return snapshot();}
    proc=child;renew();child.stdin.on('error',()=>{if(proc===child)fail();});child.stdout.on('error',()=>{if(proc===child)fail();});
    child.stdout.on('data',chunk=>{
      if(proc!==child)return;buffer=Buffer.concat([buffer,chunk]);let at;
      while((at=buffer.indexOf(10))>=0){if(at>MAX_LINE){fail();return;}const line=buffer.subarray(0,at);buffer=buffer.subarray(at+1);
        try{frame(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(line)));}catch{fail();return;}}
      if(buffer.length>MAX_LINE)fail();
    });
    child.once('error',()=>{if(proc===child)fail();});
    child.once('close',(code,signal)=>{
      if(proc!==child)return;clearTimeout(lease);proc=null;
      if(!disposed&&!gap&&pendingExit&&pendingExit.code===0&&pendingExit.error===null&&!pendingExit.requestedClose&&code===0&&!signal){
        state='closed';append('exit',{code:0,error:null});
      }else{state='detached';append('disconnect',{reason:'status_required'});}
    });
    try{child.stdin.write(JSON.stringify({type:'native-start',hostKeyConfirmed:true,connection:record.connection,
      options:{operationId:record.operationId,...record.options}})+'\n');}catch{fail();}
    return snapshot();
  }
  async function write(value){
    const child=proc;if(!child||!child.stdin.writable)throw fault('unavailable');
    const work=writeQueue.then(()=>new Promise((yes,no)=>{
      if(proc!==child||!child.stdin.writable)return no(fault('unavailable'));
      const timer=setTimeout(()=>no(fault('write_uncertain')),WRITE_TIMEOUT);
      try{child.stdin.write(JSON.stringify(value)+'\n','utf8',e=>{clearTimeout(timer);e?no(fault('write_uncertain')):yes();});}
      catch{clearTimeout(timer);no(fault('write_uncertain'));}
    }));writeQueue=work.catch(()=>{});try{await work;}catch(e){fail();throw e;}
  }
  async function query(record){
    return await new Promise(resolveQuery=>{
      const systemRoot=process.env.SystemRoot||'C:\\Windows', env={SystemRoot:systemRoot,WINDIR:systemRoot,PATH:`${systemRoot}\\System32`,TEMP:process.env.TEMP||systemRoot,TMP:process.env.TMP||systemRoot};
      if(process.env.ProgramData)env.ProgramData=process.env.ProgramData;
      let child, output=Buffer.alloc(0), finished=false;
      function finish(value){if(finished)return;finished=true;clearTimeout(timer);resolveQuery(value);}
      try{child=spawn(executable,['--native-status'],{shell:false,windowsHide:true,stdio:['pipe','pipe','ignore'],env});}
      catch{return resolveQuery({state:'unknown',exitCode:null});}
      const uncertain=()=>{try{child.kill();}catch{};finish({state:'unknown',exitCode:null});};
      const timer=setTimeout(uncertain,42000);timer.unref?.();
      child.stdin.on('error',uncertain);child.stdout.on('error',uncertain);
      child.stdout.on('data',chunk=>{output=Buffer.concat([output,chunk]);if(output.length>MAX_LINE)uncertain();});
      child.once('error',uncertain);child.once('close',code=>{
        if(code!==0)return finish({state:'unknown',exitCode:null});
        try{const v=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(output).trim());
          if(!exact(v,['type','state','exitCode'])||v.type!=='status'||!STATES.has(v.state)||
             !(v.exitCode===null||(Number.isInteger(v.exitCode)&&v.exitCode>=0&&v.exitCode<=255))||
             ((v.state==='finished')!==(v.exitCode!==null)))throw Error();
          finish({state:v.state,exitCode:v.exitCode});}catch{finish({state:'unknown',exitCode:null});}
      });
      child.stdin.end(JSON.stringify({type:'native-status',hostKeyConfirmed:true,connection:record.connection,
        options:{operationId:record.operationId,...record.options}})+'\n');
    });
  }
  async function request(op,body,background=false){
      if(disposed)throw fault('unavailable');
      // The background controller is the sole consumer of its terminal's
      // output and input. A GUI attach cannot drain its cursor or interleave
      // keystrokes; existing GUI-owned terminals remain untouched.
      if(!background&&backgroundOwner&&['native-start','native-current','native-poll','native-input','native-resize','native-close','native-reopen','native-acknowledge'].includes(op))throw fault('unavailable');
      if(op==='native-list'&&exact(body,['op']))return getStore().list();
      if(op==='native-current'&&exact(body,['op']))return {...snapshot(),acknowledged,gap};
      if(op==='native-start'&&exact(body,['op','hostKeyConfirmed','connection','options'])){
        if(body.hostKeyConfirmed!==true||!basicConnection(body.connection)||!basicOptions(body.options))throw fault('invalid_request');
        if(checkFiles&&(!existsSync(body.connection.IdentityPath)||!existsSync(body.connection.KnownHostsPath)))throw fault('invalid_request');
        if(proc||['starting','ready','closing','detached'].includes(state))throw fault('unavailable');
        return begin(getStore().save(body.connection,body.options));
      }
      if(op==='native-status'&&exact(body,['op','operationId'])){
        if(queryActive)throw fault('unavailable');
        const record=getStore().read(body.operationId);queryActive=true;
        try{
          const value=await query(record), time=now();
          for(const [key,item] of statuses)if(time-item.at>30000)statuses.delete(key);
          statuses.set(record.operationId,{...value,at:time});return {operationId:record.operationId,...value};
        }finally{queryActive=false;}
      }
      if(op==='native-reopen'&&exact(body,['op','operationId','mode','sessionId','reviewed'])){
        if(body.reviewed!==true||!['picker','resume'].includes(body.mode)||
           (body.mode==='resume'?!id(body.sessionId):body.sessionId!==null))throw fault('invalid_request');
        const status=statuses.get(body.operationId);
        if(!status||now()-status.at>30000||!['finished','failed','interrupted'].includes(status.state)||proc||['starting','ready','closing'].includes(state))throw fault('unavailable');
        const previous=getStore().read(body.operationId), options={...previous.options,mode:body.mode,sessionId:body.sessionId};
        if(!basicOptions(options))throw fault('invalid_request');
        statuses.delete(body.operationId);return begin(getStore().save(previous.connection,options));
      }
      if(op==='native-acknowledge'&&exact(body,['op','operationId','reviewed'])){
        const status=statuses.get(body.operationId);
        if(body.reviewed!==true||!current||body.operationId!==current.operationId||state!=='detached'||proc||
           !status||now()-status.at>30000||!['finished','failed','interrupted','not_found'].includes(status.state))throw fault('unavailable');
        statuses.delete(body.operationId);state='closed';return snapshot();
      }
      if(!current||body.sessionId!==current.operationId)throw fault('session_mismatch');
      if(op==='native-poll'&&exact(body,['op','sessionId','after'])){
        if(!Number.isSafeInteger(body.after)||body.after<0||body.after>sequence)throw fault('invalid_request');renew();
        if(body.after<acknowledged)return {...snapshot(),events:[],gap:true};
        while(events.length&&events[0].sequence<=body.after){const item=events.shift();if(item.type==='output')size-=Buffer.from(item.data,'base64').length;}
        acknowledged=body.after;return {...snapshot(),events:events.slice(0,64),gap};
      }
      if(op==='native-input'&&exact(body,['op','sessionId','data'])){
        if(!b64(body.data,MAX_INPUT))throw fault('invalid_request');if(state!=='ready'||gap)throw fault('unavailable');
        await write({type:'input',data:body.data});return snapshot();
      }
      if(op==='native-resize'&&exact(body,['op','sessionId','columns','rows'])){
        if(!Number.isInteger(body.columns)||body.columns<1||body.columns>500||!Number.isInteger(body.rows)||body.rows<1||body.rows>300)throw fault('invalid_request');
        if(state!=='ready'||gap)throw fault('unavailable');await write({type:'resize',columns:body.columns,rows:body.rows});return snapshot();
      }
      if(op==='native-close'&&exact(body,['op','sessionId'])){
        if(!proc||!['starting','ready'].includes(state))throw fault('unavailable');state='closing';await write({type:'close'});return snapshot();
      }
      throw fault('invalid_request');
  }
  async function backgroundRequest(op,body){
    if(disposed)throw fault('unavailable');
    if(op==='list'&&exact(body,['op'])){
      const listed=getStore().list();
      return {records:listed.records.filter(backgroundEligible)
        .map(r=>({operationId:r.operationId,createdAt:r.createdAt,route:'socks5'})),truncated:listed.truncated,invalid:listed.invalid};
    }
    if(op==='current'&&exact(body,['op']))return {owned:backgroundOwner!==null,...snapshot()};
    if(op==='status'&&exact(body,['op','operationId'])){
      let record;try{record=getStore().read(body.operationId);}catch{throw fault('terminal_preflight_failed');}
      if(!backgroundEligible(record))throw fault('terminal_preflight_failed');
      return request('native-status',{op:'native-status',operationId:body.operationId},true);
    }
    if(op==='open'&&exact(body,['op','sourceId','operationId','mode','sessionId','reviewed'])){
      if(!id(body.sourceId)||!id(body.operationId)||body.sourceId===body.operationId||body.reviewed!==true||
         !['new','picker','resume'].includes(body.mode)||(body.mode==='resume'?!id(body.sessionId):body.sessionId!==null))throw fault('terminal_preflight_failed');
      const status=statuses.get(body.sourceId);
      if((backgroundOwner&&(backgroundOwner!==body.sourceId||!['closed','detached'].includes(state)))||
         !status||now()-status.at>30000||!['finished','failed','interrupted'].includes(status.state)||
         proc||['starting','ready','closing'].includes(state)||(state==='detached'&&current?.operationId!==body.sourceId))throw fault('terminal_preflight_failed');
      let previous;try{previous=getStore().read(body.sourceId);}catch{throw fault('terminal_preflight_failed');}
      // Only a connection previously started after the owner's host-key
      // confirmation may be reused. Background mode never opts out of the
      // inner sandbox or opens ambiguous legacy workspaces.
      if(!backgroundEligible(previous))throw fault('terminal_preflight_failed');
      const options={...previous.options,mode:body.mode,sessionId:body.sessionId};
      if(!basicOptions(options))throw fault('terminal_preflight_failed');
      const record=getStore().save(previous.connection,options,body.operationId);
      statuses.delete(body.sourceId);backgroundOwner=body.operationId;
      try{return begin(record);}catch(error){backgroundOwner=null;throw error;}
    }
    if(op==='release'&&exact(body,['op','operationId','reviewed'])){
      if(body.operationId!==backgroundOwner||body.reviewed!==true||proc||!['closed','detached'].includes(state))throw fault('unavailable');
      if(state==='detached')await request('native-acknowledge',{op:'native-acknowledge',operationId:body.operationId,reviewed:true},true);
      backgroundOwner=null;return snapshot();
    }
    if(!backgroundOwner||body?.operationId!==backgroundOwner)throw fault('session_mismatch');
    if(op==='poll'&&exact(body,['op','operationId','after']))return request('native-poll',{op:'native-poll',sessionId:backgroundOwner,after:body.after},true);
    if(op==='input'&&exact(body,['op','operationId','data']))return request('native-input',{op:'native-input',sessionId:backgroundOwner,data:body.data},true);
    if(op==='close'&&exact(body,['op','operationId']))return request('native-close',{op:'native-close',sessionId:backgroundOwner},true);
    throw fault('invalid_request');
  }
  return {
    request(op,body){return request(op,body,false);},
    backgroundRequest,
    dispose(){disposed=true;clearTimeout(lease);if(proc){try{proc.stdin.end('{"type":"close"}\n');}catch{};const child=proc;
      const timer=setTimeout(()=>{if(proc===child)kill();},3000);timer.unref?.();}},
  };
}
