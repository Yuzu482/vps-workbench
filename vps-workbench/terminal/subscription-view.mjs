// Renderer ported from dsh-terminal-workbench 0.2.0-dev.14.
import { Terminal, xtermCss } from './vendor/xterm.mjs';
import { readOutputPage, UnconfirmedTerminalWrite, writeTerminalBytes } from './subscription-output.mjs';

const API = '/dsh-terminal-workbench/api/';
const initialSize = { columns: 80, rows: 24 };
const pollingStates = new Set(['starting', 'ready', 'closing', 'reconnecting']);
const finalStates = new Set(['detached', 'closed']);
const pollInterval = 250;

function measureTerminal(term, mount) {
  const screen = term.element.querySelector('.xterm-screen')?.getBoundingClientRect();
  const viewport = term.element.querySelector('.xterm-viewport');
  if (!screen?.width || !screen.height || !viewport || !mount.clientWidth || !mount.clientHeight) return null;
  const overlay = term.element.querySelector('.xterm-scrollable-element > .scrollbar.vertical');
  const scrollbar = Math.max(viewport.offsetWidth - viewport.clientWidth, overlay?.offsetWidth ?? 0);
  // Use the rendered cell size so zoom, DPR and the terminal font are already accounted for.
  return {
    columns: Math.max(2, Math.min(500, Math.floor((mount.clientWidth - scrollbar) / (screen.width / term.cols)))),
    rows: Math.max(1, Math.min(300, Math.floor(mount.clientHeight / (screen.height / term.rows)))),
  };
}

function nonce() {
      if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
      if (typeof crypto === 'undefined' || typeof crypto.getRandomValues !== 'function') throw new Error('安全随机数不可用');
      const a = new Uint8Array(16); crypto.getRandomValues(a); a[6]=(a[6]&15)|64; a[8]=(a[8]&63)|128;
      const s=Array.from(a,n=>n.toString(16).padStart(2,'0')).join('');
      return `${s.slice(0,8)}-${s.slice(8,12)}-${s.slice(12,16)}-${s.slice(16,20)}-${s.slice(20)}`;
    }
function toBase64(bytes) {
      let s=''; for (const b of bytes) s+=String.fromCharCode(b); return btoa(s);
    }
const windowsTerminalKeys = {
  ArrowLeft: [37, 75, 0],
  ArrowUp: [38, 72, 0],
  ArrowRight: [39, 77, 0],
  ArrowDown: [40, 80, 0],
  Escape: [27, 1, 27],
};
function windowsTerminalKey(key) {
  const [virtualKey, scanCode, character] = windowsTerminalKeys[key];
  const prefix = `\x1b[${virtualKey};${scanCode};${character};`;
  return prefix + '1;0;1_' + prefix + '0;0;1_';
}

