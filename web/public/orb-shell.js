/* ============================================================================
   rak00n orb shell — the orb is the agent; the page is its surface.
   - The orb floats, breathes, and reacts to voice (audio-reactive canvas).
   - Click the orb → the chat panel grows from it. Drag the orb → move it.
   - Agent canvas renders full-screen behind the orb.
   Wires to: POST /v1/chat/stream (SSE), WS /v1/voice/ws, /v1/status,/info.
   ========================================================================== */
(() => {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const orbEl = $('#orb');
  const orbCanvas = orbEl.querySelector('canvas');
  const panel = $('#panel');
  const messages = $('#messages');
  const input = $('#input');

  // ── agent state (shared by orb render + voice) ──────────────────────────
  const agent = { state: 'idle', amp: 0 };      // idle|listening|thinking|speaking|error
  function setState(s) {
    agent.state = s;
    // Reflect status on the collapsed dock circle too.
    const d = document.getElementById('dock');
    const at = document.getElementById('audioToggle');
    if (d) d.dataset.state = (at && at.classList.contains('muted')) ? 'muted' : s;
    updateOrbMotion();
  }
  // The orb drifts gently while SPEAKING — but only when the chat is collapsed.
  // When the chat panel is open it stays anchored (the user moves it by drag).
  function updateOrbMotion() {
    const o = document.getElementById('orb');
    const chatOpen = document.getElementById('panel') && document.getElementById('panel').classList.contains('open');
    if (o) o.classList.toggle('orb-float', agent.state === 'speaking' && !chatOpen);
  }

  // ════════════════════════════════════════════════════════════════════════
  //  ORB — audio-reactive render (NVIDIA green)
  // ════════════════════════════════════════════════════════════════════════
  const COLORS = {
    idle:[118,185,0], listening:[118,185,0], connecting:[143,212,0],
    thinking:[0,200,120], speaking:[143,212,0], error:[239,68,68],
  };
  (function renderOrb() {
    const ctx = orbCanvas.getContext('2d');
    const W = orbCanvas.width, H = orbCanvas.height, cx = W/2, cy = H/2;
    const baseR = Math.min(W, H) * 0.20;
    let phase = 0, smooth = 0;
    const dots = Array.from({ length: 54 }, (_, i) => ({
      a: (i/54)*Math.PI*2, r: baseR*(1.55+Math.random()*0.85),
      sp: 0.0018+Math.random()*0.004, sz: 0.6+Math.random()*1.7,
    }));
    const rgba = ([r,g,b],a) => `rgba(${r},${g},${b},${a})`;
    function frame() {
      requestAnimationFrame(frame);
      ctx.clearRect(0,0,W,H);
      const col = COLORS[agent.state] || COLORS.idle;
      smooth += (Math.min(1, agent.amp) - smooth) * 0.2;
      phase += agent.state === 'thinking' ? 0.06 : 0.024;
      const pulse = Math.sin(phase*1.4)*0.5+0.5;
      const amp = Math.max(smooth, agent.state === 'idle' ? 0 : 0.04);
      const coreR = baseR*(1 + 0.10*pulse + 0.55*amp);
      for (const d of dots) {
        d.a += d.sp;
        const rr = d.r + Math.sin(phase + d.a*3)*4 + amp*30;
        ctx.beginPath(); ctx.arc(cx+Math.cos(d.a)*rr, cy+Math.sin(d.a)*rr, d.sz, 0, 7);
        ctx.fillStyle = rgba(col, 0.22+amp*0.4); ctx.fill();
      }
      for (let i=4;i>=0;i--){ ctx.beginPath(); ctx.arc(cx,cy,coreR+i*(10+amp*14)+pulse*6,0,7);
        ctx.fillStyle = rgba(col,(0.06-i*0.01)*(1+amp)); ctx.fill(); }
      ctx.beginPath();
      const ringR = coreR + 14 + amp*24;
      for (let a=0;a<=6.33;a+=0.08){
        const wob = Math.sin(a*7+phase*3)*(3+amp*18)+Math.sin(a*13-phase*2)*(2+amp*8);
        const r2 = ringR+wob, x=cx+Math.cos(a)*r2, y=cy+Math.sin(a)*r2;
        a===0?ctx.moveTo(x,y):ctx.lineTo(x,y);
      }
      ctx.closePath(); ctx.strokeStyle=rgba(col,0.5+amp*0.4); ctx.lineWidth=1.6; ctx.stroke();
      const g = ctx.createRadialGradient(cx,cy,0,cx,cy,coreR);
      g.addColorStop(0,rgba(col,0.95)); g.addColorStop(0.55,rgba(col,0.5)); g.addColorStop(1,rgba(col,0));
      ctx.beginPath(); ctx.arc(cx,cy,coreR,0,7); ctx.fillStyle=g; ctx.fill();
      ctx.beginPath(); ctx.arc(cx,cy,baseR*0.5*(1+amp*0.3),0,7); ctx.fillStyle=rgba([235,245,225],0.9); ctx.fill();
    }
    frame();
  })();

  // ════════════════════════════════════════════════════════════════════════
  //  ORB position + drag  (click = open panel · drag = move)
  // ════════════════════════════════════════════════════════════════════════
  const SAVED = JSON.parse(localStorage.getItem('rak_orb_pos') || 'null');
  let pos = SAVED || { x: window.innerWidth/2, y: window.innerHeight*0.46 };
  function clampPos() {
    pos.x = Math.max(70, Math.min(window.innerWidth-70, pos.x));
    pos.y = Math.max(80, Math.min(window.innerHeight-80, pos.y));
  }
  function placeOrb() { clampPos(); orbEl.style.left = pos.x+'px'; orbEl.style.top = pos.y+'px'; if (panel.classList.contains('open')) placePanel(); }
  window.addEventListener('resize', placeOrb);

  let drag = null;
  orbEl.addEventListener('pointerdown', (e) => {
    drag = { sx: e.clientX, sy: e.clientY, ox: pos.x, oy: pos.y, moved: false, t: Date.now() };
    orbEl.setPointerCapture(e.pointerId); orbEl.classList.add('dragging');
  });
  orbEl.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
    if (Math.hypot(dx, dy) > 6) drag.moved = true;
    pos.x = drag.ox + dx; pos.y = drag.oy + dy; placeOrb();
  });
  orbEl.addEventListener('pointerup', (e) => {
    orbEl.classList.remove('dragging');
    if (!drag) return;
    if (drag.moved) { localStorage.setItem('rak_orb_pos', JSON.stringify(pos)); }
    else if (voice.speaking) { interrupt(); toast('Stopped'); }  // tap while talking → cut it off
    else { togglePanel(); }                                      // otherwise → open/close chat
    drag = null;
  });

  // ════════════════════════════════════════════════════════════════════════
  //  PANEL — grows from the orb
  // ════════════════════════════════════════════════════════════════════════
  function placePanel() {
    const pw = panel.offsetWidth, ph = panel.offsetHeight;
    let left = pos.x - pw/2;
    let top = pos.y + 130;                        // below the orb by default
    if (top + ph > window.innerHeight - 16) top = pos.y - ph - 130; // flip above
    left = Math.max(12, Math.min(window.innerWidth - pw - 12, left));
    top = Math.max(64, Math.min(window.innerHeight - ph - 12, top));
    panel.style.left = left+'px'; panel.style.top = top+'px';
    const ox = ((pos.x - left)/pw*100), oy = top > pos.y ? 0 : 100;
    panel.style.setProperty('--ox', ox+'%'); panel.style.setProperty('--oy', oy+'%');
  }
  function openPanel() { placePanel(); panel.classList.add('open'); updateOrbMotion(); setTimeout(()=>input.focus(),120); }
  function closePanel() { panel.classList.remove('open'); updateOrbMotion(); }
  function togglePanel() { panel.classList.contains('open') ? closePanel() : openPanel(); }
  $('#panelClose').addEventListener('click', closePanel);

  // ════════════════════════════════════════════════════════════════════════
  //  CHAT — SSE stream
  // ════════════════════════════════════════════════════════════════════════
  // One stable session shared by text + voice so the agent has unified memory.
  let sessionId = localStorage.getItem('rak_session') ||
    ('web-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8));
  localStorage.setItem('rak_session', sessionId);
  const setSession = (id) => { sessionId = id; if (id) localStorage.setItem('rak_session', id); };
  let firstMsg = true;
  function addMsg(role, text) {
    if (firstMsg) { messages.innerHTML=''; firstMsg=false; }
    const div = document.createElement('div'); div.className = `msg ${role}`;
    const who = document.createElement('div'); who.className='who';
    who.textContent = role==='user'?'you':role==='assistant'?'rak00n':role;
    const span = document.createElement('span'); span.textContent = text;
    div.append(who, span); messages.appendChild(div); messages.scrollTop = messages.scrollHeight;
    return span;
  }
  let interim = null;
  function showInterim(t){ if(!interim){interim=document.createElement('div');interim.className='msg interim';messages.appendChild(interim);} interim.textContent=t; messages.scrollTop=messages.scrollHeight; }
  function clearInterim(){ if(interim){interim.remove();interim=null;} }

  let busy = false;
  async function send(text) {
    if (!text.trim() || busy) return;
    busy = true; addMsg('user', text); const out = addMsg('assistant',''); setState('thinking');
    let full = '';
    try {
      const res = await fetch('/v1/chat/stream', {
        method:'POST', headers:{'Content-Type':'application/json'}, credentials:'same-origin',
        body: JSON.stringify({ message:text, session_id:sessionId, include_thinking:false, include_activity:true }),
      });
      if (!res.ok) { out.parentElement.className='msg error'; const b=await res.json().catch(()=>({})); out.textContent=b.error||`HTTP ${res.status}`; return; }
      const reader = res.body.getReader(), dec = new TextDecoder(); let buf='', evt='';
      for(;;){ const {value,done}=await reader.read(); if(done)break;
        buf+=dec.decode(value,{stream:true}); const lines=buf.split('\n'); buf=lines.pop();
        for(const line of lines){
          if(line.startsWith('event: ')) evt=line.slice(7).trim();
          else if(line.startsWith('data: ')&&evt){ let d; try{d=JSON.parse(line.slice(6));}catch{evt='';continue;}
            if(evt==='session') setSession(d.session_id);
            else if(evt==='canvas_open'||evt==='canvas_ready') showCanvas(d.preview_url);
            else if(evt==='canvas_refresh') refreshCanvas();
            else if(evt==='canvas_close') hideCanvas();
            else if(evt==='widget') spawnWidget(d);
            else if(evt==='text_chunk'){ full+=d.text; out.textContent=full; messages.scrollTop=messages.scrollHeight; }
            evt='';
          } else if(line==='') evt='';
        }
      }
      if(!full) out.textContent='(no response)';
    } catch(err){ out.parentElement.className='msg error'; out.textContent=String(err.message||err); }
    finally { busy=false; if(!voice.speaking) setState('idle'); }
  }
  function autoSize(){ input.style.height='auto'; input.style.height=Math.min(120,input.scrollHeight)+'px'; }
  input.addEventListener('input', autoSize);
  input.addEventListener('keydown', (e)=>{ if(e.key==='Enter'&&!e.shiftKey){ e.preventDefault(); const t=input.value; input.value=''; autoSize(); send(t); }});
  $('#sendBtn').addEventListener('click', ()=>{ const t=input.value; input.value=''; autoSize(); send(t); });

  // ════════════════════════════════════════════════════════════════════════
  //  CANVAS — the agent's custom HTML/web-app, rendered as an 'app' widget.
  // ════════════════════════════════════════════════════════════════════════
  let appWg = null;
  function showCanvas(url){ if(!url) return; if(appWg) appWg.remove(); appWg = spawnWidget({ type:'app', title:'Canvas', url }); }
  function refreshCanvas(){ if(appWg){ const f=appWg.querySelector('iframe'); if(f) f.src=f.src; } }
  function hideCanvas(){ if(appWg){ appWg.remove(); appWg=null; } }

  // ════════════════════════════════════════════════════════════════════════
  //  VOICE — continuous WS
  // ════════════════════════════════════════════════════════════════════════
  const voice = { ws:null, ctx:null, stream:null, proc:null, on:false, speaking:false, muted:false, playAt:0, rate:22050, nodes:[] };
  // Stop ALL scheduled audio immediately (already-buffered PCM keeps playing
  // otherwise — the real reason "stop" felt like it didn't cut off).
  function stopPlayback(){
    voice.nodes.forEach(n=>{ try{ n.stop(); }catch{} });
    voice.nodes = [];
    if (voice.ctx) voice.playAt = voice.ctx.currentTime;
  }
  const audioToggle = $('#audioToggle');
  const audioLabel = $('#audioLabel');
  function voiceSend(o) { try { if (voice.ws && voice.ws.readyState === 1) voice.ws.send(JSON.stringify(o)); } catch {} }
  function interrupt() { // stop the orb mid-sentence (server + local audio)
    voiceSend({ type: 'interrupt' });
    voice.speaking = false; agent.amp = 0; setState(voice.on ? 'listening' : 'idle');
    stopPlayback();
  }
  function setAudioChip(mode) { // 'offline' | 'live' | 'muted'
    audioToggle.classList.remove('offline','live','muted');
    audioToggle.classList.add(mode);
    audioLabel.textContent = mode === 'live' ? 'Live' : mode === 'muted' ? 'Muted' : 'Go live';
  }
  // The orb is the agent's voice. The chip wakes it (first time grants mic),
  // then toggles a soft mute — the live session stays up; we just gate the
  // mic + playback instantly so it stops/starts talking.
  audioToggle.addEventListener('click', () => {
    if (!voice.on) { startVoice(); return; }
    voice.muted = !voice.muted;
    if (voice.muted) { setAudioChip('muted'); setState('idle'); agent.amp = 0; }
    else { setAudioChip('live'); setState('listening'); }
  });

  async function startVoice() {
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia)
        throw new Error(!window.isSecureContext
          ? `Microphone needs HTTPS — open https://${location.hostname}:9443 (accept the cert once) or your Tailscale URL.`
          : 'Browser has no microphone support.');
      voice.stream = await navigator.mediaDevices.getUserMedia({ audio:{ channelCount:1, echoCancellation:true, noiseSuppression:true } });
      voice.ctx = new (window.AudioContext||window.webkitAudioContext)();
      const proto = location.protocol==='https:'?'wss:':'ws:';
      voice.ws = new WebSocket(`${proto}//${location.host}/v1/voice/ws?session=${encodeURIComponent(sessionId)}`); voice.ws.binaryType='arraybuffer';
      voice.ws.onopen = () => {
        voice.on = true; voice.muted = false; setAudioChip('live'); setState('listening');
        const src = voice.ctx.createMediaStreamSource(voice.stream);
        const proc = voice.ctx.createScriptProcessor(2048,1,1); voice.proc = proc;
        const inRate = voice.ctx.sampleRate;
        proc.onaudioprocess = (e) => {
          if(!voice.ws||voice.ws.readyState!==1||voice.muted)return;   // muted → don't listen
          const c = e.inputBuffer.getChannelData(0);
          voice.ws.send(downsample(c, inRate).buffer);
          if(!voice.speaking){ let s=0; for(let i=0;i<c.length;i++)s+=c[i]*c[i]; const rms=Math.sqrt(s/c.length); if(rms>0.015){ setState('listening'); agent.amp=Math.min(1,rms*7);} }
        };
        src.connect(proc); proc.connect(voice.ctx.destination);
        toast('Orb is live — listening');
      };
      voice.ws.onmessage = (ev) => {
        if (typeof ev.data!=='string'){ playPcm(ev.data); return; }
        let m; try{m=JSON.parse(ev.data);}catch{return;}
        if(m.type==='transcript'){ if(m.final){ clearInterim(); addMsg('user',m.text); setState('thinking'); } else showInterim(m.text); }
        else if(m.type==='agent_response') addMsg('assistant',m.text);
        else if(m.type==='audio_start'){ voice.speaking=true; voice.rate=m.sample_rate||22050; voice.playAt=0; setState('speaking'); }
        else if(m.type==='audio_end'){ voice.speaking=false; setTimeout(()=>{ if(!busy)setState('idle'); agent.amp=0; },400); }
        else if(m.type==='audio_cancel'){ voice.speaking=false; stopPlayback(); }
        else if(m.type==='error') addMsg('error',m.message);
        else if(m.type==='widget') spawnWidget(m.spec);
      };
      voice.ws.onclose = () => stopVoice();
      voice.ws.onerror = () => toast('Voice connection error');
    } catch(err){ toast(err.message); stopVoice(); }
  }
  function stopVoice(){
    voice.on=false; voice.speaking=false; voice.muted=false; agent.amp=0;
    setAudioChip('offline');
    try{voice.proc&&(voice.proc.onaudioprocess=null);}catch{}
    try{voice.ws&&voice.ws.close();}catch{} try{voice.stream&&voice.stream.getTracks().forEach(t=>t.stop());}catch{}
    try{voice.ctx&&voice.ctx.close();}catch{}
    voice.ws=voice.ctx=voice.stream=voice.proc=null; if(!busy)setState('idle');
  }
  function playPcm(buf){
    if(!voice.ctx||!voice.speaking||voice.muted)return;   // muted → don't talk
    const pcm=new Int16Array(buf), f32=new Float32Array(pcm.length); let peak=0;
    for(let i=0;i<pcm.length;i++){ f32[i]=pcm[i]/32768; if(f32[i]>peak)peak=f32[i]; }
    const ab=voice.ctx.createBuffer(1,f32.length,voice.rate); ab.copyToChannel(f32,0);
    const node=voice.ctx.createBufferSource(); node.buffer=ab; node.connect(voice.ctx.destination);
    // Jitter buffer: Orpheus generates at ~1.1x realtime, so without a cushion
    // the schedule falls behind `now`, resets, and stutters. Lead the first
    // chunk by ~0.7s; on a genuine underrun, resync with only a tiny gap.
    const now=voice.ctx.currentTime;
    if(voice.playAt===0){ voice.playAt=now+0.7; }
    else if(voice.playAt<now){ voice.playAt=now+0.04; }
    node.onended=()=>{ const i=voice.nodes.indexOf(node); if(i>=0)voice.nodes.splice(i,1); };
    voice.nodes.push(node);
    node.start(voice.playAt); voice.playAt+=ab.duration; setState('speaking'); agent.amp=Math.min(1,0.4+peak);
  }
  function downsample(f32,inRate){
    if(inRate===16000){ const o=new Int16Array(f32.length); for(let i=0;i<f32.length;i++){const s=Math.max(-1,Math.min(1,f32[i]));o[i]=s<0?s*0x8000:s*0x7fff;} return o; }
    const ratio=inRate/16000, len=Math.floor(f32.length/ratio), out=new Int16Array(len);
    for(let i=0;i<len;i++){ const s=Math.max(-1,Math.min(1,f32[Math.floor(i*ratio)])); out[i]=s<0?s*0x8000:s*0x7fff; }
    return out;
  }

  // ════════════════════════════════════════════════════════════════════════
  //  CAMERA — let the orb see (off by default). Pushes frames to /v1/av/frame
  //  so the agent's Vision tool can look at the latest view.
  // ════════════════════════════════════════════════════════════════════════
  const cam = { on:false, stream:null, timer:null };
  const camToggle = $('#camToggle');
  const selfView = $('#selfView');
  const capCanvas = $('#capCanvas');
  camToggle.addEventListener('click', () => cam.on ? stopCam() : startCam());
  async function startCam(){
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia)
        throw new Error(!window.isSecureContext
          ? `Camera needs HTTPS — open https://${location.hostname}:9443 or your Tailscale URL.`
          : 'No camera support in this browser.');
      cam.stream = await navigator.mediaDevices.getUserMedia({ video:{ width:640, height:480, facingMode:'user' }, audio:false });
      selfView.srcObject = cam.stream; selfView.classList.add('show');
      cam.on = true; camToggle.classList.remove('cam-off'); camToggle.classList.add('cam-on');
      toast('Camera on — rak00n can see');
      cam.timer = setInterval(pushFrame, 1500);
    } catch(err){ toast(err.message); stopCam(); }
  }
  function stopCam(){
    cam.on=false; camToggle.classList.remove('cam-on'); camToggle.classList.add('cam-off');
    selfView.classList.remove('show'); try{ selfView.srcObject=null; }catch{}
    clearInterval(cam.timer); cam.timer=null;
    try{ cam.stream && cam.stream.getTracks().forEach(t=>t.stop()); }catch{}
    cam.stream=null;
  }
  function pushFrame(){
    if(!cam.on || !selfView.videoWidth) return;
    capCanvas.width = selfView.videoWidth; capCanvas.height = selfView.videoHeight;
    capCanvas.getContext('2d').drawImage(selfView, 0, 0, capCanvas.width, capCanvas.height);
    capCanvas.toBlob((blob)=>{ if(!blob)return;
      fetch('/v1/av/frame', { method:'POST', credentials:'same-origin', headers:{'content-type':'application/octet-stream'}, body:blob }).catch(()=>{});
    }, 'image/jpeg', 0.7);
  }

  // ════════════════════════════════════════════════════════════════════════
  //  TYPED WIDGETS — floating cards (chart / results / video / note)
  // ════════════════════════════════════════════════════════════════════════
  const widgetLayer = $('#widgetLayer');
  const PALETTE = ['#76b900','#00c878','#8fd400','#4bc0c0','#ffb347','#ff6384','#36a2eb'];
  let wgCount = 0;
  const widgets = new Map();   // id → widget element (for update-in-place)
  function esc2(s){ return String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

  function spawnWidget(spec){
    if(!spec || !spec.type || !widgetLayer) return;
    // Update in place if a widget with this id already exists (the agent
    // re-emits the same id to "update the widget", not make a new one).
    if(spec.id && widgets.has(spec.id)){
      const ex = widgets.get(spec.id);
      const ttl = ex.querySelector('.wg-title'); if(ttl) ttl.textContent = spec.title || titleFor(spec);
      if(ex._chart){ try{ ex._chart.destroy(); }catch{} ex._chart=null; }
      const exBody = ex.querySelector('.wg-body'); exBody.innerHTML='';
      try { renderWidget(exBody, spec, ex); } catch(e){ exBody.textContent='widget render error'; }
      ex._spec=spec; bringIntoView(ex);
      return ex;
    }
    const wg = document.createElement('div'); wg.className='wg';
    const wid = spec.id || ('w-'+Date.now().toString(36)+(wgCount));
    wg.dataset.wid = wid;
    const fill = spec.type==='app' || spec.type==='embed';
    const wide = spec.type==='video' || spec.type==='model' || fill;
    if(fill){ wg.classList.add('wg-fill'); wg.style.width='640px'; wg.style.height='460px'; }
    else if(spec.type==='video') wg.style.width='480px';
    else if(spec.type==='model'){ wg.style.width='460px'; wg.style.height='420px'; }
    else if(spec.type==='music'){ wg.style.width='400px'; wg.style.height='240px'; }
    else if(spec.type==='calculator'){ wg.style.width='280px'; wg.style.height='400px'; }
    else if(spec.type==='weather'){ wg.style.width='360px'; wg.style.height='320px'; }
    else if(spec.type==='calendar'){ wg.style.width='420px'; wg.style.height='380px'; }
    else if(spec.type==='code'){ wg.style.width='560px'; wg.style.height='420px'; }
    else if(spec.type==='mail'){ wg.style.width='440px'; wg.style.height='400px'; }
    else if(spec.type==='vercel'){ wg.style.width='420px'; wg.style.height='360px'; }
    else if(spec.type==='map'){ wg.style.width='560px'; wg.style.height='420px'; }
    else if(spec.type==='docker'){ wg.style.width='460px'; wg.style.height='400px'; }
    else if(spec.type==='chart') wg.style.height='340px';   // give charts room (resizable)
    else if(spec.type==='todo'){ wg.style.width='380px'; wg.style.height='360px'; }
    else if(_plugins[spec.type]){ const p=_plugins[spec.type]; if(p.width)wg.style.width=p.width+'px'; if(p.height)wg.style.height=p.height+'px'; }
    wgCount++;
    const w = wide?(fill?640:spec.type==='model'?460:480):380;
    const hGuess = fill?460 : spec.type==='model'?420 : spec.type==='chart'?340 : spec.type==='music'?240 : spec.type==='video'?300 : 300;
    const place = placeWidget(w, hGuess);
    const wpos = { x: place.x, y: place.y };
    wg.style.left=wpos.x+'px'; wg.style.top=wpos.y+'px';
    const head=document.createElement('div'); head.className='wg-head';
    const ttl=document.createElement('span'); ttl.className='wg-title'; ttl.textContent = spec.title || titleFor(spec);
    const x=document.createElement('button'); x.className='wg-x'; x.textContent='✕'; x.onclick=()=>{ widgets.delete(wid); if(wg._chart){try{wg._chart.destroy();}catch{}} wg.remove(); growWidgetCanvas(); };
    head.append(ttl, x); wg.appendChild(head);
    const body=document.createElement('div'); body.className='wg-body'; wg.appendChild(body);
    try { renderWidget(body, spec, wg); } catch(e){ body.textContent='widget render error'; }
    widgets.set(wid, wg);
    widgetLayer.appendChild(wg);
    growWidgetCanvas();
    presentWidget(wpos, w, hGuess, place.scroll);
    // drag the widget by its header
    let d=null;
    head.addEventListener('pointerdown',(e)=>{ if(e.target===x)return; d={sx:e.clientX,sy:e.clientY,ox:wpos.x,oy:wpos.y}; head.setPointerCapture(e.pointerId); });
    head.addEventListener('pointermove',(e)=>{ if(!d)return; wpos.x=d.ox+(e.clientX-d.sx); wpos.y=d.oy+(e.clientY-d.sy); wg.style.left=wpos.x+'px'; wg.style.top=wpos.y+'px'; });
    head.addEventListener('pointerup',()=>{ d=null; growWidgetCanvas(); localStorage.setItem('rak_wg_'+wid, JSON.stringify(wpos)); });
    // lifecycle bookkeeping: track interaction so idle widgets can pill/stop
    wg._spec=spec; wg._lastTouch=Date.now(); wg._state='active';
    wg.addEventListener('pointerdown', ()=>{ if(wg._state!=='active') markTouched(wg); else wg._lastTouch=Date.now(); }, true);
    return wg;
  }

  // ── widget lifecycle: active → telemetry pill (idle) → stopped (stale) → resume.
  //    Keeps the page light: idle widgets shrink to a named pill with a bit of
  //    live info; hours-stale ones free their heavy resources entirely and
  //    re-render from spec the instant you touch them. Tunable below. ──
  const IDLE_TO_PILL = 120000;          // 2 min idle → collapse to a pill
  const IDLE_TO_STALE = 60*60*1000;     // 1 h idle → fully stop (free memory)
  function markTouched(wg){ wg._lastTouch=Date.now(); if(wg._state==='pill'||wg._state==='stale') expandFromPill(wg); }
  // The agent re-emitted an existing widget (same id): expand it if pilled and
  // move it into the CURRENT viewport so "bring that widget back" just works —
  // it's never a duplicate, always the same widget pulled to where you are.
  function bringIntoView(wg){
    markTouched(wg);
    const w=wg.offsetWidth||380; const margin=16, vw=window.innerWidth;
    const y=Math.round(window.scrollY+92); const x=Math.max(margin, vw-w-margin);
    wg.style.left=x+'px'; wg.style.top=y+'px';
    window.scrollTo({ top:Math.max(0,y-92), behavior:'smooth' });
    wg.style.outline='2px solid var(--nv)'; setTimeout(()=>{ wg.style.outline=''; }, 750);
    try{ orbFollow(Math.max(70,x-48), 64); }catch{}
    growWidgetCanvas();
  }
  function pillInfo(wg){
    const s=wg._spec||{};
    if(s.pill) return String(s.pill);                                  // agent-supplied telemetry
    switch(s.type){
      case 'music': return '♪ '+(s.title||'music');
      case 'mail': return (((s.messages||[]).filter(m=>m.unread).length)||0)+' unread';
      case 'docker': return s.cpu!=null?('CPU '+s.cpu+'%'+(s.mem?' · '+s.mem:'')):'docker';
      case 'calendar': return (((s.events||[]).length)||0)+' events';
      case 'vercel': return (((s.deployments||[]).length)||0)+' deploys';
      case 'weather': return (s.current&&s.current.temp!=null)?(s.current.temp+'°'):'weather';
      case 'todo': { const it=s.items||[]; return (it.filter(i=>i.status==='completed').length)+'/'+it.length+' done'; }
      default: return titleFor(s);
    }
  }
  function collapseToPill(wg){
    if(wg._state!=='active') return;
    wg._fullW=wg.style.width||wg.offsetWidth+'px'; wg._fullH=wg.style.height||wg.offsetHeight+'px';
    wg._state='pill'; wg.classList.add('pill');
    let info=wg.querySelector('.wg-pillinfo');
    if(!info){ info=document.createElement('div'); info.className='wg-pillinfo'; wg.appendChild(info); }
    info.textContent=pillInfo(wg);
    growWidgetCanvas();
  }
  function goStale(wg){
    if(wg._state==='stale') return;
    if(wg._chart){ try{wg._chart.destroy();}catch{} wg._chart=null; }
    if(wg._ro){ try{wg._ro.disconnect();}catch{} wg._ro=null; }
    if(wg._map){ try{wg._map.remove();}catch{} wg._map=null; }
    if(wg._mapRo){ try{wg._mapRo.disconnect();}catch{} wg._mapRo=null; }
    wg.querySelectorAll('iframe').forEach(f=>{ try{ f.src='about:blank'; }catch{} });
    const body=wg.querySelector('.wg-body'); if(body) body.innerHTML='';
    if(wg._state==='active') collapseToPill(wg);
    wg._state='stale'; wg.classList.add('pill','stale');
  }
  function expandFromPill(wg){
    const wasStale = wg._state==='stale';
    wg.classList.remove('pill','stale');
    if(wg._fullW) wg.style.width=wg._fullW; if(wg._fullH) wg.style.height=wg._fullH;
    const info=wg.querySelector('.wg-pillinfo'); if(info) info.remove();
    if(wasStale){ const body=wg.querySelector('.wg-body'); if(body){ body.innerHTML=''; try{ renderWidget(body, wg._spec, wg); }catch{} } }
    wg._state='active'; wg._lastTouch=Date.now();
    growWidgetCanvas();
  }
  setInterval(()=>{
    const now=Date.now();
    for(const wg of widgets.values()){
      const idle=now-(wg._lastTouch||now);
      if(wg._state==='active' && idle>IDLE_TO_PILL && !wg.matches(':hover')) collapseToPill(wg);
      else if(wg._state==='pill' && idle>IDLE_TO_STALE) goStale(wg);
      if(wg._state!=='active'){ const i=wg.querySelector('.wg-pillinfo'); if(i){ i.textContent=pillInfo(wg)+(wg._state==='stale'?' · paused':''); } }
    }
  }, 15000);

  function titleFor(s){ return ({chart:'Chart',results:'Results',video:'Video',music:'Music',table:'Table',stats:'Stats',gallery:'Gallery',image:'Image',embed:'Embed',model:'3D model',calculator:'Calculator',weather:'Weather',calendar:'Calendar',code:'Code',mail:'Mail',vercel:'Vercel',map:'Map',docker:'Docker',app:'App'})[s.type]||'Note'; }

  // ── widget placement: free-floating, but flow without >15% overlap; when the
  //    visible band is full, drop below + scroll there (the orb follows). ──
  function widgetRects(skip){
    const out=[]; for(const el of widgets.values()){ if(el===skip)continue; out.push({x:parseFloat(el.style.left)||0,y:parseFloat(el.style.top)||0,w:el.offsetWidth||380,h:el.offsetHeight||300}); } return out;
  }
  function placeWidget(w, h){
    const margin=16, top=84, vw=window.innerWidth, vh=window.innerHeight;
    const rects=widgetRects();
    const okAt=(x,y)=>{ const area=w*h; for(const r of rects){ const ox=Math.max(0,Math.min(x+w,r.x+r.w)-Math.max(x,r.x)); const oy=Math.max(0,Math.min(y+h,r.y+r.h)-Math.max(y,r.y)); if(ox*oy > area*0.15) return false; } return true; };
    const startY=Math.max(top, window.scrollY+top);
    for(let y=startY; y < startY + (vh-h*0.4); y+=36){
      for(let x=vw-w-margin; x>=margin; x-=44){ if(okAt(x,y)) return { x, y, scroll:false }; }
    }
    const maxBottom=rects.reduce((m,r)=>Math.max(m, r.y+r.h), window.scrollY+top);
    return { x: Math.max(16, vw-w-margin), y: maxBottom+18, scroll:true };
  }
  function growWidgetCanvas(){
    let maxB=window.innerHeight;
    for(const el of widgets.values()){ maxB=Math.max(maxB, (parseFloat(el.style.top)||0)+el.offsetHeight); }
    widgetLayer.style.minHeight=(maxB+60)+'px';
  }
  function presentWidget(wpos, w, h, didScroll){
    const top=84;
    if(didScroll || (wpos.y + h) > (window.scrollY + window.innerHeight)){
      window.scrollTo({ top: Math.max(0, wpos.y - top), behavior:'smooth' });
      orbFollow(Math.max(70, wpos.x - 48), top + 64);
    } else {
      orbFollow(Math.max(70, wpos.x - 48), (wpos.y - window.scrollY) + 46);
    }
  }

  function renderWidget(body, spec, wg){
    if(spec.type==='chart') renderChart(body, spec, wg);
    else if(spec.type==='results') renderResults(body, spec);
    else if(spec.type==='video') renderVideo(body, spec);
    else if(spec.type==='music') renderMusic(body, spec);
    else if(spec.type==='table') renderTable(body, spec);
    else if(spec.type==='stats') renderStats(body, spec);
    else if(spec.type==='gallery') renderGallery(body, spec);
    else if(spec.type==='image') renderImage(body, spec);
    else if(spec.type==='embed') renderEmbed(body, spec);
    else if(spec.type==='model') renderModel(body, spec);
    else if(spec.type==='calculator') renderCalculator(body, spec);
    else if(spec.type==='weather') renderWeather(body, spec);
    else if(spec.type==='calendar') renderCalendar(body, spec);
    else if(spec.type==='code') renderCode(body, spec);
    else if(spec.type==='mail') renderMail(body, spec);
    else if(spec.type==='vercel') renderVercel(body, spec);
    else if(spec.type==='map') renderMap(body, spec, wg);
    else if(spec.type==='docker') renderDocker(body, spec);
    else if(spec.type==='todo') renderTodo(body, spec);
    else if(spec.type==='app') renderApp(body, spec);
    else if(_plugins[spec.type]) renderPlugin(body, spec, _plugins[spec.type]);
    else { const note=document.createElement('div'); note.className='wg-note'; note.textContent=spec.text||''; body.appendChild(note); }
  }

  // ── Tasks (console-styled live to-do list driven by the agent) ──
  function renderTodo(body, spec){
    const wrap=document.createElement('div'); wrap.className='wg-todo';
    const items=spec.items||[];
    if(!items.length){ const e=document.createElement('div'); e.className='wg-todo-empty'; e.textContent='> waiting for tasks…'; wrap.appendChild(e); body.appendChild(wrap); return; }
    items.forEach(it=>{
      const st=it.status||'pending';
      const row=document.createElement('div'); row.className='wg-todo-row '+st;
      const g=document.createElement('span'); g.className='g';
      g.textContent = st==='completed'?'✓' : st==='in_progress'?'▸' : '·';
      const t=document.createElement('span'); t.className='t'; t.textContent=it.text||it.content||'';
      row.appendChild(g); row.appendChild(t); wrap.appendChild(row);
    });
    body.appendChild(wrap);
  }

  // ── Custom widget plugins (runtime, no recompile) ──
  const _plugins = {};
  async function loadPlugins(){
    try{ const d=await (await fetch('/v1/widgets/plugins',{credentials:'same-origin'})).json();
      for(const p of (d.plugins||[])) if(p&&p.type) _plugins[p.type]=p;
    }catch{}
  }
  async function renderPlugin(body, spec, plugin){
    try{
      const mod = await import(`/v1/widgets/plugins/${plugin.id}/render.js`);
      const fn = mod.render || mod.default;
      if(typeof fn!=='function') throw new Error('plugin exports no render()');
      await fn(body, spec, { esc });   // small helper surface for plugins
    }catch(e){ const n=document.createElement('div'); n.className='wg-note'; n.textContent='“'+(plugin.name||spec.type)+'” plugin failed: '+e.message; body.appendChild(n); }
  }
  function renderTable(body, spec){
    const t=document.createElement('table'); t.className='wg-table';
    if(spec.columns&&spec.columns.length){ const tr=document.createElement('tr'); spec.columns.forEach(c=>{ const th=document.createElement('th'); th.textContent=c; tr.appendChild(th); }); t.appendChild(tr); }
    (spec.rows||[]).forEach(r=>{ const tr=document.createElement('tr'); (Array.isArray(r)?r:[r]).forEach(c=>{ const td=document.createElement('td'); td.textContent=c==null?'':String(c); tr.appendChild(td); }); t.appendChild(tr); });
    body.appendChild(t);
  }
  function renderStats(body, spec){
    const g=document.createElement('div'); g.className='wg-stats';
    (spec.stats||[]).forEach(s=>{ const c=document.createElement('div'); c.className='wg-stat';
      c.innerHTML=`<div class="wg-stat-v">${esc2(s.value)}</div><div class="wg-stat-l">${esc2(s.label)}</div>${s.sub?`<div class="wg-stat-s">${esc2(s.sub)}</div>`:''}`; g.appendChild(c); });
    body.appendChild(g);
  }
  function renderGallery(body, spec){
    const g=document.createElement('div'); g.className='wg-gallery';
    (spec.images||[]).forEach(im=>{ const fig=document.createElement('div'); fig.className='wg-gitem';
      fig.innerHTML=`<img src="${esc2(im.url)}" onerror="this.style.visibility='hidden'"/>${im.caption?`<span>${esc2(im.caption)}</span>`:''}`;
      fig.onclick=()=>spawnWidget({type:'image',title:im.caption||'Image',url:im.url,caption:im.caption}); g.appendChild(fig); });
    body.appendChild(g);
  }
  function renderImage(body, spec){
    const i=document.createElement('img'); i.className='wg-image'; i.src=spec.url||''; body.appendChild(i);
    if(spec.caption){ const c=document.createElement('div'); c.className='wg-it-sub'; c.style.marginTop='6px'; c.textContent=spec.caption; body.appendChild(c); }
  }
  function renderEmbed(body, spec){
    const url=spec.url||'';
    const ok=/(sketchfab\.com|openstreetmap\.org|youtube(-nocookie)?\.com|player\.vimeo\.com|codesandbox\.io)/.test(url);
    if(ok){ const f=document.createElement('iframe'); f.className='wg-app'; f.src=url; f.setAttribute('allow','autoplay; fullscreen; xr-spatial-tracking; encrypted-media'); f.setAttribute('allowfullscreen',''); body.appendChild(f); }
    else { const a=document.createElement('a'); a.href=url; a.target='_blank'; a.rel='noopener'; a.className='set-url'; a.textContent='Open ↗ '+url; body.appendChild(a); }
  }
  function renderModel(body, spec){
    const mv=document.createElement('model-viewer');
    mv.className='wg-model';
    mv.setAttribute('src', spec.url||'');
    mv.setAttribute('camera-controls','');
    mv.setAttribute('auto-rotate','');
    mv.setAttribute('shadow-intensity','1');
    mv.setAttribute('environment-image','neutral');
    mv.setAttribute('ar','');
    mv.setAttribute('touch-action','pan-y');
    mv.setAttribute('loading','eager');
    body.appendChild(mv);
  }
  // ── Calculator (fully interactive, no backend) ──
  function renderCalculator(body, spec){
    const wrap=document.createElement('div'); wrap.className='wg-calc';
    const out=document.createElement('div'); out.className='wg-calc-out'; out.textContent='0';
    const keys=['C','±','%','÷','7','8','9','×','4','5','6','−','1','2','3','+','0','.','='];
    const grid=document.createElement('div'); grid.className='wg-calc-grid';
    let expr='', justEvaled=false;
    const sym={'÷':'/','×':'*','−':'-','+':'+'};
    const show=v=>{ out.textContent = (v.length>12? v.slice(0,12) : v) || '0'; };
    keys.forEach(k=>{
      const b=document.createElement('button'); b.className='wg-calc-key'; b.textContent=k;
      if('÷×−+='.includes(k)) b.classList.add('op'); if(k==='C') b.classList.add('clr');
      if(k==='0') b.classList.add('zero');
      b.onclick=()=>{
        try{
          if(k==='C'){ expr=''; show('0'); return; }
          if(k==='±'){ if(expr) expr = expr.startsWith('-')? expr.slice(1) : '-'+expr; show(expr); return; }
          if(k==='%'){ if(expr){ expr=String(parseFloat(eval(toJs(expr)))/100); show(expr);} return; }
          if(k==='='){ if(expr){ const r=eval(toJs(expr)); show(String(r)); expr=String(r); justEvaled=true; } return; }
          if(justEvaled && !'÷×−+'.includes(k)){ expr=''; justEvaled=false; }
          justEvaled=false; expr+=k; show(expr);
        }catch{ show('Error'); expr=''; }
      };
      grid.appendChild(b);
    });
    function toJs(e){ return e.replace(/[÷×−]/g, m=>sym[m]); }
    wrap.append(out, grid); body.appendChild(wrap);
  }

  // ── Weather (renders data the agent provides; wire to an API later) ──
  function renderWeather(body, spec){
    const w=document.createElement('div'); w.className='wg-weather';
    const cur=spec.current||{};
    const ic=weatherIcon(cur.condition||cur.icon||'');
    w.innerHTML=`<div class="wg-wx-loc">${esc2(spec.location||'—')}</div>
      <div class="wg-wx-now"><span class="wg-wx-ic">${ic}</span><span class="wg-wx-temp">${cur.temp!=null?esc2(cur.temp)+'°':'—'}</span></div>
      <div class="wg-wx-cond">${esc2(cur.condition||'')}</div>
      <div class="wg-wx-meta">${cur.humidity!=null?'💧 '+esc2(cur.humidity)+'%':''} ${cur.wind!=null?' · 🌬 '+esc2(cur.wind):''}</div>`;
    if(Array.isArray(spec.forecast)&&spec.forecast.length){
      const f=document.createElement('div'); f.className='wg-wx-fc';
      spec.forecast.slice(0,6).forEach(d=>{ const c=document.createElement('div'); c.className='wg-wx-day';
        c.innerHTML=`<span>${esc2(d.day||'')}</span><span class="i">${weatherIcon(d.condition||'')}</span><span class="t">${d.high!=null?esc2(d.high)+'°':''}${d.low!=null?' <em>'+esc2(d.low)+'°</em>':''}</span>`; f.appendChild(c); });
      w.appendChild(f);
    }
    body.appendChild(w);
  }
  function weatherIcon(c){ c=(c||'').toLowerCase();
    if(/storm|thunder/.test(c))return'⛈'; if(/snow|sleet|flurr/.test(c))return'❄️';
    if(/rain|drizzle|shower/.test(c))return'🌧'; if(/fog|mist|haze/.test(c))return'🌫';
    if(/cloud|overcast/.test(c))return'☁️'; if(/part/.test(c))return'⛅'; if(/clear|sun/.test(c))return'☀️'; return'🌡'; }

  // ── Calendar (month grid + agenda; wire to Google Calendar later) ──
  function renderCalendar(body, spec){
    const now=new Date();
    const ym=(spec.month||'').match(/^(\d{4})-(\d{2})/);
    const year=ym?+ym[1]:now.getFullYear(), mon=ym?(+ym[2]-1):now.getMonth();
    const events=(spec.events||[]).reduce((m,e)=>{ const d=(e.date||'').slice(0,10); (m[d]=m[d]||[]).push(e); return m; },{});
    const c=document.createElement('div'); c.className='wg-cal';
    const first=new Date(year,mon,1), days=new Date(year,mon+1,0).getDate(), pad=first.getDay();
    const head=document.createElement('div'); head.className='wg-cal-head';
    head.textContent=first.toLocaleString(undefined,{month:'long',year:'numeric'}); c.appendChild(head);
    const grid=document.createElement('div'); grid.className='wg-cal-grid';
    ['S','M','T','W','T','F','S'].forEach(d=>{ const h=document.createElement('div'); h.className='wg-cal-dow'; h.textContent=d; grid.appendChild(h); });
    for(let i=0;i<pad;i++){ const e=document.createElement('div'); e.className='wg-cal-cell empty'; grid.appendChild(e); }
    for(let d=1;d<=days;d++){
      const key=`${year}-${String(mon+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
      const cell=document.createElement('div'); cell.className='wg-cal-cell';
      if(year===now.getFullYear()&&mon===now.getMonth()&&d===now.getDate()) cell.classList.add('today');
      if(events[key]) cell.classList.add('has');
      cell.innerHTML=`<span class="n">${d}</span>${events[key]?'<span class="dot"></span>':''}`;
      if(events[key]) cell.title=events[key].map(e=>`${e.time||''} ${e.title||''}`.trim()).join('\n');
      grid.appendChild(cell);
    }
    c.appendChild(grid);
    const upcoming=(spec.events||[]).filter(e=>e.title).slice(0,4);
    if(upcoming.length){ const ag=document.createElement('div'); ag.className='wg-cal-agenda';
      upcoming.forEach(e=>{ const r=document.createElement('div'); r.className='wg-cal-ev';
        r.innerHTML=`<span class="d">${esc2((e.date||'').slice(5,10))}</span><span class="ti">${esc2(e.time||'')}</span><span class="t">${esc2(e.title||'')}</span>`; ag.appendChild(r); });
      c.appendChild(ag);
    }
    body.appendChild(c);
  }

  // ── Code (self-contained highlighter — CSP-safe, no CDN) ──
  function hlCode(code){
    const RE=/(\/\/[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/|--[^\n]*)|(`(?:\\.|[^`\\])*`|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|\b(0x[\da-fA-F]+|\d+\.?\d*)\b|\b(const|let|var|function|fn|def|class|struct|interface|type|enum|return|if|else|elif|for|while|do|switch|case|break|continue|import|export|from|package|use|pub|async|await|new|extends|implements|public|private|protected|static|readonly|void|int|float|double|bool|boolean|string|char|true|false|null|nil|None|True|False|undefined|this|self|super|throw|throws|try|catch|finally|with|as|in|of|match|impl|func|range|defer|go|yield|lambda|not|and|or|is|namespace|module|require)\b/g;
    let out='',last=0,m; const e=s=>esc2(s);
    while((m=RE.exec(code))){ out+=e(code.slice(last,m.index));
      const cls=m[1]?'c-cm':m[2]?'c-st':m[3]?'c-nu':'c-kw';
      out+=`<span class="${cls}">${e(m[0])}</span>`; last=m.index+m[0].length; }
    out+=e(code.slice(last)); return out;
  }
  function renderCode(body, spec){
    const code=String(spec.code||spec.text||''); const lang=spec.language||spec.lang||'';
    const wrap=document.createElement('div'); wrap.className='wg-code';
    const bar=document.createElement('div'); bar.className='wg-code-bar';
    bar.innerHTML=`<span class="lang">${esc2(spec.filename||lang||'code')}</span>`;
    const cp=document.createElement('button'); cp.className='wg-code-copy'; cp.textContent='Copy';
    cp.onclick=()=>{ navigator.clipboard&&navigator.clipboard.writeText(code); cp.textContent='Copied'; setTimeout(()=>cp.textContent='Copy',1200); };
    bar.appendChild(cp);
    const pre=document.createElement('pre'); pre.className='wg-code-pre';
    const lines=code.split('\n');
    const gutter=lines.map((_,i)=>i+1).join('\n');
    pre.innerHTML=`<span class="wg-code-ln">${gutter}</span><code>${hlCode(code)}</code>`;
    wrap.append(bar, pre); body.appendChild(wrap);
  }

  // ── Docker (live micro-app: list + user/agent control) ──
  function renderDocker(body, spec){
    const wrap=document.createElement('div'); wrap.className='wg-docker'; body.appendChild(wrap);
    const ctrl=async(action,target)=>{ try{ await fetch('/v1/docker/control',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({action,target})}); }catch{} refresh(); };
    const btn=(label,action,target,cls)=>{ const b=document.createElement('button'); b.className='wg-dk-btn'+(cls?' '+cls:''); b.textContent=label;
      b.onclick=(e)=>{ e.stopPropagation(); b.disabled=true; b.textContent='…'; ctrl(action,target); }; return b; };
    const render=(cs)=>{
      wrap.innerHTML='';
      if(!(cs||[]).length){ wrap.innerHTML='<div class="set-muted small" style="padding:10px;">No containers.</div>'; return; }
      cs.forEach(c=>{ const st=(c.state||'').toLowerCase(); const cls=st==='running'?'ok':/exit|dead|created/.test(st)?'err':'warn';
        const row=document.createElement('div'); row.className='wg-dk-row';
        row.innerHTML=`<span class="dot ${cls}"></span><div class="grow"><div class="nm">${esc2(c.name)}</div><div class="mt">${esc2((c.image||'').slice(0,32))}${c.cpu?' · '+esc2(c.cpu):''}${c.mem?' · '+esc2(String(c.mem).slice(0,18)):''}</div></div>`;
        const act=document.createElement('div'); act.className='wg-dk-act';
        if(st==='running'){ act.append(btn('↻','restart',c.name), btn('Stop','stop',c.name,'danger')); }
        else { act.append(btn('Start','start',c.name,'ok')); }
        row.appendChild(act); wrap.appendChild(row);
      });
    };
    async function refresh(){ try{ const d=await (await fetch('/v1/docker/list',{credentials:'same-origin'})).json(); render(d.containers||[]); }catch{} }
    render(spec.containers||[]); refresh();
  }

  // ── Map (Leaflet + OSM): markers + route polyline, updated in place ──
  function renderMap(body, spec, wg){
    if(typeof L==='undefined'){ body.textContent='map library not loaded'; return; }
    const el=document.createElement('div'); el.className='wg-map'; body.appendChild(el);
    const mk=(spec.markers||[]).filter(m=>m&&m.lat!=null);
    const center = spec.center || (mk[0]&&[mk[0].lat,mk[0].lng]) || (spec.route&&spec.route[0]) || [40.4168,-3.7038];
    const map = L.map(el, { zoomControl:true, attributionControl:false }).setView(center, spec.zoom||12);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom:19 }).addTo(map);
    const bounds=[];
    mk.forEach(m=>{ const k=L.marker([m.lat,m.lng]).addTo(map); if(m.label) k.bindPopup(esc2(m.label)); bounds.push([m.lat,m.lng]); });
    if(Array.isArray(spec.route)&&spec.route.length>1){ L.polyline(spec.route,{color:'#76b900',weight:5,opacity:.9}).addTo(map); spec.route.forEach(p=>bounds.push(p)); }
    if(bounds.length>1){ try{ map.fitBounds(bounds,{padding:[28,28]}); }catch{} }
    if(wg){ if(wg._map){ try{wg._map.remove();}catch{} } wg._map=map;
      setTimeout(()=>{ try{ map.invalidateSize(); }catch{} }, 60);
      if(window.ResizeObserver && !wg._mapRo){ wg._mapRo=new ResizeObserver(()=>{ try{ wg._map&&wg._map.invalidateSize(); }catch{} }); wg._mapRo.observe(el); }
    }
  }

  // ── Mail (inbox preview; wire to Gmail/Outlook later) ──
  function renderMail(body, spec){
    const list=document.createElement('div'); list.className='wg-mail';
    (spec.messages||[]).forEach(m=>{ const r=document.createElement('div'); r.className='wg-mail-row'+(m.unread?' unread':'');
      r.innerHTML=`<div class="wg-mail-top"><span class="from">${esc2(m.from||'')}</span><span class="date">${esc2(m.date||'')}</span></div>
        <div class="subj">${esc2(m.subject||'')}</div><div class="snip">${esc2(m.snippet||m.preview||'')}</div>`;
      if(m.url){ r.style.cursor='pointer'; r.onclick=()=>window.open(m.url,'_blank','noopener'); }
      list.appendChild(r); });
    if(!(spec.messages||[]).length){ list.innerHTML='<div class="set-muted small" style="padding:10px;">No messages.</div>'; }
    body.appendChild(list);
  }

  // ── Vercel deployments (wire to the Vercel connector later) ──
  function renderVercel(body, spec){
    const deps=spec.deployments||(spec.deployment?[spec.deployment]:[]);
    const list=document.createElement('div'); list.className='wg-vercel';
    deps.forEach(d=>{ const st=(d.state||d.readyState||'').toLowerCase();
      const cls=/ready|success/.test(st)?'ok':/build|queu|pending/.test(st)?'warn':/error|fail|cancel/.test(st)?'err':'';
      const r=document.createElement('div'); r.className='wg-vc-row';
      r.innerHTML=`<span class="dot ${cls}"></span><div class="grow"><div class="nm">${esc2(d.name||d.url||'deploy')}</div><div class="mt">${esc2(d.branch||'')}${d.created?' · '+esc2(d.created):''}</div></div><span class="st ${cls}">${esc2(d.state||d.readyState||'')}</span>`;
      if(d.url){ r.style.cursor='pointer'; r.onclick=()=>window.open((d.url.startsWith('http')?'':'https://')+d.url,'_blank','noopener'); }
      list.appendChild(r); });
    if(!deps.length){ list.innerHTML='<div class="set-muted small" style="padding:10px;">No deployments.</div>'; }
    body.appendChild(list);
  }

  function renderApp(body, spec){
    const f=document.createElement('iframe'); f.className='wg-app';
    f.setAttribute('sandbox','allow-scripts allow-same-origin allow-forms allow-popups allow-modals');
    f.src=spec.url||''; body.appendChild(f);
    f.addEventListener('load',()=>{ try{ const t=f.contentDocument&&f.contentDocument.title; if(t&&!spec.title){ const tt=body.parentElement&&body.parentElement.querySelector('.wg-title'); if(tt) tt.textContent=t; } }catch{} });
  }
  function renderChart(body, spec, wg){
    if(typeof Chart==='undefined'){ body.textContent='chart library not loaded'; return; }
    const wrap=document.createElement('div'); wrap.className='wg-chart';
    const cv=document.createElement('canvas'); wrap.appendChild(cv); body.appendChild(wrap);
    const pie = spec.chart_type==='pie'||spec.chart_type==='doughnut';
    const datasets=(spec.datasets||[]).map((dd,i)=>({
      label: dd.label||('Series '+(i+1)), data: dd.data||[],
      backgroundColor: pie?PALETTE:PALETTE[i%PALETTE.length],
      borderColor: PALETTE[i%PALETTE.length], borderWidth:1.5, fill:false, tension:.3,
    }));
    const chart = new Chart(cv.getContext('2d'), {
      type: spec.chart_type||'bar',
      data: { labels: spec.labels||[], datasets },
      options: { responsive:true, maintainAspectRatio:false, plugins:{ legend:{ labels:{ color:'#9fb098', font:{size:11}, boxWidth:12 } } },
        scales: pie?{}:{ x:{ ticks:{color:'#9fb098'}, grid:{color:'rgba(255,255,255,.06)'} }, y:{ ticks:{color:'#9fb098'}, grid:{color:'rgba(255,255,255,.06)'}, beginAtZero:true } } },
    });
    if(wg){ wg._chart = chart;
      if(window.ResizeObserver && !wg._ro){ wg._ro = new ResizeObserver(()=>{ try{ wg._chart && wg._chart.resize(); }catch{} }); wg._ro.observe(wg); }
    }
  }
  function renderResults(body, spec){
    (spec.items||[]).forEach(it=>{
      const row=document.createElement('div'); row.className='wg-item';
      row.innerHTML = (it.thumbnail?`<img class="wg-thumb" src="${esc2(it.thumbnail)}" onerror="this.style.visibility='hidden'"/>`:'')
        + `<div class="grow"><div class="wg-it-title">${esc2(it.title)}</div>${it.subtitle?`<div class="wg-it-sub">${esc2(it.subtitle)}</div>`:''}</div>`;
      if(it.action){ row.addEventListener('click',()=>{
        if(it.action.kind==='video') spawnWidget({ type:'video', title:it.title, url:it.action.url, provider:it.action.provider });
        else if(it.action.kind==='music') spawnWidget({ type:'music', title:it.title, url:it.action.url });
        else if(it.action.kind==='link' && it.action.url) window.open(it.action.url,'_blank','noopener');
      }); } else { row.style.cursor='default'; }
      body.appendChild(row);
    });
  }
  function renderMusic(body, spec){
    const f=document.createElement('iframe'); f.className='wg-music'; f.src=spec.url||'';
    f.setAttribute('allow','autoplay; encrypted-media; clipboard-write; fullscreen; picture-in-picture');
    f.setAttribute('allowfullscreen',''); body.appendChild(f);
  }
  function renderVideo(body, spec){
    const src=embedUrl(spec.url, spec.provider);
    if((spec.provider==='direct') || (!src && /\.(mp4|webm|ogg)(\?|$)/i.test(spec.url||''))){
      const v=document.createElement('video'); v.className='wg-video'; v.controls=true; v.autoplay=true; v.src=spec.url||''; body.appendChild(v);
    } else if(src){
      const f=document.createElement('iframe'); f.className='wg-video'; f.src=src;
      f.setAttribute('allow','autoplay; encrypted-media; picture-in-picture'); f.setAttribute('allowfullscreen','');
      body.appendChild(f);
    } else { body.textContent='Cannot play this video.'; }
  }
  function embedUrl(url, provider){
    if(!url) return null; let m;
    if(provider==='youtube' || /youtu/.test(url)){ m=url.match(/(?:v=|youtu\.be\/|embed\/|shorts\/)([\w-]{11})/); if(m) return `https://www.youtube.com/embed/${m[1]}?autoplay=1`; }
    if(provider==='vimeo' || /vimeo/.test(url)){ m=url.match(/vimeo\.com\/(?:video\/)?(\d+)/); if(m) return `https://player.vimeo.com/video/${m[1]}?autoplay=1`; }
    return null;
  }

  // Orb auto-follow: ease the orb toward a point to present new content, then
  // rest there. Manual drag overrides instantly (the step bails while dragging).
  let followRaf = null;
  function orbFollow(tx, ty){
    // Anchored while the chat is open — only the user moves it then.
    if(panel.classList.contains('open')) return;
    tx = Math.max(70, Math.min(window.innerWidth-70, tx));
    ty = Math.max(90, Math.min(window.innerHeight-90, ty));
    if(followRaf) cancelAnimationFrame(followRaf);
    // Eased glide (ease-in-out over ~700ms) so it feels alive, not a jump.
    const sx=pos.x, sy=pos.y, t0=performance.now(), dur=720;
    const ease=t=> t<.5 ? 2*t*t : 1-Math.pow(-2*t+2,2)/2;
    const step=(now)=>{
      if(drag || panel.classList.contains('open')){ followRaf=null; return; }  // drag / chat-open wins
      const k=Math.min(1,(now-t0)/dur), e=ease(k);
      pos.x = sx+(tx-sx)*e; pos.y = sy+(ty-sy)*e; placeOrb();
      if(k<1) followRaf=requestAnimationFrame(step);
      else { followRaf=null; localStorage.setItem('rak_orb_pos', JSON.stringify(pos)); }
    };
    followRaf=requestAnimationFrame(step);
  }

  // Dock collapse/expand: desktop expands on :hover; touch taps the circle.
  const dockEl = $('#dock');
  dockEl.addEventListener('click', (e) => {
    if (dockEl.classList.contains('collapsed') && e.target.classList.contains('dock-pulse')) {
      dockEl.classList.add('expanded'); e.stopPropagation();
    }
  });
  document.addEventListener('click', (e) => { if (!dockEl.contains(e.target)) dockEl.classList.remove('expanded'); });

  // ════════════════════════════════════════════════════════════════════════
  //  SETTINGS — floating panel (gear toggles open/closed)
  // ════════════════════════════════════════════════════════════════════════
  const settingsPanel = $('#settingsPanel');
  let settingsLoaded = false;
  function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
  function openSettings(){ settingsPanel.classList.add('open'); if(!settingsLoaded){ loadSettings(); settingsLoaded=true; } }
  $('#setClose').addEventListener('click', ()=> settingsPanel.classList.remove('open'));
  // Topbar menu: the wheel/⋯ opens a small menu (Settings · Publish).
  const topMenu = $('#topMenu');
  $('#gearBtn').addEventListener('click', (e)=>{ e.stopPropagation(); topMenu.classList.toggle('open'); });
  document.addEventListener('click', (e)=>{ if(!e.target.closest('.menu-wrap')) topMenu.classList.remove('open'); });
  topMenu.querySelectorAll('.tm-item').forEach(b=>b.addEventListener('click',()=>{
    topMenu.classList.remove('open');
    if(b.dataset.act==='settings') openSettings();
    else if(b.dataset.act==='publish') publishCollection();
  }));
  function publishCollection(){
    openPanel();
    send("Publish what we've been looking at: use the Canvas tool to assemble the charts, data and content from this conversation into ONE clean, self-contained web page laid out in a responsive grid (include any chart data inline with Chart.js via CDN), then call the Publish tool and give me the shareable link.");
  }
  document.querySelectorAll('.set-navi[data-sec]').forEach(b=>b.addEventListener('click',()=>{
    document.querySelectorAll('.set-navi[data-sec]').forEach(x=>x.classList.toggle('active',x===b));
    document.querySelectorAll('.set-sec').forEach(s=>s.classList.toggle('active', s.dataset.sec===b.dataset.sec));
  }));

  function chRow(name,state,ok){ return `<div class="set-item"><span class="pill-dot ${ok?'ok':'err'}"></span><div class="grow"><div class="t">${esc(name)}</div><div class="s">${esc(state)}</div></div></div>`; }

  async function loadSettings(){
    $('#setLanUrl').textContent = `https://${location.hostname}:9443`;
    $('#setCopyUrl').addEventListener('click',()=>{ navigator.clipboard?.writeText($('#setPublicUrl').textContent); toast('Copied'); });
    $('#setUserAdd').addEventListener('click', addUser);
    $('#setMcpAdd').addEventListener('click', addMcp);
    $('#tsUpBtn')?.addEventListener('click', tailscaleUp);
    $('#tsDownBtn')?.addEventListener('click', tailscaleDown);
    loadTailscale();
    loadUsers(); loadChannels(); loadVoiceVision();
    loadCapabilities(); loadFiles(); loadIntegrations(); loadSystem(); loadApps();
  }

  // ── Access: live Tailscale status + connect/disconnect ──
  async function loadTailscale(){
    const state=$('#tsState'), urlRow=$('#tsUrlRow'), conn=$('#tsConnect'),
          help=$('#tsHelp'), down=$('#tsDownBtn'), a=$('#setPublicUrl');
    let s={};
    try { s = await (await fetch('/v1/tailscale/status',{credentials:'same-origin'})).json(); } catch {}
    // Fall back to the advertised public_url if status isn't available.
    if(!s || s.available===false){
      try { const info=await (await fetch('/v1/info',{credentials:'same-origin'})).json();
        if(info.public_url){ s={available:true,running:true,serving:true,url:info.public_url}; } } catch {}
    }
    const connected = !!(s && s.running);
    if(connected){
      state.textContent = s.serving ? `Connected${s.account?' · '+s.account:''}` : 'Connected (UI not exposed yet)';
      state.className='set-muted small ok-text';
      if(s.url){ a.textContent=s.url; a.href=s.url; urlRow.style.display=''; } else urlRow.style.display='none';
      conn.style.display='none'; help.style.display='none'; down.style.display='';
    } else {
      state.textContent = (s && s.available===false) ? 'Not available on this host' : 'Not connected';
      state.className='set-muted small';
      urlRow.style.display='none'; down.style.display='none';
      conn.style.display = (s && s.available===false) ? 'none' : 'flex';
      help.style.display = (s && s.available===false) ? 'none' : 'block';
    }
  }
  async function tailscaleUp(){
    const key=($('#tsAuthKey').value||'').trim(); const msg=$('#tsMsg');
    if(!key){ msg.textContent='Paste an auth key first.'; return; }
    msg.textContent='Connecting…'; $('#tsUpBtn').disabled=true;
    try {
      const r=await (await fetch('/v1/tailscale/up',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({authKey:key})})).json();
      msg.textContent=r.message||(r.ok?'Connected':'Failed'); $('#tsAuthKey').value='';
    } catch(e){ msg.textContent='Error: '+e.message; }
    $('#tsUpBtn').disabled=false; loadTailscale();
  }
  async function tailscaleDown(){
    if(!confirm('Disconnect this orb from Tailscale? It will no longer be reachable over your tailnet.')) return;
    const msg=$('#tsMsg'); msg.textContent='Disconnecting…';
    try { const r=await (await fetch('/v1/tailscale/down',{method:'POST',credentials:'same-origin'})).json(); msg.textContent=r.message||'Done'; }
    catch(e){ msg.textContent='Error: '+e.message; }
    loadTailscale();
  }
  // ── Apps: searchable widget registry (on/off + setup status) ──
  function appCard(w){
    const search=(w.name+' '+w.desc+' '+w.category+' '+w.id).toLowerCase();
    const needsSetup = !w.configured && w.setup!=='none';
    const action = needsSetup
      ? `<button class="app-setup" data-id="${esc(w.id)}">Set up</button>`
      : `<button class="app-toggle${w.enabled?' on':''}" data-id="${esc(w.id)}" aria-label="Toggle ${esc(w.name)}"><span class="knob"></span></button>`;
    return `<div class="app-card${needsSetup?' dim':''}" data-search="${esc(search)}">
      <div class="app-ic">${esc(w.icon||'▢')}</div>
      <div class="app-meta"><div class="app-name">${esc(w.name)} <span class="app-cat">${esc(w.category)}</span></div>
        <div class="app-desc">${esc(needsSetup ? (w.note||w.desc) : w.desc)}</div></div>
      ${action}
    </div>`;
  }
  async function loadAppsRegistry(){
    const grid=$('#appsGrid'); if(!grid) return;
    let widgets=[];
    try{ widgets=(await (await fetch('/v1/widgets/registry',{credentials:'same-origin'})).json()).widgets||[]; }catch{}
    if(!widgets.length){ grid.innerHTML='<div class="set-muted">Could not load widgets.</div>'; return; }
    grid.innerHTML = widgets.map(appCard).join('');
    grid.querySelectorAll('.app-toggle').forEach(btn=>{ btn.onclick=async()=>{
      const id=btn.dataset.id, on=!btn.classList.contains('on'); btn.classList.toggle('on',on);
      try{ await fetch('/v1/widgets/toggle',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({id,enabled:on})}); }
      catch{ btn.classList.toggle('on',!on); toast('Failed'); } }; });
    grid.querySelectorAll('.app-setup').forEach(btn=>{ btn.onclick=()=>{
      const c=$('.apps-conn'); if(c){ c.open=true; c.scrollIntoView({behavior:'smooth',block:'start'}); } }; });
    const sb=$('#appsSearch'); if(sb && !sb.dataset.wired){ sb.dataset.wired='1'; sb.oninput=()=>{
      const q=sb.value.toLowerCase().trim();
      grid.querySelectorAll('.app-card').forEach(c=>{ c.style.display=(!q||c.dataset.search.includes(q))?'':'none'; }); }; }
    const aw=$('#addWidget'); if(aw && !aw.dataset.wired){ aw.dataset.wired='1';
      aw.onclick=()=>toast('Custom widgets: drop a plugin in /workspace/.widgets — developer docs coming.'); }
  }

  async function loadApps(){
    loadAppsRegistry();
    let s = {};
    try{ s = (await (await fetch('/v1/settings',{credentials:'same-origin'})).json()).settings || {}; }catch{}
    const set = (dot, state, on, label) => { const d=$(dot), t=$(state); if(d) d.className='pill-dot '+(on?'ok':''); if(t) t.textContent = on?('connected'+(label?' · '+label:'')):'not connected'; };
    set('#ytDot','#ytState', !!s.RAK00N_YOUTUBE_API_KEY);
    set('#spDot','#spState', !!s.RAK00N_SPOTIFY_CLIENT_ID && !!s.RAK00N_SPOTIFY_CLIENT_SECRET);
    set('#nwDot','#nwState', !!s.RAK00N_NEWSAPI_KEY);
    set('#vcDot','#vcState', !!s.RAK00N_VERCEL_TOKEN, 'publishes to vercel.app');
    const put = async (body, ok) => { try{ const r=await fetch('/v1/settings',{method:'PUT',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify(body)}); toast(r.ok?ok:'Failed'); if(r.ok) setTimeout(loadApps,300); }catch{ toast('Failed'); } };
    const yt=$('#ytSave'); if(yt && !yt.dataset.w){ yt.dataset.w='1'; yt.onclick=()=>{ const k=$('#ytKey').value.trim(); if(k){ put({RAK00N_YOUTUBE_API_KEY:k},'YouTube connected'); $('#ytKey').value=''; } }; }
    const sp=$('#spSave'); if(sp && !sp.dataset.w){ sp.dataset.w='1'; sp.onclick=()=>{ const id=$('#spId').value.trim(), sec=$('#spSecret').value.trim(); if(id&&sec){ put({RAK00N_SPOTIFY_CLIENT_ID:id,RAK00N_SPOTIFY_CLIENT_SECRET:sec},'Spotify connected'); $('#spId').value=''; $('#spSecret').value=''; } }; }
    const nw=$('#nwSave'); if(nw && !nw.dataset.w){ nw.dataset.w='1'; nw.onclick=()=>{ const k=$('#nwKey').value.trim(); if(k){ put({RAK00N_NEWSAPI_KEY:k},'News connected'); $('#nwKey').value=''; } }; }
    const vc=$('#vcSave'); if(vc && !vc.dataset.w){ vc.dataset.w='1'; vc.onclick=()=>{ const t=$('#vcToken').value.trim(); if(t){ put(Object.assign({RAK00N_VERCEL_TOKEN:t}, $('#vcTeam').value.trim()?{RAK00N_VERCEL_TEAM_ID:$('#vcTeam').value.trim()}:{}),'Vercel connected'); $('#vcToken').value=''; } }; }
    // Spotify account OAuth status + connect/disconnect.
    try{
      const st = await (await fetch('/v1/oauth/spotify/status',{credentials:'same-origin'})).json();
      const acct=$('#spAcct'), conn=$('#spConnect'), disc=$('#spDisconnect'), redir=$('#spRedirect');
      if(acct) acct.textContent = st.connected ? '✓ account connected' : (st.configured ? 'not connected' : 'save Client ID/Secret + set a public URL first');
      if(conn) conn.style.display = st.connected ? 'none' : (st.configured ? '' : 'none');
      if(disc) disc.style.display = st.connected ? '' : 'none';
      if(redir && st.redirect_uri) redir.textContent = 'Add this Redirect URI to your Spotify app: ' + st.redirect_uri;
      if(conn && !conn.dataset.w){ conn.dataset.w='1'; conn.onclick=async()=>{ try{ const d=await (await fetch('/v1/oauth/spotify/start',{credentials:'same-origin'})).json(); if(d.url) location.href=d.url; else toast(d.error||'Configure Spotify first'); }catch{ toast('Failed'); } }; }
      if(disc && !disc.dataset.w){ disc.dataset.w='1'; disc.onclick=async()=>{ await fetch('/v1/oauth/spotify/disconnect',{method:'POST',credentials:'same-origin'}); toast('Disconnected'); loadApps(); }; }
    }catch{}
    // Cloud Storage (Google Drive + OneDrive): save client creds + OAuth.
    const gdSave=$('#gdSave'); if(gdSave && !gdSave.dataset.w){ gdSave.dataset.w='1'; gdSave.onclick=()=>{ const id=$('#gdId').value.trim(), sec=$('#gdSecret').value.trim(); if(id){ put(Object.assign({RAK00N_GOOGLE_CLIENT_ID:id}, sec?{RAK00N_GOOGLE_CLIENT_SECRET:sec}:{}),'Google saved'); $('#gdId').value=''; $('#gdSecret').value=''; } }; }
    const odSave=$('#odSave'); if(odSave && !odSave.dataset.w){ odSave.dataset.w='1'; odSave.onclick=()=>{ const id=$('#odId').value.trim(), sec=$('#odSecret').value.trim(); if(id){ put(Object.assign({RAK00N_MS_CLIENT_ID:id}, sec?{RAK00N_MS_CLIENT_SECRET:sec}:{}),'Microsoft saved'); $('#odId').value=''; $('#odSecret').value=''; } }; }
    try{
      const cs = await (await fetch('/v1/oauth/cloud/status',{credentials:'same-origin'})).json();
      const anyConn = !!(cs.google&&cs.google.connected) || !!(cs.microsoft&&cs.microsoft.connected);
      set('#csDot','#csState', anyConn);
      const wire=(p,dotSel,acctSel,connSel,discSel,redirSel,devSel,codeSel)=>{
        const st=cs[p]||{}; const acct=$(acctSel),conn=$(connSel),disc=$(discSel),redir=$(redirSel),dot=$(dotSel),dev=$(devSel),code=$(codeSel);
        if(dot) dot.className='pill-dot '+(st.connected?'ok':'');
        if(acct) acct.textContent = st.connected?'✓ connected':(st.device?'not connected':'add a client ID first');
        if(conn) conn.style.display = st.connected?'none':(st.configured?'':'none');
        if(dev) dev.style.display = st.connected?'none':(st.device?'':'none');
        if(disc) disc.style.display = st.connected?'':'none';
        if(redir && st.redirect_uri) redir.textContent='Redirect URI: '+st.redirect_uri;
        if(conn && !conn.dataset.w){ conn.dataset.w='1'; conn.onclick=async()=>{ try{ const d=await (await fetch('/v1/oauth/cloud/'+p+'/start',{credentials:'same-origin'})).json(); if(d.url) location.href=d.url; else toast(d.error||'Configure first'); }catch{ toast('Failed'); } }; }
        if(disc && !disc.dataset.w){ disc.dataset.w='1'; disc.onclick=async()=>{ await fetch('/v1/oauth/cloud/'+p+'/disconnect',{method:'POST',credentials:'same-origin'}); toast('Disconnected'); loadApps(); }; }
        // device-code flow: start → show code/url → poll until connected
        if(dev && !dev.dataset.w){ dev.dataset.w='1'; dev.onclick=async()=>{
          try{
            const d=await (await fetch('/v1/oauth/cloud/'+p+'/device/start',{method:'POST',credentials:'same-origin'})).json();
            if(d.error||!d.user_code){ toast(d.error||'Could not start'); return; }
            if(code){ code.style.display='block'; code.innerHTML=`Go to <a href="${d.verification_url}" target="_blank" rel="noopener">${d.verification_url}</a> and enter:<div class="dev-code-big">${d.user_code}</div><span class="set-muted small">Waiting for approval…</span>`; }
            const iv=Math.max(2,(d.interval||5))*1000; const until=Date.now()+(d.expires_in||600)*1000;
            const poll=async()=>{
              if(Date.now()>until){ if(code) code.innerHTML='<span class="set-muted small">Code expired — try again.</span>'; return; }
              try{ const r=await (await fetch('/v1/oauth/cloud/'+p+'/device/poll',{method:'POST',credentials:'same-origin'})).json();
                if(r.status==='connected'){ if(code) code.style.display='none'; toast((p==='google'?'Google':'Microsoft')+' connected'); loadApps(); return; }
                if(r.status==='expired'){ if(code) code.innerHTML='<span class="set-muted small">Code expired — try again.</span>'; return; }
                if(r.status==='error'){ if(code) code.innerHTML='<span class="set-muted small">'+(r.error||'Connection failed')+'</span>'; return; }
              }catch{}
              setTimeout(poll, iv);
            };
            setTimeout(poll, iv);
          }catch{ toast('Failed'); }
        }; }
      };
      wire('google','#gdDot','#gdAcct','#gdConnect','#gdDisconnect','#gdRedirect','#gdDevice','#gdCode');
      wire('microsoft','#odDot','#odAcct','#odConnect','#odDisconnect','#odRedirect','#odDevice','#odCode');
    }catch{}
  }
  function fmtBytes(n){ n=Number(n)||0; if(n<1024)return n+' B'; if(n<1048576)return (n/1024).toFixed(1)+' KB'; return (n/1048576).toFixed(1)+' MB'; }
  function sysRow(k,v,ok){ return `<div class="set-item"><span class="pill-dot ${ok?'ok':'err'}"></span><div class="grow"><div class="t">${esc(k)}</div></div><code>${esc(v)}</code></div>`; }
  function capRow(name,desc){ return `<div class="set-item"><div class="grow"><div class="t">${esc(name)}</div>${desc?`<div class="s">${esc(String(desc).slice(0,130))}</div>`:''}</div></div>`; }

  async function loadCapabilities(){
    try{ const d=await (await fetch('/v1/tools',{credentials:'same-origin'})).json(); const ts=(d.tools||[]).filter(t=>t&&t.name);
      $('#setTools').innerHTML = ts.length ? ts.map(t=>capRow(t.name, t.description)).join('') : '<div class="set-muted">None.</div>';
    }catch{ $('#setTools').innerHTML='<div class="set-muted">Failed to load.</div>'; }
    try{ const d=await (await fetch('/v1/skills',{credentials:'same-origin'})).json(); const sk=d.skills||[];
      $('#setSkills').innerHTML = sk.length ? sk.map(s=>capRow(s.name, s.description)).join('') : '<div class="set-muted">No skills enabled.</div>';
    }catch{ $('#setSkills').innerHTML='<div class="set-muted">Failed to load.</div>'; }
  }
  async function loadFiles(){
    try{ const d=await (await fetch('/v1/files/all',{credentials:'same-origin'})).json(); const fs=d.files||[];
      $('#setFilesSummary').textContent = `${d.total_files||0} file(s) · ${fmtBytes(d.total_bytes)}`;
      if(!fs.length){ $('#setFiles').innerHTML='<div class="set-muted">No files yet. Drop files into the chat to share them.</div>'; return; }
      $('#setFiles').innerHTML='';
      fs.forEach(f=>{ const it=document.createElement('div'); it.className='set-item';
        it.innerHTML=`<div class="grow"><div class="t">${esc(f.name||f.id)}</div><div class="s">${fmtBytes(f.size)}${f.content_type?' · '+esc(f.content_type):''}</div></div>`;
        const del=document.createElement('button'); del.className='set-btn danger'; del.textContent='Delete';
        del.onclick=async()=>{ if(!confirm('Delete '+(f.name||f.id)+'?'))return; await fetch(`/v1/files/${encodeURIComponent(f.id)}?session_id=${encodeURIComponent(f.session_id||'')}`,{method:'DELETE',credentials:'same-origin'}); loadFiles(); };
        it.appendChild(del); $('#setFiles').appendChild(it);
      });
    }catch{ $('#setFiles').innerHTML='<div class="set-muted">Failed to load.</div>'; }
  }
  async function loadIntegrations(){
    try{ const d=await (await fetch('/v1/mcps',{credentials:'same-origin'})).json();
      const list = Array.isArray(d) ? d : (d.servers || d.mcps || []);
      if(!list.length){ $('#setMcps').innerHTML='<div class="set-muted">No MCP servers configured.</div>'; return; }
      $('#setMcps').innerHTML='';
      list.forEach(m=>{ const it=document.createElement('div'); it.className='set-item';
        const ok = m.status==='ok'||m.connected||m.healthy;
        it.innerHTML=`<span class="pill-dot ${ok?'ok':''}"></span><div class="grow"><div class="t">${esc(m.name||'mcp')}</div><div class="s">${esc(m.url||m.transport||'')}</div></div>`;
        const del=document.createElement('button'); del.className='set-btn danger'; del.textContent='Remove';
        del.onclick=async()=>{ if(!confirm('Remove '+(m.name)+'?'))return; await fetch(`/v1/mcps/${encodeURIComponent(m.name)}`,{method:'DELETE',credentials:'same-origin'}); loadIntegrations(); };
        it.appendChild(del); $('#setMcps').appendChild(it);
      });
    }catch{ $('#setMcps').innerHTML='<div class="set-muted">Failed to load.</div>'; }
  }
  async function addMcp(){
    const name=$('#setMcpName').value.trim(), url=$('#setMcpUrl').value.trim(), msg=$('#setMcpMsg');
    if(!name||!url){ msg.textContent='Name and URL required.'; return; } msg.textContent='Adding…';
    try{ const r=await fetch('/v1/mcps',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({name,url})});
      if(r.ok){ msg.textContent='Added.'; $('#setMcpName').value=$('#setMcpUrl').value=''; loadIntegrations(); } else msg.textContent='Failed.';
    }catch{ msg.textContent='Failed.'; }
  }
  async function loadSystem(){
    const list=$('#setSystem'); list.innerHTML='';
    // Model selector — choose the active brain (applies to chat + voice).
    try{
      const m=await (await fetch('/v1/models',{credentials:'same-origin'})).json();
      const models=m.models||[]; const cur=m.default_model||(models[0]&&models[0].id);
      const row=document.createElement('div'); row.className='set-item';
      row.innerHTML=`<div class="grow"><div class="t">Model (brain)</div><div class="s">used by chat &amp; voice</div></div>`;
      const sel=document.createElement('select'); sel.className='set-select';
      sel.innerHTML = models.map(x=>`<option value="${esc(x.id)}"${x.id===cur?' selected':''}>${esc(x.label||x.id)}${x.status&&x.status!=='available'?' ('+esc(x.status)+')':''}</option>`).join('') || `<option>${esc(cur||'—')}</option>`;
      sel.onchange=async()=>{ try{ await fetch('/v1/settings',{method:'PUT',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({OPENAI_MODEL:sel.value})}); toast('Model → '+sel.value); }catch{ toast('Failed'); } };
      row.appendChild(sel); list.appendChild(row);
    }catch{}
    // Essential status only (version/auth/voice clutter removed).
    const items=[];
    let s={}; try{ s=(await (await fetch('/v1/settings',{credentials:'same-origin'})).json()).settings||{}; }catch{}
    try{ const info=await (await fetch('/v1/info',{credentials:'same-origin'})).json();
      items.push(sysRow('Brain endpoint', (info.llm?.endpoint||'—').replace(/^https?:\/\//,''), !!info.llm?.endpoint));
    }catch{}
    try{ const rz=await (await fetch('/readyz')).json(); items.push(sysRow('Redis', rz.redis?'ok':'down', !!rz.redis)); }catch{}
    list.insertAdjacentHTML('beforeend', items.join(''));

    renderBrainCfg(s);
    // Audit loads lazily when its disclosure is opened.
    const ad=$('#auditDisc'); if(ad && !ad.dataset.wired){ ad.dataset.wired='1'; ad.addEventListener('toggle',()=>{ if(ad.open) loadAudit(); }); }
  }
  function renderBrainCfg(s){
    const el=$('#setBrainCfg'); if(!el)return;
    const base=s.OPENAI_BASE_URL||'';
    const isLocal = !base || /vllm|127\.0\.0\.1|localhost/.test(base);
    el.innerHTML = `<p class="set-muted small">Can't run the model on this box? Point the brain at a cloud <strong>OpenAI-compatible</strong> endpoint (OpenAI, OpenRouter, Together, Groq…). Endpoint &amp; key changes take effect after a restart.</p>`+
      `<div class="set-form"><input id="brEndpoint" type="text" placeholder="https://api.openai.com/v1" value="${esc(isLocal?'':base)}" style="flex:2;" /></div>`+
      `<div class="set-form"><input id="brModel" type="text" placeholder="model id (e.g. gpt-4o)" value="${esc(s.OPENAI_MODEL||'')}" /><input id="brKey" type="password" placeholder="API key" autocomplete="off" /></div>`+
      `<div class="set-row" style="margin-top:8px;"><button id="brSave" class="set-btn">Use cloud brain</button><button id="brLocal" class="set-btn ghost">Reset to local</button></div>`+
      // ── Smart routing (cost optimizer) ──
      `<div style="border-top:1px solid var(--line);margin:16px 0 0;padding-top:12px;">`+
      `<div class="set-row"><div class="info-label" style="color:var(--ink);">Smart routing</div>`+
      `<button id="rtToggle" class="set-switch${s.RAK00N_ROUTER_ENABLED==='1'?' on':''}" aria-label="Toggle routing"><span class="knob"></span></button></div>`+
      `<p class="set-muted small">Keep the default model (local Qwen) for everyday turns, and automatically send <strong>coding &amp; hard reasoning</strong> to a stronger cloud model — optimizing quality vs cost. Voice stays local. Uses <strong>OpenRouter</strong> (one key → GPT &amp; Claude).</p>`+
      `<div class="set-form"><input id="rtKey" type="password" placeholder="OpenRouter API key (sk-or-…)" autocomplete="off" style="flex:2;" /><input id="rtModel" type="text" placeholder="strong model" value="${esc(s.RAK00N_ROUTER_STRONG_MODEL||'openai/gpt-4o')}" /></div>`+
      `<div class="set-row" style="margin-top:8px;"><button id="rtSave" class="set-btn">Save routing</button><span class="set-muted small" id="rtState">${s.RAK00N_OPENROUTER_KEY?'key set':'no key yet'}</span></div></div>`;
    $('#brSave').onclick=async()=>{ const body={}; const e=$('#brEndpoint').value.trim(),m=$('#brModel').value.trim(),k=$('#brKey').value.trim();
      if(e)body.OPENAI_BASE_URL=e; if(m)body.OPENAI_MODEL=m; if(k)body.OPENAI_API_KEY=k;
      if(!Object.keys(body).length){ toast('Enter an endpoint'); return; }
      try{ await fetch('/v1/settings',{method:'PUT',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify(body)}); toast('Saved — restart to apply the endpoint'); }catch{ toast('Failed'); } };
    $('#brLocal').onclick=async()=>{ try{ await fetch('/v1/settings',{method:'PUT',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({OPENAI_BASE_URL:'http://vllm:8888/v1'})}); toast('Reset to local — restart to apply'); renderBrainCfg({OPENAI_BASE_URL:'http://vllm:8888/v1',OPENAI_MODEL:s.OPENAI_MODEL}); }catch{ toast('Failed'); } };
    $('#rtToggle').onclick=async()=>{ const on=!$('#rtToggle').classList.contains('on'); $('#rtToggle').classList.toggle('on',on);
      try{ await fetch('/v1/settings',{method:'PUT',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({RAK00N_ROUTER_ENABLED:on?'1':'0'})}); toast(on?'Smart routing on':'Smart routing off'); }catch{ toast('Failed'); } };
    $('#rtSave').onclick=async()=>{ const body={}; const k=$('#rtKey').value.trim(),m=$('#rtModel').value.trim();
      if(k)body.RAK00N_OPENROUTER_KEY=k; if(m)body.RAK00N_ROUTER_STRONG_MODEL=m;
      if(!Object.keys(body).length){ toast('Enter your OpenRouter key'); return; }
      try{ await fetch('/v1/settings',{method:'PUT',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify(body)}); $('#rtKey').value=''; $('#rtState').textContent='key set'; toast('Routing saved'); }catch{ toast('Failed'); } };
  }
  async function loadAudit(){
    const el=$('#setAudit'); if(!el)return; el.innerHTML='<div class="set-muted">Loading…</div>';
    try{ const d=await (await fetch('/v1/audit?limit=60',{credentials:'same-origin'})).json(); const ev=d.events||[];
      el.innerHTML = ev.length ? ev.slice().reverse().map(e=>{
        const t=e.ts?new Date(e.ts).toLocaleString():''; const who=e.oid||e.keyId||'';
        return `<div class="set-item"><div class="grow"><div class="t">${esc(e.event||'event')}</div><div class="s">${esc(t)}${who?' · '+esc(who):''}</div></div></div>`;
      }).join('') : '<div class="set-muted">No recent events.</div>';
    }catch{ el.innerHTML='<div class="set-muted">Audit unavailable (owner only).</div>'; }
  }
  async function loadUsers(){
    const list=$('#setUsersList');
    try{ const d=await (await fetch('/v1/auth/users',{credentials:'same-origin'})).json(); const us=d.users||[];
      if(!us.length){ list.innerHTML='<div class="set-muted">No users yet.</div>'; return; }
      list.innerHTML='';
      us.forEach(u=>{ const it=document.createElement('div'); it.className='set-item';
        it.innerHTML=`<div class="grow"><div class="t">${esc(u.email)}${u.label?` · <span class="set-muted">${esc(u.label)}</span>`:''}</div><div class="s">${u.telegram_chat_id?'Telegram: '+esc(u.telegram_chat_id):'email only'}</div></div>`;
        const del=document.createElement('button'); del.className='set-btn danger'; del.textContent='Remove';
        del.onclick=async()=>{ if(!confirm('Remove '+u.email+'?'))return; await fetch('/v1/auth/users',{method:'DELETE',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({email:u.email})}); loadUsers(); };
        it.appendChild(del); list.appendChild(it);
      });
    }catch{ list.innerHTML='<div class="set-muted">Failed to load.</div>'; }
  }
  async function addUser(){
    const email=$('#setUserEmail').value.trim(), tg=$('#setUserTg').value.trim(), label=$('#setUserLabel').value.trim(), msg=$('#setUserMsg');
    if(!email){ msg.textContent='Email required.'; return; } msg.textContent='Saving…';
    const r=await fetch('/v1/auth/users',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({email,telegram_chat_id:tg,label})});
    if(r.ok){ msg.textContent='Saved.'; $('#setUserEmail').value=$('#setUserTg').value=$('#setUserLabel').value=''; loadUsers(); } else msg.textContent='Failed.';
  }
  let waPoll = null;
  async function loadChannels(){
    const list=$('#setChannels'); list.innerHTML='';
    let s={}; try{ s=(await (await fetch('/v1/settings',{credentials:'same-origin'})).json()).settings||{}; }catch{}

    // ── Telegram — configurable in the UI ──
    const tgOn=!!s.RAK00N_TELEGRAM_BOT_TOKEN;
    const tg=document.createElement('div'); tg.className='set-card';
    tg.innerHTML=`<div class="set-row"><span class="pill-dot ${tgOn?'ok':''}"></span><div class="info-label" style="color:var(--ink);">Telegram</div><span class="set-muted small">${tgOn?'configured':'not configured'}</span></div>`+
      `<p class="set-muted small">Make a bot with <strong>@BotFather</strong> and paste its token. Owner chat id (optional) restricts who it answers.</p>`+
      `<div class="set-form"><input id="tgToken" type="password" placeholder="Bot token" autocomplete="off" style="flex:2;" /><input id="tgOwner" type="text" inputmode="numeric" placeholder="Owner chat id (optional)" /><button id="tgSave" class="set-btn">Save</button></div>`;
    list.appendChild(tg);
    $('#tgSave').onclick=async()=>{ const body={}; const t=$('#tgToken').value.trim(), o=$('#tgOwner').value.trim();
      if(t)body.RAK00N_TELEGRAM_BOT_TOKEN=t; if(o)body.RAK00N_TELEGRAM_OWNER_ID=o;
      if(!Object.keys(body).length){ toast('Enter a bot token'); return; }
      try{ await fetch('/v1/settings',{method:'PUT',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify(body)}); toast('Telegram saved'); loadChannels(); }catch{ toast('Failed'); } };

    // ── WhatsApp — link card with live QR (auto-shown when not linked) ──
    const wa=document.createElement('div'); wa.className='set-card';
    wa.innerHTML=`<div class="set-row"><span class="pill-dot" id="waDot"></span><div class="info-label" style="color:var(--ink);">WhatsApp</div><span class="set-muted small" id="waState">checking…</span></div>`+
      `<p class="set-muted small">On your phone: WhatsApp ▸ Linked devices ▸ Link a device, then scan:</p>`+
      `<div id="waQrWrap" style="display:none;"><img id="waQr" alt="WhatsApp QR" style="width:200px;border-radius:12px;background:#fff;padding:8px;display:block;"/></div>`+
      `<div class="set-row" style="margin-top:8px;"><button class="set-btn ghost" id="waLink">Show QR</button></div>`;
    list.appendChild(wa);
    const startWa=()=>{ $('#waQrWrap').style.display='block'; $('#waLink').textContent='Refreshing…'; bumpWaQr(); if(waPoll)clearInterval(waPoll); waPoll=setInterval(()=>{ bumpWaQr(); refreshWa(); },4000); };
    $('#waLink').addEventListener('click', startWa);
    refreshWa(startWa);
  }
  function bumpWaQr(){ const i=$('#waQr'); if(i) i.src='/v1/whatsapp/qr?t='+Date.now(); }
  async function refreshWa(autoShow){
    try{ const d=await (await fetch('/v1/whatsapp/status',{credentials:'same-origin'})).json();
      const dot=$('#waDot'), st=$('#waState'), link=$('#waLink'); if(!dot)return;
      if(d.connected){ dot.className='pill-dot ok'; st.textContent='linked'+(d.me?` · ${d.me}`:''); if(link)link.style.display='none'; const w=$('#waQrWrap'); if(w)w.style.display='none'; if(waPoll){clearInterval(waPoll);waPoll=null;} }
      else { dot.className='pill-dot err'; st.textContent=d.enabled?'not linked':'bridge offline'; if(link){link.style.display=''; if(!waPoll)link.textContent='Show QR';}
        // When the bridge is up but unlinked, surface the QR right away.
        if(d.enabled && !waPoll && typeof autoShow==='function') autoShow();
      }
    }catch{}
  }
  async function loadVoiceVision(){
    const list=$('#setVoice'); list.innerHTML='';
    let s={};
    try{ const r=await (await fetch('/v1/settings',{credentials:'same-origin'})).json(); s=r.settings||{}; }catch{}
    const enabled=s.RAK00N_VOICE_ENABLED||'1';
    const curVoice=s.RAK00N_TTS_VOICE||'tara';

    // Voice enabled toggle
    const row=document.createElement('div'); row.className='set-item';
    row.innerHTML=`<div class="grow"><div class="t">Voice enabled</div><div class="s">the orb can listen &amp; speak</div></div>`;
    const sw=document.createElement('button'); sw.className='set-switch'+(enabled==='1'?' on':''); sw.setAttribute('aria-label','Toggle voice'); sw.innerHTML='<span class="knob"></span>';
    sw.onclick=async()=>{ const on=!sw.classList.contains('on'); sw.classList.toggle('on',on);
      try{ await fetch('/v1/settings',{method:'PUT',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({RAK00N_VOICE_ENABLED:on?'1':'0'})}); toast(on?'Voice enabled':'Voice disabled'); }catch{ toast('Failed'); } };
    row.appendChild(sw); list.appendChild(row);

    // Voice selection (Orpheus expressive voices)
    const VOICES=[['tara','Tara — warm (default)'],['leah','Leah'],['jess','Jess'],['mia','Mia'],['zoe','Zoe'],['leo','Leo'],['dan','Dan'],['zac','Zac']];
    const vrow=document.createElement('div'); vrow.className='set-item';
    vrow.innerHTML=`<div class="grow"><div class="t">Voice</div><div class="s">how the orb sounds</div></div>`;
    const sel=document.createElement('select'); sel.className='set-select';
    for(const [v,label] of VOICES){ const o=document.createElement('option'); o.value=v; o.textContent=label; if(v===curVoice)o.selected=true; sel.appendChild(o); }
    sel.onchange=async()=>{ try{ await fetch('/v1/settings',{method:'PUT',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({RAK00N_TTS_VOICE:sel.value})}); toast('Voice set to '+sel.value); }catch{ toast('Failed'); } };
    vrow.appendChild(sel); list.appendChild(vrow);

    try{ const v=await (await fetch('/v1/voice/status')).json();
      list.insertAdjacentHTML('beforeend', chRow('Speech-to-text', v.stt||'faster-whisper', !!v.ready));
      list.insertAdjacentHTML('beforeend', chRow('Text-to-speech', v.tts||'Orpheus (expressive)', !!v.ready));
    }catch{}
    // Vision is handled by the multimodal model itself now (not moondream2).
    list.insertAdjacentHTML('beforeend', chRow('Vision','the model · camera frames', true));
  }

  // ════════════════════════════════════════════════════════════════════════
  //  status + boot
  // ════════════════════════════════════════════════════════════════════════
  let toastT=null;
  function toast(t){ const el=$('#toast'); el.textContent=t; el.classList.add('show'); clearTimeout(toastT); toastT=setTimeout(()=>el.classList.remove('show'),3200); }
  async function checkVoice(){
    try {
      const d = await (await fetch('/v1/voice/status')).json();
      if (!d.available) { audioToggle.classList.add('hidden'); return; }
      audioToggle.classList.remove('hidden'); setAudioChip('offline');
      // Always-on: if mic permission was already granted, wake the orb's
      // voice automatically (no gesture needed once permission persists).
      try {
        const perm = navigator.permissions && await navigator.permissions.query({ name: 'microphone' });
        if (perm && perm.state === 'granted') startVoice();
      } catch { /* permissions API unsupported → user taps "Go live" */ }
    } catch { audioToggle.classList.add('hidden'); }
  }
  async function live(){ try{ const d=await (await fetch('/v1/status')).json();
    const stale=!d.last_heartbeat_at||(Date.now()-new Date(d.last_heartbeat_at).getTime())>90000;
    $('#liveDot').className='status-dot '+(stale?'err':'ok'); }catch{ $('#liveDot').className='status-dot err'; } }
  async function model(){ try{ const d=await (await fetch('/v1/info')).json(); if(d.model)$('#brandModel').textContent=d.model; }catch{} }

  placeOrb(); checkVoice(); live(); model(); loadPlugins(); setInterval(live, 30000);

  // ── Spotify: OAuth redirect feedback + Web Playback SDK (orb = a device) ──
  if (/[?&]spotify=connected/.test(location.search)) { toast('Spotify account connected'); history.replaceState({}, '', location.pathname); }
  else if (/[?&]spotify=error/.test(location.search)) { toast('Spotify connection failed'); history.replaceState({}, '', location.pathname); }
  { const m=/[?&]cloud=(google|microsoft|error)/.exec(location.search); if(m){ toast(m[1]==='error'?'Cloud connection failed':(m[1]==='google'?'Google Drive connected':'OneDrive connected')); history.replaceState({}, '', location.pathname); } }
  let spReady = false;
  window.onSpotifyWebPlaybackSDKReady = () => {
    if (spReady) return; spReady = true;
    fetch('/v1/oauth/spotify/token', { credentials:'same-origin' }).then(r=>r.ok?r.json():null).then(d=>{
      if (!d || !d.token || typeof Spotify === 'undefined') return;
      const player = new Spotify.Player({
        name: 'rak00n',
        getOAuthToken: cb => { fetch('/v1/oauth/spotify/token',{credentials:'same-origin'}).then(r=>r.json()).then(x=>cb(x.token)).catch(()=>{}); },
        volume: 0.6,
      });
      player.addListener('ready', ({ device_id }) => { window.__rakSpotifyDevice = device_id; });
      player.addListener('initialization_error', () => {});
      player.addListener('authentication_error', () => {});
      player.connect();
    }).catch(()=>{});
  };
})();