// xterm's public onData mixes keyboard input and terminal
// replies, so stdin stays disabled and this adapter never subscribes to it.
function createDirectTerminalInput(term, handlers) {
  const field = term.textarea;
  if (!field) throw new Error('terminal input surface unavailable');
  // xterm marks its helper textarea read-only when stdin is disabled. Keep
  // xterm's stdin disabled while letting the browser deliver IME composition.
  field.readOnly = false;
  let composing = false, lastComposition = null, pending = null, disposed = false;
  const validText = value => typeof value === 'string' && value.length > 0 &&
    !/[\x00-\x1f\x7f-\x9f]/.test(value) && new TextEncoder().encode(value).length <= 4096;
  function keep(value) {
    pending = validText(value) ? value : null;
    handlers.onPending(pending);
    if (!pending) handlers.onNotice('输入法结果无法确认，未发送。');
  }
  const keySubscription = term.onKey(({key, domEvent}) => {
    if (disposed || !domEvent?.isTrusted || domEvent.isComposing || composing) return;
    if (pending || !handlers.canInput()) { domEvent.preventDefault(); handlers.onNotice('当前状态不能输入，按键未发送。'); return; }
    // Do not send clipboard shortcuts as control characters. Paste support
    // is intentionally deferred until it has its own explicit safety policy.
    const keyName = String(domEvent.key || '');
    if ((domEvent.ctrlKey && keyName.toLowerCase() === 'v') ||
        (domEvent.shiftKey && keyName === 'Insert')) {
      domEvent.preventDefault(); handlers.onNotice('当前终端暂不发送粘贴内容。'); return;
    }
    if (Object.hasOwn(windowsTerminalKeys, keyName)) {
      if (domEvent.ctrlKey || domEvent.altKey || domEvent.metaKey || domEvent.shiftKey) {
        domEvent.preventDefault(); handlers.onNotice('当前终端暂不支持这个带修饰键的按键。'); return;
      }
      if (!handlers.onInput(windowsTerminalKey(keyName))) handlers.onNotice('输入队列已满或连接状态已变，本次按键未发送。');
    } else if (typeof key === 'string' && key.length && !handlers.onInput(key)) {
      handlers.onNotice('输入队列已满或连接状态已变，本次按键未发送。');
    }
  });
  const onStart = event => {
    if (!event.isTrusted || disposed) return;
    if (pending) handlers.onNotice('请先处理上一段待核对的输入法文本。');
    composing = true; lastComposition = null;
  };
  const onCompositionInput = event => {
    if (!event.isTrusted || !composing || !event.isComposing) return;
    if (event.inputType === 'insertCompositionText' && typeof event.data === 'string') lastComposition = event.data;
  };
  const onEnd = event => {
    if (disposed || !composing) return;
    composing = false;
    const value = typeof event.data === 'string' && event.data ? event.data : field.value;
    if (pending) handlers.onNotice('上一段输入法文本仍待核对；后续输入未发送。');
    else if (event.isTrusted && value === lastComposition && validText(value) && handlers.canInput()) {
      if (!handlers.onInput(value)) keep(value);
    } else if (value) keep(value);
    lastComposition = null;
    // xterm's own composition listener has stdin disabled. Clear its helper
    // after the event, without replaying or auto-submitting uncertain text.
    queueMicrotask(() => { if (!disposed && !composing) field.value = ''; });
  };
  const onPaste = event => { event.preventDefault(); handlers.onNotice('当前终端暂不发送粘贴内容。'); };
  field.addEventListener('compositionstart', onStart, true);
  field.addEventListener('input', onCompositionInput, true);
  field.addEventListener('compositionend', onEnd, true);
  field.addEventListener('paste', onPaste, true);
  return {
    confirm() {
      if (!pending || !handlers.canInput()) return false;
      const value = pending;
      if (!handlers.onInput(value)) return false;
      pending = null; handlers.onPending(null); return true;
    },
    discard() { pending = null; handlers.onPending(null); },
    dispose() {
      disposed = true; keySubscription.dispose();
      field.removeEventListener('compositionstart', onStart, true);
      field.removeEventListener('input', onCompositionInput, true);
      field.removeEventListener('compositionend', onEnd, true);
      field.removeEventListener('paste', onPaste, true);
      field.readOnly = true; pending = null;
    }
  };
}

// Serializes direct input. An uncertain send is never retried, and waiting
// input is discarded if the original session becomes unavailable.
function createTerminalInputQueue({ canQueue, canSend, send, onUpdate, onFailure, onDrop }) {
  const items = [];
  let bytes = 0, running = false, inFlight = false, disposed = false;
  const update = () => { if (!disposed) onUpdate(inFlight || items.length > 0); };
  function discard() {
    const count = items.length; items.length = 0; bytes = 0; update();
    if (count && !disposed) onDrop(count);
  }
  async function pump() {
    if (running || disposed) return;
    running = true;
    try {
      while (items.length && !disposed) {
        const next = items[0], status = canSend(next.sessionId);
        if (status === 'wait') break;
        if (status !== 'ready') { discard(); break; }
        items.shift(); bytes -= next.bytes.length; inFlight = true; update();
        try { await send(next); }
        catch (error) { inFlight = false; discard(); if (!disposed) onFailure(error); return; }
        inFlight = false;
        if (!disposed && next.onSent) next.onSent();
      }
    } finally { running = false; update(); }
  }
  return {
    enqueue(data, sessionId, onSent) {
      if (disposed || !canQueue(sessionId) || !(data instanceof Uint8Array) || !data.length || data.length > 4096 ||
          items.length >= 256 || bytes + data.length > 16384) return false;
      items.push({bytes:data,sessionId,onSent}); bytes += data.length; update(); void pump(); return true;
    },
    kick() { void pump(); },
    discard,
    dispose() { disposed = true; items.length = 0; bytes = 0; }
  };
}

class TransportError extends Error {}
const browseRejected = (error) => error?.code === 'workbench_browse_only';

const subscriptionCss = `
  [data-ntw][data-subscription=true] {height:100%}
  [data-ntw][data-subscription=true][data-session=true] > .vc-scroll {overflow:hidden}
  [data-ntw][data-subscription=true][data-session=true] > .vc-scroll > .vc-body {
    display:flex; flex-direction:column; height:100%; min-height:0; padding-block:8px;
  }
  [data-ntw][data-subscription=true] .ntw-session-actions {
    display:flex; flex-wrap:wrap; align-items:center; gap:4px; min-width:0;
  }
  [data-ntw][data-subscription=true] .vc-welcome .ntw-session-actions {justify-content:center; gap:8px}
  [data-ntw][data-subscription=true] .vc-welcome p {overflow-wrap:anywhere}
  [data-ntw][data-subscription=true] .ntw-screen {
    flex:1; min-width:0; min-height:0; overflow:hidden; padding:8px;
    border-radius:12px; background:#181a1b;
  }
  [data-ntw][data-subscription=true] .ntw-terminal {height:100%; min-height:0}
  [data-ntw][data-subscription=true] .vc-activity {margin-top:12px}
  [data-ntw][data-subscription=true][data-session=true] .vc-activity {margin-top:6px; max-height:35%; overflow:auto}
  [data-ntw][data-subscription=true] .vc-activity[open] summary {margin-bottom:6px}
  [data-ntw][data-subscription=true] .vc-activity select {max-width:100%}
`;

export function createStandaloneSubscriptionView(React) {
const h = React.createElement;
// One renderer acknowledges output and sends input while a terminal is active.
const nativeViewOwner = {current:null};

function SubscriptionTerminal({active=true, subscriptionPreset, activation=0, remoteEnabled=true, accessButton}) {
  const [boundPreset,setBoundPreset]=React.useState(subscriptionPreset);
  const differentTarget=subscriptionPreset&&subscriptionPreset!==boundPreset&&
    (Object.entries(boundPreset.settings).some(([key,value])=>key!=='provider'&&subscriptionPreset.settings[key]!==value)||
     (boundPreset.settings.provider===subscriptionPreset.settings.provider&&boundPreset.targetId!==subscriptionPreset.targetId));
  const [verified,setVerified]=React.useState(boundPreset.settings.hostKeyConfirmed===true);
  const [state,setState]=React.useState('idle'), [sessionId,setSessionId]=React.useState(null), [busy,setBusy]=React.useState(false);
  const [rendering,setRendering]=React.useState(false), [sending,setSending]=React.useState(false), [pendingIme,setPendingIme]=React.useState(null);
  const [draft,setDraft]=React.useState(''), [composing,setComposing]=React.useState(false), [message,setMessage]=React.useState('');
  const [hasSelection,setHasSelection]=React.useState(false), [subscriptionNotice,setSubscriptionNotice]=React.useState('');
  const [records,setRecords]=React.useState([]), [selected,setSelected]=React.useState(''), [remoteStatus,setRemoteStatus]=React.useState(null);
  const [reviewed,setReviewed]=React.useState(false);
  const token=React.useRef(''), terminal=React.useRef(null), container=React.useRef(null), live=React.useRef(true);
  const stream=React.useRef(null), desiredSize=React.useRef(null);
  const editor=React.useRef(null);
  const blocked=React.useRef(true), outputBusy=React.useRef(false), direct=React.useRef(null), queue=React.useRef(null), current=React.useRef(null);
  const inputPending=React.useRef(false), inputUnconfirmed=React.useRef(false);
  const composerIme=React.useRef({active:false,endedAt:-Infinity});
  const view=React.useRef({});
  const presentation=React.useRef({active,subscriptionPreset,activation});
  if(presentation.current.active!==active||presentation.current.subscriptionPreset!==subscriptionPreset||
    presentation.current.activation!==activation) presentation.current={active,subscriptionPreset,activation};
  current.current={state,sessionId,busy,active,remoteEnabled};

  function claimView(){
    if(!active)return false;
    if(nativeViewOwner.current&&nativeViewOwner.current!==view.current){
      setMessage('另一个工作台正在使用远端终端。请切回该工作台查看或关闭。');
      return false;
    }
    nativeViewOwner.current=view.current;
    return true;
  }
  function releaseView(){
    if(nativeViewOwner.current===view.current)nativeViewOwner.current=null;
  }
  React.useEffect(()=>{
    if(busy||!['idle','closed'].includes(state))return;
    releaseView();
    if(!subscriptionPreset||boundPreset===subscriptionPreset)return;
    if(differentTarget){
      direct.current?.discard();terminal.current?.reset();stream.current=null;
      composerIme.current={active:false,endedAt:-Infinity};
      setHasSelection(false);setSubscriptionNotice('');
      setDraft('');setComposing(false);setPendingIme(null);
    }
    setBoundPreset(subscriptionPreset);
    setVerified(subscriptionPreset.settings.hostKeyConfirmed===true);
    setSelected('');setRecords([]);setSessionId(null);setRemoteStatus(null);setReviewed(false);setMessage('');
  },[state,busy,subscriptionPreset,boundPreset]);

  React.useEffect(()=>{
    live.current=true;
    const available=id=>live.current&&current.current.active&&current.current.remoteEnabled&&nativeViewOwner.current===view.current&&
      current.current.state==='ready'&&!current.current.busy&&id&&id===current.current.sessionId&&!blocked.current;
    const q=createTerminalInputQueue({canQueue:available,canSend:id=>!available(id)?'stop':outputBusy.current?'wait':'ready',
      send:item=>rpc('native-input',{sessionId:item.sessionId,data:toBase64(item.bytes)}),
      onUpdate:value=>{inputPending.current=value;if(live.current)setSending(value);},
      onFailure:error=>{
        if(browseRejected(error)){if(live.current)setMessage('仅浏览模式已拦截这次发送。');return;}
        inputUnconfirmed.current=true;blocked.current=true;
        if(live.current){setState('disconnected');setMessage('输入结果未确认，后续输入已停止；请查询原会话，不会自动重发。');}
      },
      onDrop:()=>{if(live.current)setMessage('连接状态变化，排队输入未发送。');}});
    queue.current=q;
    const term=new Terminal({cols:initialSize.columns,rows:initialSize.rows,disableStdin:true,cursorBlink:true,
      scrollback:1000,theme:{background:'#181a1b',foreground:'#eee8df'}});
    terminal.current=term;term.open(container.current);
    const mount=container.current;
    const observer=new ResizeObserver(()=>{
      const size=measureTerminal(term,mount);
      desiredSize.current=size;
      if(size&&current.current.sessionId&&finalStates.has(current.current.state)) term.resize(size.columns,size.rows);
    });
    observer.observe(mount);
    observer.observe(term.element.querySelector('.xterm-screen'));
    const selection=term.onSelectionChange(()=>setHasSelection(term.hasSelection()));
    direct.current=createDirectTerminalInput(term,{canInput:()=>available(current.current.sessionId),
      onInput:value=>q.enqueue(new TextEncoder().encode(value),current.current.sessionId),
      onPending:value=>{if(live.current)setPendingIme(value);},onNotice:value=>{if(live.current)setMessage(value);}});
    return ()=>{
      live.current=false;observer.disconnect();releaseView();selection?.dispose();direct.current?.dispose();
      direct.current=null;q.dispose();queue.current=null;terminal.current=null;term.dispose();
    };
  },[]);

  async function bootstrap(){
    if(token.current)return;
    let response;try{response=await fetch(API+'bootstrap',{method:'GET',credentials:'same-origin',headers:{'x-rtw-bootstrap':'1'}});}catch{throw new TransportError();}
    if(!response.ok)throw new Error();const value=await response.json();
    if(typeof value.token!=='string'||!value.token)throw new Error();token.current=value.token;
  }
  async function rpc(op,args={}){
    let response;try{response=await fetch(API+'rpc',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json',
      'x-rtw-token':token.current,'x-rtw-nonce':nonce()},body:JSON.stringify({op,...args})});}catch{throw new TransportError();}
    let body;try{body=await response.json();}catch{throw new Error();}
    if(!response.ok||body?.ok!==true){
      const failure=new Error();failure.code=body?.code;throw failure;
    }
    return body.result;
  }
  function subscriptionRequest(mode='new'){
    const {settings,targetId,requireRelay}=boundPreset;
    return {settings,targetId,requireRelay,mode};
  }
  function selectStream(id, acknowledged, fresh=false){
    const previous=stream.current;
    if(previous?.id===id){
      // The bridge may not yet have received the next poll carrying our processed cursor.
      if(acknowledged>previous.after)throw new Error();
      previous.closing=false;
      previous.requestedSize=null;
      return;
    }
    const term=terminal.current;
    term?.reset();
    term?.resize(initialSize.columns,initialSize.rows);
    stream.current={id,after:acknowledged,applying:null,writeUncertain:false,closing:false,
      requestedSize:fresh?initialSize:null};
  }
  async function start(mode){
    if(!remoteEnabled||!verified||busy||!['idle','closed'].includes(state)||!claimView())return;
    const requestedView=presentation.current;
    
    blocked.current=true;setBusy(true);setState('starting');setMessage('');setSubscriptionNotice('');setRemoteStatus(null);setReviewed(false);
    let submitted=false;
    try{
      await bootstrap();
      if(!live.current||presentation.current!==requestedView){if(live.current)setState(state);return;}
      submitted=true;
      const value=await rpc('native-subscription-start',subscriptionRequest(mode));
      if(!value||typeof value.sessionId!=='string'||!['starting','ready','detached'].includes(value.state))throw new Error();
      if(!live.current)return;inputUnconfirmed.current=false;
      selectStream(value.sessionId,0,true);setSessionId(value.sessionId);setSelected(value.sessionId);setState(value.state);
      if(value.state==='detached')setMessage('启动结果未确认，请查询原回执；不会自动重试。');
    }catch(failure){if(live.current){
      const preflightRejected=!submitted||failure.code==='subscription_preflight_rejected'||browseRejected(failure);
      setState(preflightRejected?state:'uncertain');
      setMessage(browseRejected(failure)?'仅浏览模式已拦截终端启动。':preflightRejected?'未启动终端。请核对 VPS 主机指纹和 SSH 中继配置。':
        '启动结果未确认。请先查询当前连接或刷新回执；不会自动重试。');
    }}
    finally{if(live.current)setBusy(false);}
  }
  async function attach(){
    if(!remoteEnabled||busy||!claimView())return;setBusy(true);setMessage('');setSubscriptionNotice('');
    const requestedView=presentation.current;
    try{
      await bootstrap();
      if(!live.current||presentation.current!==requestedView)return;
      const value=await rpc('native-subscription-current',subscriptionRequest());
      if(!live.current||presentation.current!==requestedView)return;
      if(!value||!Number.isSafeInteger(value.acknowledged)||value.acknowledged<0||typeof value.gap!=='boolean')throw new Error();
      if(!value.sessionId){
        stream.current=null;setState('idle');setSessionId(null);setSelected('');
        setMessage(value.otherTerminal?'当前连接不属于这个 Claude 订阅预设。请到原终端处理。':'当前没有可查询的终端。');
        return;
      }
      if(!['starting','ready','closing','detached','closed'].includes(value.state))throw new Error();
      selectStream(value.sessionId,value.acknowledged);blocked.current=true;inputUnconfirmed.current=false;
      setSessionId(value.sessionId);setSelected(value.sessionId);setState(value.state);
      if(value.gap)setMessage('终端输出不完整；请查询原回执。');
      else if(value.state==='detached')setMessage('SSH 已断开；请先查询原回执并核对操作。');
      else setMessage('已查询原连接；没有重发输入。');
    }catch(failure){
      if(failure.code==='subscription_preflight_rejected'&&!sessionId)releaseView();
      setMessage('无法查询当前连接，请稍后重试只读查询。');
    }finally{if(live.current)setBusy(false);}
  }
  const shouldPoll=remoteEnabled&&pollingStates.has(state);
  React.useEffect(()=>{
    const output=stream.current,term=terminal.current;
    if(!shouldPoll||!sessionId||output?.id!==sessionId||!term||!token.current)return;
    let cancelled=false,timer;
    const ownsView=()=>live.current&&stream.current===output&&terminal.current===term;
    const running=()=>!cancelled&&ownsView()&&current.current.remoteEnabled&&!inputUnconfirmed.current;
    const releaseOutput=()=>{
      if(ownsView()&&outputBusy.current){outputBusy.current=false;setRendering(false);}
    };

    async function renderPage(steps){
      for(const step of steps){
        if(!running())return;
        if(step.type==='output')await writeTerminalBytes(term,step.data);
        else blocked.current=true;
        // A write issued before cancellation still counts when the same terminal processed it.
        if(!ownsView())return;
        output.after=step.sequence;
      }
    }

    async function fitReadySession(){
      if(!current.current.active||output.closing||!desiredSize.current)return;
      const size=desiredSize.current;
      if(size.columns===output.requestedSize?.columns&&size.rows===output.requestedSize?.rows)return;
      output.requestedSize=size;
      // The existing resize request acknowledges the local pipe write. OpenSSH delivers the
      // dimensions asynchronously. Apply the grid at the boundary of a drained output page.
      const reply=await rpc('native-resize',{sessionId,...size});
      if(ownsView()&&!output.closing){
        if(reply?.sessionId!==sessionId)throw new Error();
        if(reply.state==='ready')term.resize(size.columns,size.rows);
      }
    }

    async function applyPage(batch){
      if(batch.steps.length){
        outputBusy.current=true;setRendering(true);
        await renderPage(batch.steps);
      }
      if(running()&&output.after===batch.lastSequence&&batch.state==='ready')await fitReadySession();
    }

    async function poll(){
      try{
        if(output.applying)await output.applying;
        if(!running())return;
        if(output.writeUncertain)throw new UnconfirmedTerminalWrite();
        let value;
        try{value=await rpc('native-poll',{sessionId,after:output.after});}
        catch(e){
          if(!(e instanceof TransportError)||!running())throw e;
          blocked.current=true;
          value=await rpc('native-poll',{sessionId,after:output.after});
        }
        if(!running())return;
        const batch=readOutputPage(value,sessionId,output.after);
        output.applying=applyPage(batch);
        try{await output.applying;}
        catch(error){
          if(error instanceof UnconfirmedTerminalWrite)output.writeUncertain=true;
          throw error;
        }finally{
          output.applying=null;
          if(!running())releaseOutput();
        }
        if(!running())return;
        const draining=output.after<batch.lastSequence;
        if(!draining)releaseOutput();
        const done=finalStates.has(batch.state);
        const finalAck=done&&batch.steps.length>0;
        if(batch.state==='ready'&&!draining&&!output.closing)blocked.current=false;
        if(done)blocked.current=true;
        if(blocked.current)queue.current?.discard();else queue.current?.kick();
        const next=(draining||finalAck)&&done||output.closing&&!done?'closing':batch.state;
        setState(next);
        if(!draining&&!finalAck&&batch.state==='detached')setMessage('SSH 连接已断开或关闭；请查询原回执，再核对上次操作。');
        if(draining||finalAck||!done)timer=setTimeout(poll,draining||finalAck?0:pollInterval);
      }catch(e){
        releaseOutput();
        if(running()&&!browseRejected(e)){
          blocked.current=true;queue.current?.discard();setState(e instanceof TransportError?'disconnected':'uncertain');
          setMessage('终端输出或连接状态未确认，请先查询原连接与回执；不会重发输入。');
        }
      }
    }
    void poll();
    return()=>{cancelled=true;clearTimeout(timer);if(!output.applying)releaseOutput();};
  },[sessionId,shouldPoll]);
  React.useEffect(()=>{queue.current?.kick();},[state,sessionId,busy,rendering,active,remoteEnabled]);

  async function list(){
    if(!active||busy||sessionId)return;
    setBusy(true);setMessage('');
    const requestedView=presentation.current;
    try{
      await bootstrap();const value=await rpc('native-list');
      if(!live.current||presentation.current!==requestedView)return;
      if(!value||!Array.isArray(value.records)||value.records.length>100)throw new Error();
      setRecords(value.records);
      setSelected(value.records.some(record=>record.operationId===selected)?selected:value.records[0]?.operationId||'');
      setRemoteStatus(null);
      if(value.truncated||value.invalid)setMessage('部分回执未显示或无法读取；已有文件未更改。');
      else if(!value.records.length)setMessage('没有找到本工作台的远端终端回执。');
    }catch{if(live.current)setMessage('无法读取本机回执。');}finally{if(live.current)setBusy(false);}
  }
  async function query(){
    const target=selected||sessionId;if(!remoteEnabled||!active||!target||busy)return;setBusy(true);setReviewed(false);setRemoteStatus(null);
    const requestedView=presentation.current;
    try{await bootstrap();if(!live.current||presentation.current!==requestedView)return;
      const value=await rpc('native-status',{operationId:target});
      if(!live.current||presentation.current!==requestedView)return;
      if(!value||value.operationId!==target||!['busy','finished','failed','interrupted','not_found','unknown'].includes(value.state))throw new Error();
      setSelected(target);setRemoteStatus(value);setMessage('已查询原回执；请结合原终端输出或远端文件核对上次操作。');
    }catch{setMessage('原回执状态无法确认；不会启动新的恢复进程。');}finally{if(live.current)setBusy(false);}
  }
  async function acknowledge(){
    if(!remoteEnabled||busy||!reviewed||!remoteStatus||selected!==sessionId)return;setBusy(true);
    try{const value=await rpc('native-acknowledge',{operationId:selected,reviewed:true});if(value?.state!=='closed')throw new Error();
      setState('closed');setMessage('原回执已核对；可以手动启动新会话。');setReviewed(false);}
    catch{setMessage('尚不能确认原连接状态；没有启动新会话。');}finally{if(live.current)setBusy(false);}
  }
  async function close(){
    if(!remoteEnabled||!sessionId||busy||!['starting','ready'].includes(state))return;
    if(stream.current?.id===sessionId)stream.current.closing=true;
    blocked.current=true;queue.current?.discard();setBusy(true);setState('closing');
    try{await rpc('native-close',{sessionId});}catch(error){
      if(browseRejected(error)&&stream.current?.id===sessionId)stream.current.closing=false;
      setState(browseRejected(error)?state:'disconnected');
      setMessage(browseRejected(error)?'仅浏览模式已拦截关闭请求。':'关闭结果待确认，请查询原连接。');
    }finally{if(live.current)setBusy(false);}
  }
  const connected=remoteEnabled&&active&&state==='ready'&&!busy&&!blocked.current&&!pendingIme;
  const ready=connected&&!rendering;
  const locked=busy||!['idle','closed'].includes(state);
  const showInterrupt=Boolean(sessionId)&&!['idle','closed'].includes(state);
  function sendSubscription(){
    if(!ready||inputPending.current||composerIme.current.active||!draft.trim())return;
    const value=draft.replace(/\r\n/g,'\n');
    if(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/.test(value)){
      setMessage('消息包含终端控制字符，请删除后重试。');return;
    }
    const multiline=value.includes('\n');
    // Keep line breaks in one edit by using the terminal's bracketed paste mode.
    if(multiline&&terminal.current?.modes?.bracketedPasteMode!==true){
      setMessage('当前终端未启用多行粘贴，请先发送单行消息。');return;
    }
    const input=multiline?'\x1b[200~'+value.replace(/\n/g,'\r')+'\x1b[201~':value;
    const bytes=new TextEncoder().encode(input+'\r');
    if(bytes.length>4096){setMessage('消息超过终端单次输入上限，请缩短后再发送。');return;}
    const previous=draft;
    if(queue.current?.enqueue(bytes,sessionId,()=>{
      if(live.current)setDraft(value=>value===previous?'':value);
    })){
      setMessage('');
      setSubscriptionNotice('');
      editor.current?.focus({preventScroll:true});
    }
    else setMessage('当前状态不能发送。');
  }
  function interruptSubscription(){
    if(!connected||inputPending.current||composerIme.current.active)return false;
    const bytes=new TextEncoder().encode(windowsTerminalKey('Escape'));
    return queue.current?.enqueue(bytes,sessionId,()=>{
      if(live.current)setSubscriptionNotice('已发送 Esc');
    })===true;
  }
  function handleSubscriptionKey(event){
    if(event.defaultPrevented||event.shiftKey||event.ctrlKey||event.altKey||event.metaKey||
      composerIme.current.active||event.nativeEvent.isComposing||event.nativeEvent.keyCode===229||
      event.timeStamp-composerIme.current.endedAt<40)return;
    if(event.key==='Escape'&&!event.repeat&&interruptSubscription()){
      event.preventDefault();
      event.stopPropagation();
    }
    if(event.key==='Enter'){
      event.preventDefault();
      if(!event.repeat)sendSubscription();
    }
  }
  async function copyTerminalSelection(){
    if(!active)return;
    const output=terminal.current?.getSelection();
    if(!output)return;
    let copied=false;
    try{
      await navigator.clipboard.writeText(output);
      copied=true;
    }catch{}
    if(!live.current)return;
    if(copied)setSubscriptionNotice('已复制选中输出');
    else setMessage('无法写入剪贴板，请使用终端的复制快捷键。');
  }
  const statusLabels={idle:'终端会话未连接',starting:'正在连接 VPS 并检查出口',ready:'隔离终端运行中',closing:'正在关闭终端会话',closed:'本机终端已关闭',
    detached:'SSH 已断开，需查询原回执',disconnected:'终端界面连接中断',reconnecting:'正在查询原终端连接',uncertain:'终端操作结果待确认'};
  const remoteLabels={busy:'原账号仍忙或原终端仍运行',finished:'原终端已退出',failed:'原启动失败',interrupted:'原终端已中断，操作结果仍需核对',
    not_found:'未找到原回执，不能自动重发',unknown:'原状态无法确认'};
  const receiptReview=h('label',null,h('input',{type:'checkbox',checked:reviewed,disabled:!remoteStatus,
    onChange:e=>setReviewed(e.target.checked)}),' 我已核对上次输入和远端操作结果');
  const receiptStatus=remoteStatus?h('p',null,remoteLabels[remoteStatus.state]||'状态待确认',
    remoteStatus.exitCode===null?'':`（退出码 ${remoteStatus.exitCode}）`):null;
  const checkReceipt=h('button',{type:'button',className:'vc-button',onClick:query,
    disabled:!remoteEnabled||busy||!(selected||sessionId)},'查询原回执');
  const confirmReceipt=h('button',{type:'button',className:'vc-button',onClick:acknowledge,
    disabled:!remoteEnabled||busy||!reviewed||!remoteStatus||!['finished','failed','interrupted','not_found'].includes(remoteStatus.state)||
      selected!==sessionId||state!=='detached'},'核对后允许新会话');
  const imeNotice=pendingIme?h('div',{className:'vc-feedback',role:'alert'},
    '输入法文本待核对，尚未发送：',h('code',null,pendingIme),
    h('button',{type:'button',className:'vc-button',
      disabled:state!=='ready'||busy||rendering||blocked.current,onClick:()=>direct.current?.confirm()},'发送待核对文本'),
    h('button',{type:'button',className:'vc-button',onClick:()=>direct.current?.discard()},'丢弃待核对文本')):null;
  const sessionActions=[
      h('button',{key:'new',type:'button',className:'vc-button vc-primary',onClick:()=>start('new'),disabled:!remoteEnabled||locked||!verified},'新对话'),
      h('button',{key:'resume',type:'button',className:'vc-button vc-example',onClick:()=>start('picker'),disabled:!remoteEnabled||locked||!verified},'继续会话'),
    ];
    return h('div',{'data-ntw':'','data-subscription':true,'data-session':Boolean(sessionId),
      className:'vc-conversation',role:'region','aria-label':'Claude Code 订阅终端'},
      h('style',null,xtermCss+subscriptionCss),
      h('div',{className:'vc-scroll',tabIndex:-1},
        h('div',{className:'vc-body'},
          !sessionId?h('section',{className:'vc-welcome'},
            h('h1',null,'开始一段对话'),
            h('p',null,boundPreset.name||boundPreset.settings.host,' · ',boundPreset.settings.workspace),
            h('div',{className:'ntw-session-actions'},sessionActions),
            !verified?h('p',null,'请先在 VPS 设置中核对 SSH 主机指纹。'):null):null,
          h('div',{className:'ntw-screen',hidden:!sessionId,'aria-label':'远端终端输出'},
            h('div',{className:'ntw-terminal',ref:container})),
          h('details',{className:'vc-activity',key:sessionId||'history'},
            h('summary',null,sessionId?'会话连接与回执':'本机终端回执'),
            sessionId?h('div',{className:'ntw-session-actions'},checkReceipt,
              ['starting','ready'].includes(state)?h('button',{type:'button',className:'vc-button',
                onClick:close,disabled:!remoteEnabled||busy||sending},'关闭终端'):null):
              h('div',{className:'ntw-session-actions'},
                h('button',{type:'button',className:'vc-button',disabled:busy,onClick:list},'读取本机回执'),
                records.length?h('select',{'aria-label':'选择原回执',value:selected,disabled:busy,
                  onChange:event=>{setSelected(event.target.value);setRemoteStatus(null);}},
                ...records.map(record=>h('option',{key:record.operationId,value:record.operationId},
                  `${record.connection.Host} · ${record.options.workspace} · ${record.createdAt}`))):null,
                records.length?checkReceipt:null),
            receiptStatus,sessionId?receiptReview:null,
            sessionId?h('div',{className:'ntw-session-actions'},confirmReceipt):null))),
      h('div',{className:'vc-compose-area'},
        h('div',{className:'vc-compose-wrap'},
          differentTarget?h('p',{className:'vc-feedback',role:'status'},'当前终端仍关联原 VPS 预设。关闭后可使用新预设。'):null,
          message?h('div',{className:'vc-feedback',role:'alert'},message):null,
          imeNotice,
          h('form',{className:'vc-composer',onSubmit:event=>{event.preventDefault();sendSubscription();}},
            h('textarea',{ref:editor,rows:2,value:draft,maxLength:4096,'aria-label':'Claude Code 消息',
              placeholder:sessionId?'给 Claude Code 发消息':'启动会话后发送消息',
              onChange:event=>setDraft(event.target.value),
              onKeyDown:handleSubscriptionKey,
              onCompositionStart:()=>{composerIme.current.active=true;setComposing(true);},
              onCompositionEnd:event=>{composerIme.current={active:false,endedAt:event.timeStamp};setComposing(false);}}),
            h('div',{className:'vc-composer-toolbar'},
              h('div',{className:'ntw-session-actions',role:'group','aria-label':'会话操作'},
                accessButton,
                sessionId&&!locked?sessionActions:null,
                !['starting','ready','closing'].includes(state)?h('button',{type:'button',className:'vc-button',
                  onClick:attach,disabled:!remoteEnabled||busy||sending},'查询当前连接'):null,
                sessionId?h('button',{type:'button',className:'vc-button',disabled:!active,
                  onClick:()=>terminal.current?.focus()},'聚焦终端'):null,
                hasSelection?h('button',{type:'button',className:'vc-button',onClick:copyTerminalSelection},'复制选中输出'):null),
              h('div',{className:'vc-compose-buttons'},
                showInterrupt?h('button',{type:'button',className:'vc-button vc-compose-action vc-compose-icon-button vc-compose-stop',
                  disabled:!connected||sending||composing,'aria-label':'中断当前操作','aria-keyshortcuts':'Escape',
                  title:'中断当前操作（Esc）',onClick:event=>{if(event.detail<=1)interruptSubscription();}},
                  h('span',{className:'vc-compose-icon','aria-hidden':true})):null,
                h('button',{type:'submit',className:'vc-button vc-primary vc-compose-action vc-compose-icon-button',
                  disabled:!ready||sending||composing||!draft.trim(),'aria-label':'发送消息',title:'发送消息'},
                  h('span',{className:'vc-compose-icon','data-symbol':'send','aria-hidden':true}))))),
          h('p',{className:'vc-compose-hint',role:'status'},!remoteEnabled?'仅浏览':sending?'正在发送':statusLabels[state]||'状态待确认',
            !sending&&state==='ready'&&subscriptionNotice?' · '+subscriptionNotice:null))));
 }

 return function StandaloneSubscriptionTerminal(props) {
   return props?.subscriptionPreset ? h(SubscriptionTerminal, props) : null;
 };
}
