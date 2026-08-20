/* ============================================================================
   orb2 orb shell — the orb is the agent; the page is its surface.
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
    who.textContent = role==='user'?'you':role==='assistant'?'orb2':role;
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
            // Provenance (v0.2 §8) is deliberately NOT shown per message —
            // it lives as the aggregate "Answers by tier" row in Settings.
            // (Server still counts tiers; d.provenance is available here
            // if a debug surface ever wants it.)
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
      toast('Camera on — orb2 can see');
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
    // Control events from the agent (not widgets): open the Settings panel.
    if(spec.type==='ui-settings'){
      try{ openSettings(); if(spec.section){
        // Old section names keep working after the IA merge.
        const alias={ access:'system', files:'system', integrations:'channels' };
        const sec=alias[spec.section]||spec.section;
        const b=document.querySelector(`.set-navi[data-sec="${CSS.escape(sec)}"]`); if(b) b.click(); } }catch{}
      return;
    }
    // Update in place if a widget with this id already exists (the agent
    // re-emits the same id to "update the widget", not make a new one).
    if(spec.id && widgets.has(spec.id)){
      if(pinnedIds.has(String(spec.id)) && !spec.pending){
        fetch('/v1/pins/'+encodeURIComponent(spec.id),{method:'PUT',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({spec})}).catch(()=>{});
      }
      const ex = widgets.get(spec.id);
      const ttl = ex.querySelector('.wg-title'); if(ttl){ ttl.textContent = spec.title || titleFor(spec); ttl.title = ttl.textContent; }
      if(ex._chart){ try{ ex._chart.destroy(); }catch{} ex._chart=null; }
      if(ex._map){ try{ ex._map.remove(); }catch{} ex._map=null; }
      if(ex._mapRo){ try{ ex._mapRo.disconnect(); }catch{} ex._mapRo=null; }
      const exBody = ex.querySelector('.wg-body'); exBody.innerHTML='';
      try { renderWidget(exBody, spec, ex); } catch(e){ exBody.textContent='widget render error'; }
      ex._spec=spec; bringIntoView(ex);
      return ex;
    }
    const wg = document.createElement('div'); wg.className='wg';
    const wid = spec.id || ('w-'+Date.now().toString(36)+(wgCount));
    wg.dataset.wid = wid;
    const fill = spec.type==='app' || spec.type==='embed' || (spec.type==='html' && !!(spec.url||spec.html));
    const wide = spec.type==='video' || spec.type==='model' || fill;
    if(fill){ wg.classList.add('wg-fill'); wg.style.width='640px'; wg.style.height='460px'; }
    else if(spec.type==='video') wg.style.width='480px';
    else if(spec.type==='model'){ wg.style.width='460px'; wg.style.height='420px'; }
    else if(spec.type==='music'){ wg.style.width='400px'; wg.style.height='240px'; }
    else if(spec.type==='calculator'){ wg.style.width='280px'; wg.style.height='400px'; }
    else if(spec.type==='weather'){ wg.style.width='360px'; wg.style.maxHeight='320px'; }
    else if(spec.type==='calendar'){ wg.style.width='420px'; wg.style.height='380px'; }
    else if(spec.type==='code'){ wg.style.width='560px'; wg.style.maxHeight='420px'; }
    else if(spec.type==='mail'){ wg.style.width='440px'; wg.style.maxHeight='400px'; }
    else if(spec.type==='vercel'){ wg.style.width='420px'; wg.style.maxHeight='360px'; }
    else if(spec.type==='map'){ wg.style.width='560px'; wg.style.height='420px'; }
    else if(spec.type==='docker'){ wg.style.width='460px'; wg.style.maxHeight='400px'; }
    else if(spec.type==='chart') wg.style.height='340px';   // give charts room (resizable)
    else if(spec.type==='todo'){ wg.style.width='380px'; wg.style.maxHeight='360px'; }
    else if(spec.type==='home'){ wg.style.width='560px'; wg.style.maxHeight='480px'; }
    else if(spec.type==='document'){ wg.style.width='560px'; wg.style.maxHeight='520px'; }
    else if(spec.type==='wallet'){ wg.style.width='380px'; wg.style.maxHeight='420px'; }
    else if(spec.type==='setup'){ wg.style.width='360px'; }
    else if(spec.type==='approval'){ wg.style.width='360px'; }
    else if(spec.type==='receipts'){ wg.style.width='440px'; wg.style.maxHeight='480px'; }
    else if(spec.type==='deck'){ wg.style.width='420px'; wg.style.maxHeight='560px'; }
    else if(spec.type==='lights'){ wg.style.width='400px'; wg.style.maxHeight='460px'; }
    else if(spec.type==='media'){ wg.style.width='380px'; wg.style.maxHeight='320px'; }
    else if(spec.type==='climate'){ wg.style.width='300px'; wg.style.height='300px'; }
    else if(spec.type==='shopping'){ wg.style.width='420px'; wg.style.maxHeight='480px'; }
    else if(spec.type==='vacuum'){ wg.style.width='300px'; wg.style.height='300px'; }
    else if(spec.type==='covers'){ wg.style.width='400px'; wg.style.maxHeight='420px'; }
    else if(spec.type==='security'){ wg.style.width='400px'; wg.style.maxHeight='440px'; }
    else if(spec.type==='plugs'){ wg.style.width='460px'; wg.style.maxHeight='420px'; }
    else if(spec.type==='scenes'){ wg.style.width='360px'; wg.style.maxHeight='300px'; }
    else if(spec.type==='sensors'){ wg.style.width='420px'; wg.style.maxHeight='400px'; }
    else if(spec.type==='camera'){ wg.style.width='480px'; wg.style.height='340px'; }
    else if(spec.type==='timers'){ wg.style.width='340px'; wg.style.maxHeight='340px'; }
    else if(spec.type==='presence'){ wg.style.width='340px'; wg.style.maxHeight='260px'; }
    else if(spec.type==='energy'){ wg.style.width='360px'; wg.style.maxHeight='340px'; }
    else if(spec.type==='automations'){ wg.style.width='420px'; wg.style.maxHeight='400px'; }
    else if(spec.type==='printer3d'){ wg.style.width='480px'; wg.style.height='560px'; }
    else if(spec.type==='familyboard'){ wg.style.width='420px'; wg.style.maxHeight='440px'; }
    else if(spec.type==='briefing'){ wg.style.width='420px'; wg.style.maxHeight='460px'; }
    else if(spec.type==='housemode'){ wg.style.width='340px'; wg.style.maxHeight='240px'; }
    else if(spec.type==='document'){ wg.style.width='560px'; wg.style.maxHeight='520px'; }
    else if(spec.type==='wallet'){ wg.style.width='380px'; wg.style.maxHeight='400px'; }
    else if(spec.type==='lights'){ wg.style.width='400px'; wg.style.maxHeight='440px'; }
    else if(spec.type==='media'){ wg.style.width='360px'; wg.style.maxHeight='300px'; }
    else if(spec.type==='climate'){ wg.style.width='280px'; wg.style.height='260px'; }
    else if(_plugins[spec.type]){ const p=_plugins[spec.type]; if(p.width)wg.style.width=p.width+'px'; if(p.height)wg.style.height=p.height+'px'; }
    wgCount++;
    const w = wide?(fill?640:spec.type==='model'?460:480):380;
    const hGuess = fill?460 : spec.type==='model'?420 : spec.type==='chart'?340 : spec.type==='music'?240 : spec.type==='video'?300 : 300;
    const place = placeWidget(w, hGuess);
    const wpos = { x: place.x, y: place.y };
    wg.style.left=wpos.x+'px'; wg.style.top=wpos.y+'px';
    const head=document.createElement('div'); head.className='wg-head';
    const ttl=document.createElement('span'); ttl.className='wg-title'; ttl.textContent = spec.title || titleFor(spec); ttl.title = ttl.textContent;
    const pin=document.createElement('button'); pin.className='wg-pin'+(pinnedIds.has(String(spec.id||''))?' on':''); pin.setAttribute('aria-label','Pin');
    pin.title='Pin — keep this widget';
    pin.innerHTML='<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 4h12v17l-6-4.5L6 21z"/></svg>';
    pin.onclick=(e)=>{ e.stopPropagation(); togglePin(wg._spec||spec, pin); };
    const x=document.createElement('button'); x.className='wg-x'; x.setAttribute('aria-label','Close');
    x.innerHTML='<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>'; x.onclick=()=>{ widgets.delete(wid);
      if(wg._chart){try{wg._chart.destroy();}catch{}}
      if(wg._map){try{wg._map.remove();}catch{}}
      if(wg._mapRo){try{wg._mapRo.disconnect();}catch{}}
      if(wg._ro){try{wg._ro.disconnect();}catch{}}
      wg.remove(); growWidgetCanvas(); };
    head.append(ttl, pin, x); wg.appendChild(head);
    const body=document.createElement('div'); body.className='wg-body'; wg.appendChild(body);
    // Attach BEFORE rendering: size-aware renderers (Leaflet maps, charts)
    // measure their container at init — a detached element measures 0x0,
    // which for maps meant zoom-0 "all ocean" and a half-viewport pan.
    widgets.set(wid, wg);
    widgetLayer.appendChild(wg);
    try { renderWidget(body, spec, wg); } catch(e){ body.textContent='widget render error'; }
    growWidgetCanvas();
    presentWidget(wpos, w, hGuess, place.scroll);
    // drag the widget by its header
    let d=null;
    // NOTE: the click lands on the svg INSIDE the button, so a strict
    // `e.target===x` check misses and setPointerCapture eats the click.
    head.addEventListener('pointerdown',(e)=>{ if(x.contains(e.target)||pin.contains(e.target))return; d={sx:e.clientX,sy:e.clientY,ox:wpos.x,oy:wpos.y}; head.setPointerCapture(e.pointerId); });
    head.addEventListener('pointermove',(e)=>{ if(!d)return; wpos.x=d.ox+(e.clientX-d.sx); wpos.y=d.oy+(e.clientY-d.sy); wg.style.left=wpos.x+'px'; wg.style.top=wpos.y+'px'; });
    head.addEventListener('pointerup',()=>{ d=null; growWidgetCanvas(); });
    // lifecycle bookkeeping: track interaction so idle widgets can pill/stop
    wg._spec=spec; wg._lastTouch=Date.now(); wg._state='active';
    wg.addEventListener('pointerdown', ()=>{ if(wg._state!=='active') markTouched(wg); else wg._lastTouch=Date.now(); }, true);
    return wg;
  }

  // ── widget lifecycle: active → telemetry pill (idle) → stopped (stale) → resume.
  //    Keeps the page light: idle widgets shrink to a named pill with a bit of
  //    live info; hours-stale ones free their heavy resources entirely and
  //    re-render from spec the instant you touch them. Tunable below. ──
  // ── Pinned widgets (v0.2 §6): restore on load, keep copies fresh ──
  const pinnedIds=new Set();
  async function loadPins(){
    try{
      const d=await (await fetch('/v1/pins',{credentials:'same-origin'})).json();
      (d.pins||[]).forEach(spec=>{ pinnedIds.add(String(spec.id)); try{ spawnWidget(spec); }catch{} });
    }catch{}
  }
  setTimeout(loadPins, 1200);
  async function togglePin(spec, btn){
    const id=String(spec.id||'');
    if(!id) return;
    if(pinnedIds.has(id)){
      try{ await fetch('/v1/pins/'+encodeURIComponent(id),{method:'DELETE',credentials:'same-origin'});
        pinnedIds.delete(id); btn.classList.remove('on'); toast('Unpinned'); }catch{ toast('Failed'); }
    } else {
      try{ const r=await fetch('/v1/pins',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({spec})});
        if(r.ok){ pinnedIds.add(id); btn.classList.add('on'); toast('Pinned — it will persist'); } else toast('Failed');
      }catch{ toast('Failed'); }
    }
  }

  // Debug/test hook: the widget gallery harness (tests/ui/gallery.mjs)
  // spawns every widget type with fixture specs through the REAL renderer.
  try { window.__orbSpawnWidget = spawnWidget; } catch { /* strict contexts */ }

  // ── Narrated first-run (v0.2 S3): three optional moments on a fresh orb.
  //    Server state drives it; every step skippable; "Later" dismisses. ──
  async function sayLine(text){
    try{
      const r=await fetch('/v1/firstrun/say',{method:'POST',credentials:'same-origin',
        headers:{'content-type':'application/json'},body:JSON.stringify({text})});
      if(!r.ok) return;
      const a=new Audio(URL.createObjectURL(await r.blob()));
      a.play().catch(()=>{});  // autoplay may need a gesture; the card carries the words anyway
    }catch{}
  }
  async function firstRunTick(){
    let v=null;
    try{ v=await (await fetch('/v1/firstrun',{credentials:'same-origin'})).json(); }catch{ return; }
    if(!v||!v.active){ document.getElementById('firstrun-card')?.remove(); return; }
    renderFirstRun(v);
  }
  function frPost(body){ return fetch('/v1/firstrun',{method:'POST',credentials:'same-origin',
    headers:{'content-type':'application/json'},body:JSON.stringify(body)}).then(()=>firstRunTick()); }
  function renderFirstRun(v){
    document.getElementById('firstrun-card')?.remove();
    const card=document.createElement('div'); card.className='fr-card'; card.id='firstrun-card';
    const words=document.createElement('div'); words.className='fr-words'; words.textContent=v.narration||''; card.appendChild(words);
    const body=document.createElement('div'); body.className='fr-body'; card.appendChild(body);
    if(v.step==='name'){
      const inp=document.createElement('input'); inp.className='fr-input'; inp.placeholder=v.orbName||'Orb'; inp.maxLength=40;
      const go=document.createElement('button'); go.className='fr-btn'; go.textContent='That’s your name';
      go.onclick=()=>frPost({action:'name',name:inp.value.trim()||v.orbName||'Orb'});
      inp.addEventListener('keydown',e=>{ if(e.key==='Enter') go.click(); });
      body.append(inp,go);
    } else if(v.step==='members'){
      const list=document.createElement('div'); list.className='fr-list';
      (v.members||[]).forEach(m=>{ const r=document.createElement('div'); r.className='fr-row';
        r.textContent=m.email+(m.role==='owner'?' — owner':''); list.appendChild(r); });
      const inp=document.createElement('input'); inp.className='fr-input'; inp.placeholder='family@example.com'; inp.type='email';
      const add=document.createElement('button'); add.className='fr-btn ghost'; add.textContent='Add';
      add.onclick=()=>{ const e=inp.value.trim(); if(e){ inp.value=''; frPost({action:'add-member',email:e}); } };
      inp.addEventListener('keydown',e=>{ if(e.key==='Enter') add.click(); });
      const next=document.createElement('button'); next.className='fr-btn'; next.textContent='Next';
      next.onclick=()=>frPost({action:'next'});
      body.append(list,inp,add,next);
    } else if(v.step==='devices'){
      const list=document.createElement('div'); list.className='fr-list';
      const devs=v.devices||[];
      if(!devs.length){ const r=document.createElement('div'); r.className='fr-row dim'; r.textContent='Nothing discovered yet — devices show up in Settings → Home as they appear.'; list.appendChild(r); }
      devs.forEach(d=>{ const r=document.createElement('div'); r.className='fr-row';
        r.textContent=`${d.name}${d.detail?' — '+d.detail:''}`; list.appendChild(r); });
      const done=document.createElement('button'); done.className='fr-btn'; done.textContent='Sounds good';
      done.onclick=()=>frPost({action:'next'});
      body.append(list,done);
    }
    const later=document.createElement('button'); later.className='fr-btn link'; later.textContent='Later';
    later.onclick=()=>frPost({action:'dismiss'});
    card.appendChild(later);
    document.body.appendChild(card);
    sayLine(v.narration||'');
  }
  setTimeout(firstRunTick, 1600);
  try { window.__orbFirstRunTick = firstRunTick; } catch { /* strict contexts */ }

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
    // Live-computable telemetry beats emit-time snapshots.
    if(s.type==='timers'){ const n=(s.timers||[]).filter(t=>t.at>Date.now()).length; return n?n+' running':'done'; }
    if(s.type==='climate'&&s.current!=null) return Math.round(s.current)+'°'+(s.target!=null?' → '+s.target+'°':'');
    if(s.type==='media') return s.media_title?('♪ '+s.media_title):(s.state||'media');
    if(s.type==='printer3d') return (s.progress!=null?s.progress+'% · ':'')+(s.state||'printer');
    if(s.type==='housemode') return 'mode: '+(s.mode||'home');
    if(s.pill) return String(s.pill);                                  // agent-supplied telemetry
    switch(s.type){
      case 'music': return '♪ '+(s.title||'music');
      case 'mail': return (((s.messages||[]).filter(m=>m.unread).length)||0)+' unread';
      case 'docker': return s.cpu!=null?('CPU '+s.cpu+'%'+(s.mem?' · '+s.mem:'')):'docker';
      case 'calendar': return (((s.events||[]).length)||0)+' events';
      case 'vercel': return (((s.deployments||[]).length)||0)+' deploys';
      case 'weather': return (s.current&&s.current.temp!=null)?(s.current.temp+'°'):'weather';
      case 'todo': { const it=s.items||[]; return (it.filter(i=>i.status==='completed').length)+'/'+it.length+' done'; }
      case 'home': { const d=s.devices||[]; return (d.filter(x=>x.on===true).length)+' on · '+d.length; }
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

  function titleFor(s){ return ({chart:'Chart',results:'Results',video:'Video',music:'Music',table:'Table',stats:'Stats',gallery:'Gallery',image:'Image',embed:'Embed',model:'3D model',calculator:'Calculator',weather:'Weather',calendar:'Calendar',code:'Code',mail:'Mail',vercel:'Vercel',map:'Map',docker:'Docker',app:'App',html:'HTML',note:'Note',vacuum:'Vacuum',covers:'Shades',security:'Security',plugs:'Plugs',scenes:'Scenes',sensors:'Readings',camera:'Camera',timers:'Timers',presence:"Who's home",automations:'Automations',printer3d:'Printer',familyboard:'Family board',briefing:'Today',housemode:'House mode',document:'Document',wallet:'Wallet',lights:'Lights',media:'Media',climate:'Climate',todo:'Tasks',home:'Home'})[s.type]||(s.type?String(s.type):'Note'); }

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
    // Skeleton-first streaming (v0.2 §5): a pending spec renders shimmer
    // immediately; the full spec re-emitted with the same id fills it in.
    if(spec.pending){
      body.innerHTML='<div class="wg-skel"><div class="sk w62"></div><div class="sk w88"></div><div class="sk w45"></div></div>';
      return;
    }
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
    else if(spec.type==='home') renderHome(body, spec, wg);
    else if(spec.type==='todo') renderTodo(body, spec);
    else if(spec.type==='app') renderApp(body, spec);
    else if(spec.type==='html') renderHtml(body, spec);
    else if(spec.type==='note') renderNote(body, spec);
    else if(spec.type==='document') renderDocument(body, spec);
    else if(spec.type==='wallet') renderWallet(body, spec, wg);
    else if(spec.type==='lights') renderLights(body, spec);
    else if(spec.type==='media') renderMedia(body, spec, wg);
    else if(spec.type==='climate') renderClimate(body, spec);
    else if(spec.type==='shopping') renderShopping(body, spec);
    else if(spec.type==='vacuum') renderVacuum(body, spec);
    else if(spec.type==='covers') renderCovers(body, spec);
    else if(spec.type==='security') renderSecurity(body, spec);
    else if(spec.type==='plugs') renderPlugs(body, spec);
    else if(spec.type==='scenes') renderScenes(body, spec);
    else if(spec.type==='sensors') renderSensors(body, spec);
    else if(spec.type==='camera') renderCamera(body, spec, wg);
    else if(spec.type==='timers') renderTimers(body, spec, wg);
    else if(spec.type==='presence') renderPresence(body, spec);
    else if(spec.type==='energy') renderEnergy(body, spec);
    else if(spec.type==='automations') renderAutomations(body, spec);
    else if(spec.type==='printer3d') renderPrinter3d(body, spec, wg);
    else if(spec.type==='familyboard') renderFamilyBoard(body, spec);
    else if(spec.type==='briefing') renderBriefing(body, spec);
    else if(spec.type==='housemode') renderHouseMode(body, spec);
    else if(spec.type==='setup') renderSetup(body, spec, wg);
    else if(spec.type==='approval') renderApproval(body, spec, wg);
    else if(spec.type==='receipts') renderReceipts(body, spec, wg);
    else if(spec.type==='deck') renderDeck(body, spec, wg);
    else if(_plugins[spec.type]) renderPlugin(body, spec, _plugins[spec.type]);
    else {
      // Freshly-minted custom widget? (CreateWidget installs plugins at
      // runtime.) Refresh the plugin registry once before giving up.
      const e=document.createElement('div'); e.className='wg-empty'; e.textContent='Loading widget…'; body.appendChild(e);
      loadPlugins().then(()=>{
        if(_plugins[spec.type]){ body.innerHTML=''; renderPlugin(body, spec, _plugins[spec.type]); }
        else e.textContent=`Unknown widget type "${spec.type}"`;
      }).catch(()=>{ e.textContent=`Unknown widget type "${spec.type}"`; });
    }
  }

  // ── document: file viewer (pdf / markdown / text / image / html) ──
  function renderDocument(body, spec){
    const url=safeUrl(spec.url);
    const fmt=(spec.format||spec.mime||'').toLowerCase();
    const name=spec.name||spec.title||'Document';
    const bar=document.createElement('div'); bar.className='wg-doc-bar';
    bar.innerHTML=`<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg><span class="nm" title="${esc2(name)}">${esc2(name)}</span>`;
    if(url){
      const a=document.createElement('a'); a.className='wg-doc-open'; a.href=url; a.target='_blank'; a.rel='noopener'; a.textContent='Open ↗'; bar.appendChild(a);
    }
    body.appendChild(bar);
    const view=document.createElement('div'); view.className='wg-doc-view'; body.appendChild(view);
    const isPdf=fmt.includes('pdf')||(url&&/\.pdf($|[?#])/i.test(url));
    const isImg=fmt.startsWith('image')||/\b(png|jpe?g|gif|webp|svg)\b/.test(fmt)||(url&&/\.(png|jpe?g|gif|webp)($|[?#])/i.test(url));
    const isMd=fmt.includes('markdown')||fmt==='md'||(url&&/\.(md|markdown)($|[?#])/i.test(url));
    const isHtml=fmt.includes('html')||(url&&/\.html?($|[?#])/i.test(url));
    if(spec.text!=null && !url){
      if(isMd||!fmt||fmt==='text'||fmt.includes('plain')){
        const d=document.createElement('div'); d.className='wg-md';
        if(isMd) d.innerHTML=mdToHtml(String(spec.text));
        else { d.className='wg-doc-text'; d.textContent=String(spec.text); }
        view.appendChild(d);
      } else if(isHtml){
        const f=document.createElement('iframe'); f.className='wg-doc-frame'; f.setAttribute('sandbox','allow-scripts'); f.srcdoc=String(spec.text); view.appendChild(f);
      } else { const d=document.createElement('div'); d.className='wg-doc-text'; d.textContent=String(spec.text); view.appendChild(d); }
      return;
    }
    if(!url){ view.innerHTML='<div class="wg-empty">No document.</div>'; return; }
    if(isPdf){
      // Browsers render PDFs natively inside an embed/iframe.
      const f=document.createElement('iframe'); f.className='wg-doc-frame'; f.src=url; view.appendChild(f);
    } else if(isImg){
      const i=document.createElement('img'); i.className='wg-image'; i.src=url; i.alt=name;
      i.onerror=()=>{ i.replaceWith(Object.assign(document.createElement('div'),{className:'wg-empty',textContent:'Failed to load.'})); };
      view.appendChild(i);
    } else if(isMd||fmt==='text'||fmt.includes('plain')||(url&&/\.(txt|log|csv)($|[?#])/i.test(url))){
      view.innerHTML='<div class="wg-empty">Loading…</div>';
      fetch(url,{credentials:'same-origin'}).then(r=>r.ok?r.text():Promise.reject(r.status)).then(t=>{
        view.innerHTML='';
        const d=document.createElement('div');
        if(isMd){ d.className='wg-md'; d.innerHTML=mdToHtml(t.slice(0,300000)); }
        else { d.className='wg-doc-text'; d.textContent=t.slice(0,300000); }
        view.appendChild(d);
      }).catch(()=>{ view.innerHTML='<div class="wg-empty">Couldn’t load the document.</div>'; });
    } else if(isHtml){
      const f=document.createElement('iframe'); f.className='wg-doc-frame'; f.setAttribute('sandbox','allow-scripts allow-same-origin'); f.src=url; view.appendChild(f);
    } else {
      // Unknown format: try the browser's native viewer; offer Open as backup.
      const f=document.createElement('iframe'); f.className='wg-doc-frame'; f.src=url; view.appendChild(f);
    }
  }

  // ── wallet: see & choose payment mechanisms (metadata only, no PANs) ──
  const CARD_ICONS={applepay:' Pay',googlepay:'G Pay'};
  function renderWallet(body, spec, wg){
    const wrap=document.createElement('div'); wrap.className='wg-wallet';
    body.appendChild(wrap);
    const draw=(methods, selected)=>{
      wrap.innerHTML='';
      const list=document.createElement('div'); list.className='wg-wallet-list';
      if(!methods.length){
        list.innerHTML='<div class="wg-empty">No payment methods yet — add one below.<br><span style="font-size:11px;">Orb stores only a label and last 4 digits, never card numbers.</span></div>';
      }
      methods.forEach(m=>{
        const row=document.createElement('div'); row.className='wg-pay'+(m.id===selected?' sel':''); row.tabIndex=0; row.setAttribute('role','button');
        const badge=m.kind==='applepay'?'Pay':m.kind==='googlepay'?'GPay':(m.brand||'card').toUpperCase();
        row.innerHTML=`<span class="badge${m.kind!=='card'?' wallet':''}">${esc2(badge)}</span>`+
          `<span class="grow"><span class="lbl">${esc2(m.label)}</span>${m.last4?`<span class="l4">···· ${esc2(m.last4)}</span>`:''}</span>`+
          `<span class="tick">${m.id===selected?'✓':''}</span>`;
        const pick=async()=>{ try{
            const r=await fetch('/v1/wallet/select',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({id:m.id})});
            if(r.ok){ draw(methods, m.id); toast('Paying with '+m.label); } else toast('Failed');
          }catch{ toast('Failed'); } };
        row.onclick=pick; row.onkeydown=e=>{ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); pick(); } };
        list.appendChild(row);
      });
      wrap.appendChild(list);
      // Native wallet availability — an honest probe, not a promise.
      if(window.PaymentRequest){
        try{
          const pr=new PaymentRequest([{supportedMethods:'https://apple.com/apple-pay',data:{version:3,merchantIdentifier:'probe',merchantCapabilities:['supports3DS'],supportedNetworks:['visa','masterCard'],countryCode:'US'}},{supportedMethods:'https://google.com/pay'}].slice(window.ApplePaySession?0:1),
            {total:{label:'probe',amount:{currency:'USD',value:'0.00'}}});
          pr.canMakePayment().then(ok=>{
            const n=document.createElement('div'); n.className='wg-wallet-native';
            n.textContent= ok ? 'Apple Pay / Google Pay available on this device — payment happens in its own sheet.' : 'No native wallet detected in this browser.';
            wrap.appendChild(n);
          }).catch(()=>{});
        }catch{}
      }
      const form=document.createElement('div'); form.className='wg-wallet-add';
      form.innerHTML=`<input id="wlLbl" placeholder="Label (e.g. Personal Visa)" maxlength="60"/><input id="wlL4" placeholder="last 4" maxlength="4" inputmode="numeric"/><button id="wlAdd">Add</button>`;
      wrap.appendChild(form);
      form.querySelector('#wlAdd').onclick=async()=>{
        const label=form.querySelector('#wlLbl').value.trim(); const l4=form.querySelector('#wlL4').value.trim();
        if(!label) return toast('Give it a label');
        if(l4&&!/^\d{4}$/.test(l4)) return toast('Last 4 digits only — never the full number');
        try{
          const r=await fetch('/v1/wallet/add',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({label,last4:l4,kind:'card'})});
          if(r.ok){ const d=await (await fetch('/v1/wallet',{credentials:'same-origin'})).json(); draw(d.methods,d.selected); }
          else toast((await r.json()).error||'Failed');
        }catch{ toast('Failed'); }
      };
    };
    draw(spec.methods||[], spec.selected||null);
  }

  // ── lights: room-grouped light control ──
  function renderLights(body, spec){
    const groups=spec.groups||[];
    if(!groups.length){ body.innerHTML='<div class="wg-empty">No lights found.</div>'; return; }
    const wrap=document.createElement('div'); wrap.className='wg-lights'; body.appendChild(wrap);
    groups.forEach(g=>{
      const h=document.createElement('div'); h.className='wg-area-h'; h.textContent=g.area; wrap.appendChild(h);
      (g.lights||[]).forEach(l=>{
        const row=document.createElement('div'); row.className='wg-light'+(l.on?' on':'');
        row.innerHTML=`<span class="ic">${homeIcon('light')}</span><span class="nm" title="${esc2(l.name)}">${esc2(l.name)}</span>`;
        const sl=document.createElement('input'); sl.type='range'; sl.min=0; sl.max=100; sl.value=l.on?(l.brightness!=null?l.brightness:100):0; sl.className='dim'; sl.setAttribute('aria-label','Brightness: '+l.name);
        sl.onchange=async()=>{ const v=Number(sl.value);
          try{ const r=await fetch('/v1/home/control',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify(v===0?{entity_id:l.entity_id,action:'off'}:{entity_id:l.entity_id,action:'set',value:v})});
            if(r.ok){ l.on=v>0; row.classList.toggle('on',v>0); } else toast('Failed'); }catch{ toast('Failed'); } };
        const tg=document.createElement('button'); tg.className='wg-light-tg'; tg.textContent=l.on?'On':'Off';
        tg.onclick=async()=>{ try{ const r=await fetch('/v1/home/control',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({entity_id:l.entity_id,action:'toggle'})});
          if(r.ok){ l.on=!l.on; row.classList.toggle('on',l.on); tg.textContent=l.on?'On':'Off'; sl.value=l.on?(l.brightness||100):0; } else toast('Failed'); }catch{ toast('Failed'); } };
        row.appendChild(sl); row.appendChild(tg); wrap.appendChild(row);
      });
    });
  }

  // ── media: TV / speaker remote ──
  function renderMedia(body, spec, wg){
    const wrap=document.createElement('div'); wrap.className='wg-media'; body.appendChild(wrap);
    const art=document.createElement('div'); art.className='art';
    const artUrl=spec.artwork&&safeUrl(spec.artwork);
    if(artUrl){ const im=document.createElement('img'); im.src=artUrl; im.alt=''; im.onerror=()=>im.remove(); art.appendChild(im); }
    else art.innerHTML=homeIcon(String(spec.kind||'').toLowerCase()==='tv'?'media_player':'speaker');
    wrap.appendChild(art);
    const meta=document.createElement('div'); meta.className='meta';
    meta.innerHTML=`<div class="now">${esc2(spec.media_title||spec.state||'idle')}</div><div class="src">${esc2([spec.kind,spec.area,spec.app].filter(Boolean).join(' · ')||spec.name||'')}</div>`;
    wrap.appendChild(meta);
    const ctl=document.createElement('div'); ctl.className='ctl';
    const btn=(label,action,title)=>{ const b=document.createElement('button'); b.className='wg-med-btn'; b.innerHTML=label; b.title=title;
      b.onclick=async()=>{ try{ const r=await fetch('/v1/home/control',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({entity_id:spec.entity_id,action})});
        if(!r.ok) toast('Failed'); }catch{ toast('Failed'); } };
      return b; };
    const svg=p=>`<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
    ctl.appendChild(btn(svg('<path d="M19 20 9 12l10-8zM7 4v16"/>'),'prev','Previous'));
    ctl.appendChild(btn(svg('<path d="m5 4 8 8-8 8z"/><path d="M17 5v14"/>'),'toggle','Play/Pause'));
    ctl.appendChild(btn(svg('<path d="m5 4 10 8-10 8zM17 4v16"/>'),'next','Next'));
    ctl.appendChild(btn(svg('<path d="M12 3v9"/><path d="M6.6 6.6a8 8 0 1 0 10.8 0"/>'),'off','Off'));
    wrap.appendChild(ctl);
    const volRow=document.createElement('div'); volRow.className='vol';
    volRow.innerHTML='<span class="vlbl">vol</span>';
    const vol=document.createElement('input'); vol.type='range'; vol.min=0; vol.max=100; vol.value=spec.volume!=null?spec.volume:50; vol.setAttribute('aria-label','Volume: '+(spec.name||'player'));
    vol.onchange=async()=>{ try{ const r=await fetch('/v1/home/control',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({entity_id:spec.entity_id,action:'set',value:Number(vol.value)})});
      if(!r.ok) toast('Failed'); }catch{ toast('Failed'); } };
    volRow.appendChild(vol); wrap.appendChild(volRow);
  }

  // ── shopping: list + buy options ──
  function renderShopping(body, spec){
    const wrap=document.createElement('div'); wrap.className='wg-shop'; body.appendChild(wrap);
    const items=spec.items||[];
    const list=document.createElement('div'); list.className='wg-shop-list';
    if(!items.length) list.innerHTML='<div class="wg-empty">List is empty — ask Orb to add something.</div>';
    items.forEach(it=>{
      const row=document.createElement('div'); row.className='wg-shop-it'+(it.done?' done':'');
      const cb=document.createElement('button'); cb.className='cb'; cb.setAttribute('aria-label','toggle'); cb.textContent=it.done?'✓':'';
      cb.onclick=async()=>{ try{ const r=await fetch('/v1/shopping/toggle',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({id:it.id})});
        if(r.ok){ it.done=!it.done; row.classList.toggle('done',it.done); cb.textContent=it.done?'✓':''; } else toast('Failed'); }catch{ toast('Failed'); } };
      const nm=document.createElement('span'); nm.className='nm'; nm.textContent=(it.qty&&it.qty>1?it.qty+'× ':'')+it.name; nm.title=it.note||it.name;
      if(it.recur_days){ const rc=document.createElement('span'); rc.className='rec'; rc.textContent='↻'+it.recur_days+'d'; rc.title='Staple — re-adds itself '+it.recur_days+' days after checkoff'; nm.appendChild(rc); }
      const buy=document.createElement('a'); buy.className='buy'; buy.textContent='buy ↗'; buy.target='_blank'; buy.rel='noopener';
      buy.href='https://www.amazon.com/s?k='+encodeURIComponent(it.name);
      const rm=document.createElement('button'); rm.className='rm'; rm.setAttribute('aria-label','Remove '+it.name);
      rm.innerHTML='<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';
      rm.onclick=async()=>{ try{ const r=await fetch('/v1/shopping/'+encodeURIComponent(it.id),{method:'DELETE',credentials:'same-origin'});
        if(r.ok) row.remove(); else toast('Failed'); }catch{ toast('Failed'); } };
      row.append(cb,nm,buy,rm); list.appendChild(row);
    });
    wrap.appendChild(list);
    if(spec.options&&spec.options.merchants){
      const h=document.createElement('div'); h.className='wg-area-h'; h.textContent='Buy options · '+spec.options.query; wrap.appendChild(h);
      const opts=document.createElement('div'); opts.className='wg-shop-opts';
      spec.options.merchants.forEach(m=>{ const u=safeUrl(m.url); if(!u) return;
        const a=document.createElement('a'); a.className='wg-shop-merchant'; a.href=u; a.target='_blank'; a.rel='noopener'; a.textContent=m.merchant+' ↗'; opts.appendChild(a); });
      wrap.appendChild(opts);
    }
    const foot=document.createElement('div'); foot.className='wg-shop-foot';
    foot.textContent='Checkout happens at the merchant — Amazon uses your Amazon account; elsewhere pick a method in the Wallet.';
    wrap.appendChild(foot);
    // quick-add
    const form=document.createElement('div'); form.className='wg-wallet-add';
    form.innerHTML='<input id="shopAdd" placeholder="Add an item…" maxlength="120"/><button id="shopAddBtn">Add</button>';
    wrap.appendChild(form);
    const doAdd=async()=>{ const inp=form.querySelector('#shopAdd'); const v=inp.value.trim(); if(!v) return;
      try{ const r=await fetch('/v1/shopping/add',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({name:v})});
        if(r.ok){ const d=await (await fetch('/v1/shopping',{credentials:'same-origin'})).json(); body.innerHTML=''; renderShopping(body,{...spec,items:d.items,options:spec.options}); }
        else toast('Failed'); }catch{ toast('Failed'); } };
    form.querySelector('#shopAddBtn').onclick=doAdd;
    form.querySelector('#shopAdd').onkeydown=e=>{ if(e.key==='Enter') doAdd(); };
  }

  // shared: POST a control action, toast on failure. Returns ok.
  async function haCtl(entity_id, action, value){
    try{
      const body={entity_id,action}; if(value!=null) body.value=value;
      const r=await fetch('/v1/home/control',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
      if(!r.ok) toast('Couldn’t control the device');
      return r.ok;
    }catch{ toast('Couldn’t reach the server'); return false; }
  }

  // ── covers: shades/blinds, position slider per cover ──
  function renderCovers(body, spec){
    const wrap=document.createElement('div'); wrap.className='wg-lights'; body.appendChild(wrap);
    const groups=spec.groups||[];
    if(!groups.length){ wrap.innerHTML='<div class="wg-empty">No shades or blinds.</div>'; return; }
    groups.forEach(g=>{
      const h=document.createElement('div'); h.className='wg-area-h'; h.textContent=g.area; wrap.appendChild(h);
      (g.covers||[]).forEach(c=>{
        const open=c.state==='open'||(c.position!=null&&c.position>0);
        const row=document.createElement('div'); row.className='wg-light'+(open?' on':'');
        row.innerHTML=`<span class="ic">${homeIcon('cover')}</span><span class="nm" title="${esc2(c.name)}">${esc2(c.name)}</span>`;
        const sl=document.createElement('input'); sl.type='range'; sl.min=0; sl.max=100; sl.className='dim'; sl.setAttribute('aria-label','Position: '+c.name);
        sl.value=c.position!=null?c.position:(open?100:0);
        sl.onchange=async()=>{ if(await haCtl(c.entity_id,'set',Number(sl.value))) row.classList.toggle('on',Number(sl.value)>0); };
        const tg=document.createElement('button'); tg.className='wg-light-tg'; tg.textContent=open?'Open':'Closed';
        tg.onclick=async()=>{ const target=row.classList.contains('on')?'close':'open';
          if(await haCtl(c.entity_id,target)){ row.classList.toggle('on'); tg.textContent=row.classList.contains('on')?'Open':'Closed'; sl.value=row.classList.contains('on')?100:0; } };
        row.appendChild(sl); row.appendChild(tg); wrap.appendChild(row);
      });
    });
  }

  // ── security: locks + door/window/motion, one calm glance ──
  function renderSecurity(body, spec){
    const wrap=document.createElement('div'); wrap.className='wg-security'; body.appendChild(wrap);
    const locks=spec.locks||[], sensors=spec.sensors||[];
    if(!locks.length&&!sensors.length){ wrap.innerHTML='<div class="wg-empty">No locks or sensors.</div>'; return; }
    locks.forEach(l=>{
      const row=document.createElement('div'); row.className='wg-sec-row'+(l.locked?'':' alert');
      row.innerHTML=`<span class="ic">${homeIcon('lock')}</span><span class="nm">${esc2(l.name)}</span><span class="st">${l.locked?'locked':'UNLOCKED'}</span>`;
      const b=document.createElement('button'); b.className='wg-light-tg'; b.textContent=l.locked?'Unlock':'Lock';
      b.onclick=async()=>{ const act=row.classList.contains('alert')?'lock':'unlock';
        if(await haCtl(l.entity_id,act)){ row.classList.toggle('alert'); const locked=!row.classList.contains('alert');
          row.querySelector('.st').textContent=locked?'locked':'UNLOCKED'; b.textContent=locked?'Unlock':'Lock'; } };
      row.appendChild(b); wrap.appendChild(row);
    });
    const kindIcon={door:'cover',window:'cover',motion:'binary_sensor',smoke:'sensor',co:'sensor'};
    sensors.forEach(s=>{
      const active=s.on&&s.kind!=='motion';
      const row=document.createElement('div'); row.className='wg-sec-row'+(active?' alert':'');
      row.innerHTML=`<span class="ic">${homeIcon(kindIcon[s.kind]||'binary_sensor')}</span><span class="nm">${esc2(s.name)}</span>`+
        `<span class="st">${esc2(s.kind==='motion'?(s.on?'motion':'clear'):(s.on?'OPEN':'closed'))}</span>`;
      wrap.appendChild(row);
    });
  }

  // ── plugs: switch grid by room ──
  function renderPlugs(body, spec){
    const wrap=document.createElement('div'); wrap.className='wg-home'; body.appendChild(wrap);
    const groups=spec.groups||[];
    if(!groups.length){ wrap.innerHTML='<div class="wg-empty">No plugs or switches.</div>'; return; }
    const grid=document.createElement('div'); grid.className='wg-home-grid';
    groups.forEach(g=>{
      if(groups.length>1){ const h=document.createElement('div'); h.className='wg-area-h span'; h.textContent=g.area; grid.appendChild(h); }
      (g.plugs||[]).forEach(p=>{
        const card=document.createElement('div'); card.className='wg-home-card ctl'+(p.on?' on':''); card.tabIndex=0; card.setAttribute('role','button');
        card.innerHTML=`<div class="ic">${homeIcon('switch')}</div><div class="nm" title="${esc2(p.name)}">${esc2(p.name)}</div><div class="st">${p.on?'on':'off'}</div>`;
        const flip=async()=>{ if(await haCtl(p.entity_id,'toggle')){ p.on=!p.on; card.classList.toggle('on',p.on); card.querySelector('.st').textContent=p.on?'on':'off'; } };
        card.onclick=flip; card.onkeydown=e=>{ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); flip(); } };
        grid.appendChild(card);
      });
    });
    wrap.appendChild(grid);
  }

  // ── scenes: one-tap moods ──
  function renderScenes(body, spec){
    const wrap=document.createElement('div'); wrap.className='wg-scenes'; body.appendChild(wrap);
    const scenes=spec.scenes||[];
    if(!scenes.length){ wrap.innerHTML='<div class="wg-empty">No scenes yet.</div>'; return; }
    scenes.forEach(s=>{
      const b=document.createElement('button'); b.className='wg-scene';
      b.innerHTML=`<span class="ic">${homeIcon('scene')}</span><span>${esc2(s.name)}</span>`;
      b.onclick=async()=>{ if(await haCtl(s.entity_id,'on')){ b.classList.add('fired'); toast(s.name); setTimeout(()=>b.classList.remove('fired'),900); } };
      wrap.appendChild(b);
    });
  }

  // ── sensors: readings tiles ──
  function renderSensors(body, spec){
    const wrap=document.createElement('div'); wrap.className='wg-home'; body.appendChild(wrap);
    const groups=spec.groups||[];
    if(!groups.length){ wrap.innerHTML='<div class="wg-empty">No readings.</div>'; return; }
    const UNITKIND={temperature:'🌡',humidity:'💧',battery:'🔋',power:'⚡',energy:'⚡',illuminance:'☀',co2:'CO₂',pm25:'PM','pressure':'⭱'};
    const grid=document.createElement('div'); grid.className='wg-read-grid';
    groups.forEach(g=>{
      if(groups.length>1){ const h=document.createElement('div'); h.className='wg-area-h span'; h.textContent=g.area; grid.appendChild(h); }
      (g.readings||[]).forEach(r=>{
        const t=document.createElement('div'); t.className='wg-read';
        t.innerHTML=`<div class="v">${esc2(String(r.value))}<span class="u">${esc2(r.unit)}</span></div><div class="n" title="${esc2(r.name)}">${esc2(r.name)}</div>`;
        grid.appendChild(t);
      });
    });
    wrap.appendChild(grid);
  }

  // ── camera: snapshot, refreshes while active ──
  function renderCamera(body, spec, wg){
    const src=safeUrl(spec.snapshot);
    if(!src){ body.innerHTML='<div class="wg-empty">No camera feed.</div>'; return; }
    const img=document.createElement('img'); img.className='wg-cam'; img.alt=spec.name||'camera';
    const bust=()=>{ img.src=src+(src.includes('?')?'&':'?')+'t='+Date.now(); };
    img.onerror=()=>{ img.replaceWith(Object.assign(document.createElement('div'),{className:'wg-empty',textContent:'Camera unavailable.'})); if(wg&&wg._camTimer){clearInterval(wg._camTimer);wg._camTimer=null;} };
    bust(); body.appendChild(img);
    if(wg){ if(wg._camTimer) clearInterval(wg._camTimer);
      wg._camTimer=setInterval(()=>{ if(!document.contains(wg)){ clearInterval(wg._camTimer); return; } if(wg._state==='active') bust(); },10000); }
  }

  // ── house mode: one-tap posture switch ──
  function renderHouseMode(body, spec){
    const wrap=document.createElement('div'); wrap.className='wg-mode'; body.appendChild(wrap);
    const MODES=[
      {id:'home',label:'Home',desc:'gentle nudges',icon:homeIcon('light')},
      {id:'away',label:'Away',desc:'instant alerts + motion',icon:homeIcon('lock')},
      {id:'vacation',label:'Vacation',desc:'armed + daily check-ins',icon:homeIcon('scene')},
      {id:'guest',label:'Guests',desc:'door nudges muted',icon:homeIcon('media_player')},
    ];
    let cur=spec.mode||'home';
    MODES.forEach(m=>{
      const b=document.createElement('button'); b.className='wg-mode-chip'+(m.id===cur?' on':''); b.setAttribute('role','radio');
      b.innerHTML=`<span class="ic">${m.icon}</span><span class="l">${esc2(m.label)}</span><span class="d">${esc2(m.desc)}</span>`;
      b.onclick=async()=>{
        try{
          const r=await fetch('/v1/home/mode',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({mode:m.id})});
          if(r.ok){ cur=m.id; wrap.querySelectorAll('.wg-mode-chip').forEach(c=>c.classList.remove('on')); b.classList.add('on'); toast('House mode: '+m.label); }
          else toast('Failed');
        }catch{ toast('Failed'); }
      };
      wrap.appendChild(b);
    });
  }

  // ── setup: a Home Assistant pairing flow, driven visually ──
  // Shared by the setup widget (agent-initiated) and Settings → Smart home.
  function haPretty(s){ s=String(s||'').replace(/_/g,' '); return s.charAt(0).toUpperCase()+s.slice(1); }
  function haFlowForm(box, flow, integration, onFlow){
    box.innerHTML='';
    const f=flow||{};
    if(f.type==='create_entry'){ box.innerHTML=`<div class="ha-flow-done">✓ ${esc2(f.title||integration||'Integration')} is set up — devices appear shortly.</div>`; if(onFlow) onFlow(f); return; }
    if(f.type==='abort'){ box.innerHTML=`<div class="ha-flow-abort">${esc2(f.abort_text||(f.reason==='already_configured'?'Already set up — nothing to do.':'Setup stopped: '+(f.reason||'unknown')+'.'))}</div>`; if(onFlow) onFlow(f); return; }
    if(f.type!=='form'||!f.flow_id){ box.innerHTML='<div class="set-muted small">Waiting on Home Assistant…</div>'; return; }
    // Human strings from HA's translation catalog; prettified fallbacks.
    if(f.step_title){ const h=document.createElement('div'); h.className='ha-flow-title'; h.textContent=f.step_title; box.appendChild(h); }
    if(f.step_description){ const d=document.createElement('div'); d.className='set-muted small'; d.textContent=f.step_description; box.appendChild(d); }
    if(f.errors){ const e=document.createElement('div'); e.className='ha-flow-err'; e.textContent=(f.errors_text&&f.errors_text.length?f.errors_text:Object.values(f.errors)).join(' · '); box.appendChild(e); }
    const inputs={};
    (f.fields||[]).forEach(fd=>{
      const row=document.createElement('label'); row.className='ha-flow-field';
      const cap=document.createElement('span'); cap.textContent=(fd.label||haPretty(fd.name))+(fd.required?'':' (optional)'); row.appendChild(cap);
      let inp;
      if(fd.options&&fd.options.length){ inp=document.createElement('select'); fd.options.forEach(o=>{ const op=document.createElement('option'); op.value=o; op.textContent=(fd.option_labels&&fd.option_labels[o])||haPretty(o); inp.appendChild(op); }); }
      else if(fd.type==='boolean'){ inp=document.createElement('input'); inp.type='checkbox'; }
      else { inp=document.createElement('input'); inp.type=/code|token|password|secret|key/i.test(fd.name)?'password':(fd.type==='integer'?'number':'text'); inp.autocomplete='off'; }
      row.appendChild(inp);
      if(fd.help){ const h=document.createElement('span'); h.className='ha-flow-help'; h.textContent=fd.help; row.appendChild(h); }
      box.appendChild(row); inputs[fd.name]={inp,fd};
    });
    const go=document.createElement('button'); go.className='set-btn'; go.textContent=(f.fields&&f.fields.length)?'Continue':'Confirm';
    go.onclick=async()=>{
      const data={};
      for(const [name,io] of Object.entries(inputs)){
        let v=io.inp.type==='checkbox'?io.inp.checked:io.inp.value;
        if(v===''&&!io.fd.required) continue;
        if(io.fd.type==='integer'&&v!=='') v=Number(v);
        data[name]=v;
      }
      go.disabled=true; go.textContent='Working…';
      try{
        const r=await fetch('/v1/home/flow/'+encodeURIComponent(f.flow_id),{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({data})});
        const j=await r.json().catch(()=>({}));
        if(!r.ok){ toast(j.error||'Failed'); go.disabled=false; go.textContent='Continue'; return; }
        haFlowForm(box, j.flow, integration, onFlow);
      }catch{ toast('Failed'); go.disabled=false; go.textContent='Continue'; }
    };
    box.appendChild(go);
  }
  function renderSetup(body, spec, wg){
    const wrap=document.createElement('div'); wrap.className='wg-setup'; body.appendChild(wrap);
    haFlowForm(wrap, spec.flow, spec.integration, f=>{ if(wg&&wg._spec) wg._spec.flow=f; });
  }

  // ── deck: the morning digest — cards with thumbs that teach it ──
  function renderDeck(body, spec, wg){
    const wrap=document.createElement('div'); wrap.className='wg-deck'; body.appendChild(wrap);
    (spec.cards||[]).forEach(card=>{
      const cell=document.createElement('div'); cell.className='wg-deck-card';
      const inner=document.createElement('div'); inner.className='wg-deck-body'; cell.appendChild(inner);
      try{ renderWidget(inner, card.spec||{}, wg); }catch{ inner.textContent='—'; }
      const fb=document.createElement('div'); fb.className='wg-deck-fb';
      const send=async(delta)=>{ try{ await fetch('/v1/deck/feedback',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({topic:card.topic,delta})});
        fb.innerHTML='<span class="set-muted small">Noted.</span>'; }catch{} };
      const up=document.createElement('button'); up.className='wg-deck-vote'; up.title='More like this';
      up.innerHTML='<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M7 11v9M7 11l4-8a2.4 2.4 0 0 1 2.3 3l-.8 3h6a2 2 0 0 1 2 2.4l-1.2 5A2 2 0 0 1 17.3 20H7"/></svg>';
      up.onclick=()=>send(1);
      const down=document.createElement('button'); down.className='wg-deck-vote'; down.title='Less of this';
      down.innerHTML='<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17 13V4M17 13l-4 8a2.4 2.4 0 0 1-2.3-3l.8-3H5.5a2 2 0 0 1-2-2.4l1.2-5A2 2 0 0 1 6.7 4H17"/></svg>';
      down.onclick=()=>send(-1);
      fb.append(up,down); cell.appendChild(fb);
      wrap.appendChild(cell);
    });
    const foot=document.createElement('div'); foot.className='wg-deck-foot';
    const done=document.createElement('button'); done.className='set-btn ghost'; done.textContent='Done for today';
    done.onclick=async()=>{ try{ await fetch('/v1/deck/dismiss',{method:'POST',credentials:'same-origin'}); }catch{}
      const host=body.closest('.wg'); if(host){ widgets.delete(host.id?host.id.replace(/^wg-/,''):''); host.remove(); growWidgetCanvas(); } };
    const cust=document.createElement('button'); cust.className='set-btn ghost'; cust.textContent='Customize';
    cust.onclick=async()=>{
      if(wrap.querySelector('.wg-deck-cust')){ wrap.querySelector('.wg-deck-cust').remove(); return; }
      let topics=[];
      try{ topics=(await (await fetch('/v1/deck/topics',{credentials:'same-origin'})).json()).topics||[]; }catch{ return; }
      const panel=document.createElement('div'); panel.className='wg-deck-cust';
      const note=document.createElement('div'); note.className='set-muted small'; note.textContent='Your morning, your mix — pick what shows up.'; panel.appendChild(note);
      topics.forEach(t=>{
        const row=document.createElement('label'); row.className='wg-deck-topic'+(t.available?'':' off');
        const cb=document.createElement('input'); cb.type='checkbox'; cb.checked=!!t.enabled; cb.dataset.id=t.id;
        const txt=document.createElement('span'); txt.innerHTML=`<b>${esc2(t.label)}</b> <i>${esc2(t.available?t.desc:('needs '+(t.needs||'setup')))}</i>`;
        row.append(cb,txt); panel.appendChild(row);
      });
      const save=document.createElement('button'); save.className='set-btn'; save.textContent='Save';
      save.onclick=async()=>{
        const enabled=[...panel.querySelectorAll('input:checked')].map(x=>x.dataset.id);
        save.disabled=true;
        try{
          await fetch('/v1/deck/topics',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({enabled})});
          const d=await (await fetch('/v1/deck?force=1',{credentials:'same-origin'})).json();
          const host=body.closest('.wg');
          if(d.deck&&host){ widgets.delete(host.id?host.id.replace(/^wg-/,''):''); host.remove(); growWidgetCanvas(); spawnWidget(d.deck); }
          else if(!d.deck){ panel.replaceChildren(Object.assign(document.createElement('div'),{className:'set-muted small',textContent:'Saved — nothing to show for those topics right now.'})); }
        }catch{ toast('Could not save'); }
        finally{ save.disabled=false; }
      };
      panel.appendChild(save);
      wrap.insertBefore(panel, foot);
    };
    foot.append(cust,done); wrap.appendChild(foot);
  }

  // ── deck delivery: on load, today's deck appears once (v0.2 §3) ──
  setTimeout(async()=>{
    try{
      const d=await (await fetch('/v1/deck',{credentials:'same-origin'})).json();
      if(d.deck) spawnWidget(d.deck);
    }catch{}
  }, 2200);

  // ── approval: an action waiting on you (trust layer) ──
  function renderApproval(body, spec, wg){
    const wrap=document.createElement('div'); wrap.className='wg-approval'; body.appendChild(wrap);
    if(spec.resolved){
      wrap.innerHTML=`<div class="${spec.approved?'ha-flow-done':'ha-flow-abort'}">${spec.approved?'✓ Approved — done.':'Not approved.'}</div>
        <div class="set-muted small" style="margin-top:6px;">${esc2(spec.summary||'')}</div>`;
      return;
    }
    const sum=document.createElement('div'); sum.className='ap-sum'; sum.textContent=spec.summary||'An action needs your approval.'; wrap.appendChild(sum);
    if(spec.reason){ const r=document.createElement('div'); r.className='set-muted small'; r.textContent=spec.reason; wrap.appendChild(r); }
    const send=async(approve,always)=>{
      try{ const r=await fetch('/v1/approvals/'+encodeURIComponent(spec.approval_id),{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({approve,always})});
        if(!r.ok) toast('That request already expired');
      }catch{ toast('Failed'); }
    };
    const row=document.createElement('div'); row.className='ap-row';
    const ok=document.createElement('button'); ok.className='set-btn'; ok.textContent='Approve'; ok.onclick=()=>send(true,false);
    const no=document.createElement('button'); no.className='set-btn ghost'; no.textContent='Cancel'; no.onclick=()=>send(false,false);
    row.append(ok,no); wrap.appendChild(row);
    if(spec.offer_always){
      const al=document.createElement('button'); al.className='set-btn ghost ap-always';
      al.textContent='Always allow this — just show a receipt';
      al.onclick=()=>send(true,true); wrap.appendChild(al);
    }
    if(spec.expires_at){
      const cd=document.createElement('div'); cd.className='set-muted small ap-cd'; wrap.appendChild(cd);
      const tick=()=>{ const s=Math.max(0,Math.round((spec.expires_at-Date.now())/1000));
        cd.textContent=s?`Expires in ${s}s`:'Expired.'; if(s&&document.contains(cd)) setTimeout(tick,1000); };
      tick();
    }
  }

  // ── receipts: what orb did, with undo ──
  function renderReceipts(body, spec, wg){
    const wrap=document.createElement('div'); wrap.className='wg-receipts'; body.appendChild(wrap);
    const rows=spec.receipts||[];
    if(!rows.length){ wrap.innerHTML='<div class="wg-empty">Nothing yet — Orb hasn’t changed anything.</div>'; return; }
    rows.forEach(r=>{
      const row=document.createElement('div'); row.className='wg-rcpt'+(r.undone?' undone':'');
      const t=new Date(r.ts); const hh=String(t.getHours()).padStart(2,'0')+':'+String(t.getMinutes()).padStart(2,'0');
      row.innerHTML=`<span class="tm mono">${esc2(hh)}</span><div class="grow"><div class="s1">${esc2(r.summary)}</div><div class="s2">${esc2(r.user||'')}${r.undone?' · undone':''}</div></div>`;
      if(r.inverse&&!r.undone){
        const u=document.createElement('button'); u.className='set-btn ghost'; u.textContent='Undo';
        u.onclick=async()=>{ u.disabled=true;
          try{ const res=await fetch('/v1/receipts/'+encodeURIComponent(r.id)+'/undo',{method:'POST',credentials:'same-origin'});
            const j=await res.json().catch(()=>({}));
            if(res.ok){ toast(j.summary||'Undone'); row.classList.add('undone'); u.remove(); } else { toast(j.error||'Failed'); u.disabled=false; }
          }catch{ toast('Failed'); u.disabled=false; } };
        row.appendChild(u);
      }
      wrap.appendChild(row);
    });
  }

  // ── briefing: the day at a glance ──
  function renderBriefing(body, spec){
    const b=spec.briefing||{};
    const wrap=document.createElement('div'); wrap.className='wg-brief'; body.appendChild(wrap);
    if(b.weather){
      const w=document.createElement('div'); w.className='bw';
      w.innerHTML=`<span class="ic">${weatherIcon(b.weather.condition)}</span><span class="t">${esc2(String(b.weather.temp))}°</span>`+
        `<span class="cond">${esc2(b.weather.condition)}<br><span class="hl">H ${esc2(String(b.weather.high))}° · L ${esc2(String(b.weather.low))}°</span></span>`;
      wrap.appendChild(w);
    }
    const sec=[...(b.security&&b.security.locksOpen||[]).map(l=>l+' unlocked'),...(b.security&&b.security.sensorsOpen||[]).map(s2=>s2+' open')];
    if(sec.length){ const a=document.createElement('div'); a.className='wg-sec-row alert'; a.innerHTML=`<span class="ic">${homeIcon('lock')}</span><span class="nm">${esc2(sec.join(' · '))}</span>`; wrap.appendChild(a); }
    const section=(label,rows)=>{ if(!rows.length)return;
      const h=document.createElement('div'); h.className='wg-area-h'; h.textContent=label; wrap.appendChild(h);
      rows.forEach(r=>{ const d=document.createElement('div'); d.className='wg-fam-ev'; d.innerHTML=r; wrap.appendChild(d); }); };
    section('Today', (b.events||[]).map(e=>`<span class="d mono">${esc2(e.time||'—')}</span><span class="t">${esc2(e.title)}${e.who?` <span class="w">· ${esc2(e.who)}</span>`:''}</span>`));
    section('Chores', (b.chores||[]).map(c=>`<span class="d ic-d">${checkIcon}</span><span class="t">${esc2(c.title)} <span class="w">· ${esc2(c.who)}</span></span>`));
    section('Timers', (b.timers||[]).map(t=>`<span class="d mono">${esc2(String(t.minutesLeft))}m</span><span class="t">${esc2(t.label)}</span>`));
    if(b.home&&b.home.length||b.away&&b.away.length){
      section('Presence', [ `<span class="d ic-d">${houseIcon}</span><span class="t">${esc2((b.home||[]).join(', ')||'nobody home')}${b.away&&b.away.length?` <span class="w">· away: ${esc2(b.away.join(', '))}</span>`:''}</span>` ]);
    }
    if(!wrap.children.length) wrap.innerHTML='<div class="wg-empty">Nothing on today’s radar — enjoy it.</div>';
  }

  // ── family board: notes between members + upcoming events ──
  function renderFamilyBoard(body, spec){
    const wrap=document.createElement('div'); wrap.className='wg-fam'; body.appendChild(wrap);
    const notes=spec.notes||[], events=spec.events||[];
    if(!notes.length&&!events.length){ wrap.innerHTML='<div class="wg-empty">Nothing on the board.<br><span style="font-size:11px;">Say “leave a note for Sarah…”.</span></div>'; return; }
    if(notes.length){
      notes.forEach(n=>{
        const row=document.createElement('div'); row.className='wg-fam-note'+(n.delivered?' done':'');
        row.innerHTML=`<div class="who">${esc2(n.from)} <span class="arr">→</span> ${esc2(n.to)}`+
          `<span class="badge">${n.delivered?'delivered':(n.trigger==='home'?'on arrival':'waiting')}</span></div>`+
          `<div class="txt">${esc2(n.text)}</div>`;
        wrap.appendChild(row);
      });
    }
    if(events.length){
      const h=document.createElement('div'); h.className='wg-area-h'; h.textContent='Coming up'; wrap.appendChild(h);
      events.forEach(e=>{
        const row=document.createElement('div'); row.className='wg-fam-ev';
        row.innerHTML=`<span class="d mono">${esc2(e.date.slice(5))}${e.time?' '+esc2(e.time):''}</span><span class="t">${esc2(e.title)}${e.who?` <span class="w">· ${esc2(e.who)}</span>`:''}</span>`;
        wrap.appendChild(row);
      });
    }
  }

  // ── printer3d: live chamber view + job progress + controls ──
  function renderPrinter3d(body, spec, wg){
    const wrap=document.createElement('div'); wrap.className='wg-printer'; body.appendChild(wrap);
    // Live view: MJPEG stream through the authed proxy; if the stream dies,
    // fall back to snapshot polling so there is always a picture.
    const cam=document.createElement('div'); cam.className='cam';
    const stream=safeUrl(spec.stream), snap=safeUrl(spec.snapshot);
    if(stream||snap){
      const img=document.createElement('img'); img.alt=spec.name||'printer';
      let mode='stream';
      const useSnap=()=>{ if(mode==='snap')return; mode='snap';
        if(!snap){ img.replaceWith(Object.assign(document.createElement('div'),{className:'wg-empty',textContent:'Camera unavailable.'})); return; }
        const tick=()=>{ img.src=snap+(snap.includes('?')?'&':'?')+'t='+Date.now(); };
        tick(); if(wg){ if(wg._p3dTimer) clearInterval(wg._p3dTimer);
          wg._p3dTimer=setInterval(()=>{ if(!document.contains(wg)){ clearInterval(wg._p3dTimer); return; } if(wg._state==='active') tick(); },4000); } };
      img.onerror=useSnap;
      img.src=stream||''; if(!stream) useSnap();
      cam.appendChild(img);
      const live=document.createElement('span'); live.className='live'; live.textContent='LIVE'; cam.appendChild(live);
    } else { cam.classList.add('empty'); cam.innerHTML='<div class="wg-empty">No camera yet.</div>'; }
    wrap.appendChild(cam);
    // Job status
    const st=document.createElement('div'); st.className='job';
    const pct=spec.progress!=null?Math.max(0,Math.min(100,Number(spec.progress))):null;
    const rem=spec.remaining_min!=null?(spec.remaining_min>=90?Math.round(spec.remaining_min/60*10)/10+'h':Math.round(spec.remaining_min)+' min'):null;
    st.innerHTML=`<div class="row1"><span class="state">${esc2(String(spec.state||'idle'))}</span>${rem?`<span class="rem">${esc2(rem)} left</span>`:''}</div>`+
      (pct!=null?`<div class="pbar"><div class="pfill" style="width:${pct}%"></div></div><div class="row2"><span>${pct}%</span>${spec.layer!=null?`<span>layer ${esc2(String(spec.layer))}${spec.total_layers?' / '+esc2(String(spec.total_layers)):''}</span>`:''}</div>`:'');
    wrap.appendChild(st);
    // Temperatures
    const temps=document.createElement('div'); temps.className='temps';
    const t=(label,v,target)=>v!=null?`<div class="t"><span class="l">${label}</span><span class="v">${esc2(String(Math.round(v)))}°${target!=null?`<span class="tg">/${esc2(String(Math.round(target)))}°</span>`:''}</span></div>`:'';
    temps.innerHTML=t('nozzle',spec.nozzle,spec.nozzle_target)+t('bed',spec.bed,spec.bed_target);
    if(temps.innerHTML) wrap.appendChild(temps);
    // Controls (button entities — press)
    const c=spec.controls||{};
    const ctl=document.createElement('div'); ctl.className='ctl';
    const mk=(label,eid,danger)=>{ if(!eid)return; const b=document.createElement('button'); b.className='wg-med-btn'+(danger?' danger':''); b.style.width='auto'; b.style.padding='0 16px'; b.textContent=label;
      b.onclick=async()=>{ if(danger&&!confirm(label+' the print?'))return; if(await haCtl(eid,'press')) toast(label+' sent'); };
      ctl.appendChild(b); };
    mk('Pause',c.pause); mk('Resume',c.resume); mk('Stop',c.stop,true);
    if(ctl.children.length) wrap.appendChild(ctl);
  }

  // ── timers: live countdowns ──
  function renderTimers(body, spec, wg){
    const wrap=document.createElement('div'); wrap.className='wg-lights'; body.appendChild(wrap);
    const timers=spec.timers||[];
    if(!timers.length){ wrap.innerHTML='<div class="wg-empty">No timers running.<br><span style="font-size:11px;">Say “set a timer for 10 minutes”.</span></div>'; if(wg&&wg._tmrTimer){clearInterval(wg._tmrTimer);wg._tmrTimer=null;} return; }
    const rows=[];
    timers.forEach(t=>{
      const row=document.createElement('div'); row.className='wg-timer';
      row.innerHTML=`<div class="bar"><div class="fill"></div></div><span class="nm">${esc2(t.label)}</span><span class="left mono"></span>`;
      const rm=document.createElement('button'); rm.className='rm'; rm.setAttribute('aria-label','Cancel '+t.label);
      rm.innerHTML='<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';
      rm.onclick=async()=>{ try{ const r=await fetch('/v1/home/timers/'+encodeURIComponent(t.id),{method:'DELETE',credentials:'same-origin'});
        if(r.ok){ row.remove(); toast('Timer cancelled'); } else toast('Failed'); }catch{ toast('Failed'); } };
      row.appendChild(rm);
      wrap.appendChild(row); rows.push({t,row});
    });
    const fmt=ms=>{ const s=Math.max(0,Math.round(ms/1000)); const h=Math.floor(s/3600),m=Math.floor((s%3600)/60),ss=s%60;
      return h?`${h}:${String(m).padStart(2,'0')}:${String(ss).padStart(2,'0')}`:`${m}:${String(ss).padStart(2,'0')}`; };
    const tickAll=()=>{ const now=Date.now();
      rows.forEach(({t,row})=>{
        const total=Math.max(1,t.at-t.set), left=t.at-now;
        row.querySelector('.left').textContent=left<=0?'done':fmt(left);
        row.querySelector('.fill').style.width=Math.max(0,Math.min(100,100*(1-left/total)))+'%';
        row.classList.toggle('done',left<=0);
      }); };
    tickAll();
    if(wg){ if(wg._tmrTimer) clearInterval(wg._tmrTimer);
      wg._tmrTimer=setInterval(()=>{ if(!document.contains(wg)){ clearInterval(wg._tmrTimer); return; } tickAll(); },1000); }
  }

  // ── presence: who's home ──
  function renderPresence(body, spec){
    const wrap=document.createElement('div'); wrap.className='wg-presence'; body.appendChild(wrap);
    const people=spec.people||[];
    if(!people.length){ wrap.innerHTML='<div class="wg-empty">No people configured.</div>'; return; }
    people.forEach(p=>{
      const chip=document.createElement('div'); chip.className='wg-person'+(p.home?' home':'');
      chip.innerHTML=`<span class="dot"></span><span class="nm">${esc2(p.name)}</span><span class="st">${esc2(p.home?'home':(p.state||'away'))}</span>`;
      wrap.appendChild(chip);
    });
  }

  // ── energy (v0.2 §11 scaffold): honest empty state until metering exists ──
  function renderEnergy(body, spec){
    const wrap=document.createElement('div'); wrap.className='wg-energy'; body.appendChild(wrap);
    const devs=spec.devices||[];
    if(!devs.length){
      wrap.innerHTML='<div class="wg-empty">No energy metering yet.<br>Add a Matter smart plug with power metering, or an HA energy integration, and the house\u2019s live power draw appears here.</div>';
      return;
    }
    const head=document.createElement('div'); head.className='wg-energy-now';
    head.innerHTML=`<span class="big">${esc2(String(spec.total_w??0))}</span><span class="unit">W now</span>`+
      (spec.today_kwh!=null?`<span class="today">${esc2(String(spec.today_kwh))} kWh today</span>`:'');
    wrap.appendChild(head);
    const max=Math.max.apply(null, devs.map(d=>d.watts||0).concat([1]));
    devs.forEach(d=>{
      const row=document.createElement('div'); row.className='wg-energy-row';
      row.innerHTML=`<span class="nm" title="${esc2(d.name)}">${esc2(d.name)}</span>`+
        `<span class="bar"><i style="width:${Math.max(3,Math.round((d.watts||0)/max*100))}%"></i></span>`+
        `<span class="w">${esc2(String(d.watts||0))} W</span>`;
      wrap.appendChild(row);
    });
  }

  // ── automations: toggle + run ──
  function renderAutomations(body, spec){
    const wrap=document.createElement('div'); wrap.className='wg-security'; body.appendChild(wrap);
    const autos=spec.automations||[];
    if(!autos.length){ wrap.innerHTML='<div class="wg-empty">No automations yet — describe one and Orb creates it.</div>'; return; }
    autos.forEach(a=>{
      const row=document.createElement('div'); row.className='wg-sec-row'+(a.on?'':' offed');
      const last=a.last?new Date(a.last):null;
      row.innerHTML=`<span class="ic">${homeIcon('scene')}</span><span class="nm" title="${esc2(a.name)}">${esc2(a.name)}</span>`+
        `<span class="st">${last?esc2(last.toLocaleDateString(undefined,{month:'short',day:'numeric'})):'never ran'}</span>`;
      const run=document.createElement('button'); run.className='wg-light-tg'; run.textContent='Run';
      run.onclick=async()=>{ if(await haCtl(a.entity_id,'run')) toast('Ran '+a.name); };
      const tg=document.createElement('button'); tg.className='wg-light-tg'; tg.textContent=a.on?'On':'Off';
      tg.onclick=async()=>{ const target=a.on?'off':'on';
        if(await haCtl(a.entity_id,target)){ a.on=!a.on; tg.textContent=a.on?'On':'Off'; row.classList.toggle('offed',!a.on); } };
      row.appendChild(run); row.appendChild(tg); wrap.appendChild(row);
    });
  }

  // ── vacuum: robot control ──
  function renderVacuum(body, spec){
    const wrap=document.createElement('div'); wrap.className='wg-climate'; body.appendChild(wrap);
    const ic=document.createElement('div'); ic.style.cssText='color:var(--nv);'; ic.innerHTML=homeIcon('vacuum'); wrap.appendChild(ic);
    const st=document.createElement('div'); st.className='cur'; st.style.fontSize='22px'; st.textContent=spec.state||'unknown'; wrap.appendChild(st);
    const lbl=document.createElement('div'); lbl.className='lbl';
    lbl.textContent=[spec.area, spec.battery!=null?('battery '+spec.battery+'%'):null, spec.fan].filter(Boolean).join(' · '); wrap.appendChild(lbl);
    const row=document.createElement('div'); row.className='tgt';
    const act=(txt,action)=>{ const b=document.createElement('button'); b.className='wg-med-btn'; b.textContent=txt; b.style.width='auto'; b.style.padding='0 14px';
      b.onclick=async()=>{ try{ const r=await fetch('/v1/home/control',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({entity_id:spec.entity_id,action})});
        if(r.ok){ st.textContent=action==='start'?'cleaning':action==='dock'?'returning':'paused'; } else toast('Failed'); }catch{ toast('Failed'); } };
      return b; };
    row.appendChild(act('Clean','start')); row.appendChild(act('Pause','stop')); row.appendChild(act('Dock','dock'));
    wrap.appendChild(row);
  }

  // ── climate: thermostat ──
  function renderClimate(body, spec){
    const wrap=document.createElement('div'); wrap.className='wg-climate'; body.appendChild(wrap);
    const cur=spec.current!=null?Math.round(spec.current*10)/10:null;
    let tgt=spec.target!=null?Number(spec.target):null;
    wrap.innerHTML=`<div class="cur">${cur!=null?esc2(String(cur)):'—'}<span class="u">°</span></div><div class="lbl">${esc2(spec.area||spec.name||'')} · ${esc2(spec.state||'')}</div>`;
    const row=document.createElement('div'); row.className='tgt';
    const mk=(txt,delta)=>{ const b=document.createElement('button'); b.className='wg-med-btn'; b.textContent=txt;
      b.onclick=async()=>{ if(tgt==null) return; tgt=Math.round((tgt+delta)*2)/2; tv.textContent=tgt+'°';
        try{ const r=await fetch('/v1/home/control',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({entity_id:spec.entity_id,action:'set',value:tgt})});
          if(!r.ok) toast('Failed'); }catch{ toast('Failed'); } };
      return b; };
    const tv=document.createElement('span'); tv.className='tv'; tv.textContent=tgt!=null?tgt+'°':'—';
    row.appendChild(mk('−',-0.5)); row.appendChild(tv); row.appendChild(mk('+',0.5));
    wrap.appendChild(row);
  }

  // ── Note: safe markdown subset (escape first, then format — never raw HTML) ──
  function mdInline(s){
    const codes=[];
    s=s.replace(/`([^`]+)`/g,(_,c)=>{ codes.push(c); return '\u0000'+(codes.length-1)+'\u0000'; });
    s=s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,'<a href="$2" target="_blank" rel="noopener">$1</a>');
    s=s.replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>');
    s=s.replace(/\*([^*]+)\*/g,'<em>$1</em>');
    return s.replace(/\u0000(\d+)\u0000/g,(_,i)=>'<code>'+codes[+i]+'</code>');
  }
  function mdToHtml(text){
    const lines=esc2(text).replace(/\r\n?/g,'\n').split('\n');
    let out='', para=[], list=null, code=null;
    const flushPara=()=>{ if(para.length){ out+='<p>'+para.map(mdInline).join('<br>')+'</p>'; para=[]; } };
    const flushList=()=>{ if(list){ out+='<ul>'+list.map(li=>'<li>'+mdInline(li)+'</li>').join('')+'</ul>'; list=null; } };
    for(const line of lines){
      if(code!==null){ if(/^```/.test(line)){ out+='<pre><code>'+code.join('\n')+'</code></pre>'; code=null; } else code.push(line); continue; }
      if(/^```/.test(line)){ flushPara(); flushList(); code=[]; continue; }
      const h=line.match(/^(#{1,3})\s+(.*)$/);
      if(h){ flushPara(); flushList(); const n=h[1].length; out+=`<h${n}>`+mdInline(h[2])+`</h${n}>`; continue; }
      const b=line.match(/^-\s+(.*)$/);
      if(b){ flushPara(); if(!list)list=[]; list.push(b[1]); continue; }
      if(!line.trim()){ flushPara(); flushList(); continue; }
      flushList(); para.push(line);
    }
    if(code!==null) out+='<pre><code>'+code.join('\n')+'</code></pre>';
    flushPara(); flushList();
    return out;
  }
  function renderNote(body, spec){
    const note=document.createElement('div'); note.className='wg-md';
    note.innerHTML=mdToHtml(spec.text||''); body.appendChild(note);
  }

  // ── HTML: url → app iframe; inline html → sandboxed srcdoc (never innerHTML) ──
  function renderHtml(body, spec){
    if(spec.url){ renderApp(body, spec); return; }
    if(typeof spec.html==='string' && spec.html){
      const f=document.createElement('iframe'); f.className='wg-app';
      f.setAttribute('sandbox','allow-scripts');
      // CSP inside the sandbox: inline-only, no network — model-authored code
      // can compute and draw, never call out. (MCP Apps 2026-01-26 contract.)
      f.srcdoc='<!doctype html>'+'<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\'; style-src \'unsafe-inline\'; img-src data:;">'+spec.html; body.appendChild(f); return;
    }
    const e=document.createElement('div'); e.className='wg-empty'; e.textContent='Nothing to show.'; body.appendChild(e);
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

  // ── Home (live device dashboard; user taps a tile, agent drives it too) ──
  // Stroked SVG icons per HA domain — same visual language as the shell's
  // chrome (the emoji set read as off-brand and grayscaled to mud).
  const HOME_ICONS={
    speaker:'<rect x="6" y="3" width="12" height="18" rx="2.5"/><circle cx="12" cy="14.5" r="3.5"/><circle cx="12" cy="7.5" r="1.2"/>',
    light:'<path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-4 10.5c.6.5 1 1.5 1 2.5h6c0-1 .4-2 1-2.5A6 6 0 0 0 12 3z"/>',
    switch:'<path d="M12 3v9"/><path d="M6.6 6.6a8 8 0 1 0 10.8 0"/>',
    fan:'<circle cx="12" cy="12" r="2"/><path d="M12 10c0-3 1.5-6 4-6 2 0 3 1.5 3 3 0 2.5-3 3-7 3zM12 14c0 3-1.5 6-4 6-2 0-3-1.5-3-3 0-2.5 3-3 7-3zM10 12c-3 0-6-1.5-6-4 0-2 1.5-3 3-3 2.5 0 3 3 3 7zM14 12c3 0 6 1.5 6 4 0 2-1.5 3-3 3-2.5 0-3-3-3-7z"/>',
    lock:'<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
    cover:'<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M4 9h16M4 13h16"/>',
    media_player:'<rect x="3" y="5" width="18" height="12" rx="2"/><path d="M9 21h6"/><path d="m10 9 4 2-4 2z"/>',
    vacuum:'<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/><path d="M12 4v2"/>',
    climate:'<path d="M14 14.8V5a2 2 0 1 0-4 0v9.8a4 4 0 1 0 4 0z"/>',
    sensor:'<path d="M3 12h4l2-6 4 12 2-6h6"/>',
    binary_sensor:'<circle cx="12" cy="12" r="2"/><path d="M8 8a6 6 0 0 0 0 8M16 8a6 6 0 0 1 0 8"/>',
    camera:'<rect x="3" y="7" width="13" height="10" rx="2"/><path d="m16 11 5-3v8l-5-3z"/>',
    scene:'<path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/>',
  };
  function homeIcon(domain){
    const p=HOME_ICONS[domain]||'<circle cx="12" cy="12" r="3"/>';
    return `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
  }
  function renderHome(body, spec, wg){
    const wrap=document.createElement('div'); wrap.className='wg-home';
    const devices=spec.devices||[];
    if(!devices.length){ const e=document.createElement('div'); e.className='wg-empty'; e.textContent='No devices yet — connect Home Assistant in Settings.'; body.appendChild(e); return; }
    // Group by room (area) when HA provides areas; 'Other' last. Within a
    // group: actionable things first, passive sensors last.
    const rank=d=>d.controllable?0:(d.domain==='media_player'||d.domain==='vacuum'||d.domain==='climate'?1:2);
    const byArea=new Map();
    for(const d of devices){ const a=d.area||'Other'; (byArea.get(a)||byArea.set(a,[]).get(a)).push(d); }
    const areas=[...byArea.keys()].sort((a,b)=>(a==='Other')-(b==='Other')||a.localeCompare(b));
    const sorted=[]; const headerAt=new Map();
    for(const a of areas){
      if(byArea.size>1) headerAt.set(sorted.length, a);
      sorted.push(...byArea.get(a).sort((x,y)=>rank(x)-rank(y)||String(x.name).localeCompare(String(y.name))));
    }
    const grid=document.createElement('div'); grid.className='wg-home-grid';
    sorted.forEach((d,idx)=>{
      if(headerAt.has(idx)){ const h=document.createElement('div'); h.className='wg-area-h span'; h.textContent=headerAt.get(idx); grid.appendChild(h); }
      const card=document.createElement('div');
      card.className='wg-home-card'+(d.on===true?' on':'')+(d.controllable?' ctl':'')+(d.on===undefined?' passive':'');
      if(d.controllable){ card.tabIndex=0; card.setAttribute('role','button'); }
      const ic=document.createElement('div'); ic.className='ic'; ic.innerHTML=homeIcon(d.domain);
      const nm=document.createElement('div'); nm.className='nm'; nm.textContent=d.name||''; nm.title=d.name||'';
      const st=document.createElement('div'); st.className='st'; st.textContent=d.sub||d.state||'';
      card.appendChild(ic); card.appendChild(nm); card.appendChild(st);
      if(d.controllable && d.entity_id){
        card.title='Tap to toggle';
        const toggle=async()=>{
          if(card.classList.contains('busy')) return;
          card.classList.add('busy');
          try{
            const r=await fetch('/v1/home/control',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({entity_id:d.entity_id,action:'toggle'})});
            if(r.ok){ d.on=(d.on===true)?false:true; card.classList.toggle('on', d.on===true);
              st.textContent = d.domain==='lock' ? (d.on?'locked':'unlocked') : d.domain==='cover' ? (d.on?'open':'closed') : (d.on?'on':'off'); }
            else toast('Couldn’t control '+(d.name||'device'));
          }catch{ toast('Couldn’t reach the server'); }
          card.classList.remove('busy');
        };
        card.onclick=toggle;
        card.onkeydown=e=>{ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); toggle(); } };
      }
      grid.appendChild(card);
    });
    wrap.appendChild(grid); body.appendChild(wrap);
    // Live refresh while the widget is active — device state changes from
    // anywhere (HA app, physical switch) show up within 30s.
    if(wg){
      if(wg._homeTimer) clearInterval(wg._homeTimer);
      wg._homeTimer=setInterval(async()=>{
        if(!document.contains(wg)){ clearInterval(wg._homeTimer); wg._homeTimer=null; return; }
        if(wg._state!=='active') return;
        try{
          const d=await (await fetch('/v1/home/devices',{credentials:'same-origin'})).json();
          if(Array.isArray(d.devices)&&d.devices.length){ const b=wg.querySelector('.wg-body'); if(b){ b.innerHTML=''; renderHome(b,{...wg._spec,devices:d.devices},wg); } }
        }catch{}
      }, 30000);
    }
  }

  // ── Custom widget plugins (runtime, no recompile) ──
  const _plugins = {};
  async function loadPlugins(){
    try{ const d=await (await fetch('/v1/widgets/plugins',{credentials:'same-origin'})).json();
      for(const p of (d.plugins||[])) if(p&&p.type) _plugins[p.type]=p;
    }catch{}
  }
  async function renderPlugin(body, spec, plugin){
    // v0.2 §14: plugin code runs in a sandboxed iframe served with its own
    // CSP (no network, no inline script surprises); the spec crosses the
    // boundary only by postMessage. srcdoc is unusable here — it inherits
    // the console's CSP, which forbids inline scripts.
    const f=document.createElement('iframe'); f.className='wg-app';
    f.setAttribute('sandbox','allow-scripts');
    f.src='/v1/widgets/frame?plugin='+encodeURIComponent(plugin.id);
    const send=()=>{ try{ f.contentWindow.postMessage({type:'orb-spec', spec}, '*'); }catch(_){} };
    const onMsg=(e)=>{
      if(!f.isConnected){ window.removeEventListener('message', onMsg); return; }
      if(e.source===f.contentWindow && e.data && e.data.type==='orb-ready') send();
    };
    window.addEventListener('message', onMsg);
    f.addEventListener('load', send);
    body.appendChild(f);
  }
  function renderTable(body, spec){
    const cols=spec.columns||[], rows=spec.rows||[];
    if(!cols.length && !rows.length){ const e=document.createElement('div'); e.className='wg-empty'; e.textContent='No data.'; body.appendChild(e); return; }
    const t=document.createElement('table'); t.className='wg-table';
    if(cols.length){ const thead=document.createElement('thead'); const tr=document.createElement('tr');
      cols.forEach(c=>{ const th=document.createElement('th'); const s=c==null?'':String(c); th.textContent=s; th.title=s; tr.appendChild(th); });
      thead.appendChild(tr); t.appendChild(thead); }
    const tb=document.createElement('tbody');
    // Numeric detection covers currency/percent/thousands ("$62.10", "1,204", "38%").
    const isNum=s=>{ const v=s.trim().replace(/^[$€£]|[%,]/g,''); return v!=='' && Number.isFinite(Number(v)); };
    const numCount=new Array(cols.length||0).fill(0);
    rows.forEach(r=>{ const tr=document.createElement('tr'); (Array.isArray(r)?r:[r]).forEach((c,i)=>{
      const td=document.createElement('td'); const s=c==null?'':String(c); td.textContent=s; td.title=s;
      if(isNum(s)){ td.classList.add('num'); if(i<numCount.length) numCount[i]++; }
      tr.appendChild(td); }); tb.appendChild(tr); });
    // Headers align with their column's data — a right-aligned number under a
    // left-aligned header reads broken.
    if(cols.length && rows.length){ const ths=t.querySelectorAll('th');
      numCount.forEach((n,i)=>{ if(n>=rows.length/2 && ths[i]) ths[i].classList.add('num'); }); }
    t.appendChild(tb); body.appendChild(t);
  }
  function renderStats(body, spec){
    const stats=spec.stats||[];
    if(!stats.length){ const e=document.createElement('div'); e.className='wg-empty'; e.textContent='No stats yet.'; body.appendChild(e); return; }
    const g=document.createElement('div'); g.className='wg-stats';
    stats.forEach(s=>{ const c=document.createElement('div'); c.className='wg-stat';
      c.innerHTML=`<div class="wg-stat-v">${esc2(s.value)}</div><div class="wg-stat-l">${esc2(s.label)}</div>${s.sub?`<div class="wg-stat-s">${esc2(s.sub)}</div>`:''}`; g.appendChild(c); });
    body.appendChild(g);
  }
  function renderGallery(body, spec){
    const ims=spec.images||[];
    if(!ims.length){ const e=document.createElement('div'); e.className='wg-empty'; e.textContent='No images.'; body.appendChild(e); return; }
    const g=document.createElement('div'); g.className='wg-gallery';
    ims.forEach((im,i)=>{ const fig=document.createElement('div'); fig.className='wg-gitem';
      fig.innerHTML=`<img src="${esc2(im.url)}" loading="lazy" alt="${esc2(im.caption||im.alt||spec.title||('Image '+(i+1)))}" onerror="this.style.visibility='hidden'"/>${im.caption?`<span>${esc2(im.caption)}</span>`:''}`;
      fig.onclick=()=>spawnWidget({type:'image',title:im.caption||'Image',url:im.url,caption:im.caption}); g.appendChild(fig); });
    body.appendChild(g);
  }
  // Only http(s) URLs from specs may reach iframes/window.open — an empty or
  // relative src loads the whole console into the widget; other schemes are
  // worse. Relative /v1/workspace paths (the agent's own canvas) are allowed.
  function safeUrl(u){
    const s=String(u||'');
    if(/^https?:\/\//i.test(s)) return s;
    // Same-origin surfaces widgets legitimately load from: workspace files,
    // published pages, the authed HA image proxy, and bundled assets.
    if(s.startsWith('/v1/workspace/')||s.startsWith('/pub/')||s.startsWith('/v1/home/ha-image')||s.startsWith('/assets/')) return s;
    return null;
  }
  function safeHost(u, hosts){
    try{ const h=new URL(u).hostname; return hosts.some(x=>h===x||h.endsWith('.'+x)); }catch{ return false; }
  }
  function renderImage(body, spec){
    const src=safeUrl(spec.url);
    if(!src){ const e=document.createElement('div'); e.className='wg-empty'; e.textContent='No image.'; body.appendChild(e); return; }
    const i=document.createElement('img'); i.className='wg-image'; i.src=src; i.alt=spec.caption||spec.title||'';
    i.onerror=()=>{ i.replaceWith(Object.assign(document.createElement('div'),{className:'wg-empty',textContent:'Image failed to load.'})); };
    body.appendChild(i);
    if(spec.caption){ const c=document.createElement('div'); c.className='wg-it-sub'; c.style.marginTop='6px'; c.textContent=spec.caption; body.appendChild(c); }
  }
  function renderEmbed(body, spec){
    const url=safeUrl(spec.url);
    if(!url){ const e=document.createElement('div'); e.className='wg-empty'; e.textContent='Nothing to embed.'; body.appendChild(e); return; }
    const ok=safeHost(url, ['sketchfab.com','openstreetmap.org','youtube.com','youtube-nocookie.com','player.vimeo.com','codesandbox.io']) || url.startsWith('/');
    if(ok){ const f=document.createElement('iframe'); f.className='wg-app'; f.setAttribute('sandbox','allow-scripts allow-same-origin allow-forms allow-popups'); f.src=url; f.setAttribute('allow','autoplay; fullscreen; xr-spatial-tracking; encrypted-media'); f.setAttribute('allowfullscreen',''); body.appendChild(f); }
    else { const a=document.createElement('a'); a.href=url; a.target='_blank'; a.rel='noopener'; a.className='set-url'; a.textContent='Open ↗ '+url; body.appendChild(a); }
  }
  function renderModel(body, spec){
    const src=safeUrl(spec.url);
    if(!src){ body.innerHTML='<div class="wg-empty">No model to show.</div>'; return; }
    const mv=document.createElement('model-viewer');
    mv.className='wg-model';
    mv.addEventListener('error',()=>{ mv.replaceWith(Object.assign(document.createElement('div'),{className:'wg-empty',textContent:'Model failed to load.'})); });
    mv.setAttribute('src', src);
    mv.setAttribute('camera-controls','');
    mv.setAttribute('auto-rotate','');
    mv.setAttribute('shadow-intensity','1');
    mv.setAttribute('environment-image','neutral');
    mv.setAttribute('ar','');
    mv.setAttribute('touch-action','pan-y');
    mv.setAttribute('loading','eager');
    body.appendChild(mv);
    // toolbar: turntable, snapshot, fullscreen — plus real-world size when known
    const bar=document.createElement('div'); bar.className='wg-model-bar';
    const mkBtn=(svg,label,fn)=>{ const b=document.createElement('button'); b.className='wg-med-btn sm'; b.title=label; b.setAttribute('aria-label',label);
      b.innerHTML=`<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${svg}</svg>`; b.onclick=fn; return b; };
    let spinning=true;
    const rot=mkBtn('<path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v5h-5"/>','Turntable',()=>{ spinning=!spinning; if(spinning) mv.setAttribute('auto-rotate',''); else mv.removeAttribute('auto-rotate'); rot.classList.toggle('off',!spinning); });
    const snap=mkBtn('<rect x="3" y="7" width="18" height="13" rx="2"/><circle cx="12" cy="13.5" r="3.5"/><path d="M9 7l1.2-2h3.6L15 7"/>','Snapshot',async()=>{ try{ const url=await mv.toDataURL('image/png'); const a=document.createElement('a'); a.href=url; a.download=(spec.title||'model')+'.png'; a.click(); }catch{ toast('Snapshot failed'); } });
    const fs=mkBtn('<path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5"/>','Fullscreen',()=>{ const host=body.closest('.wg')||body; if(document.fullscreenElement) document.exitFullscreen(); else host.requestFullscreen?.(); });
    bar.append(rot,snap,fs);
    if(spec.dims){ const d=document.createElement('span'); d.className='wg-model-dims';
      d.textContent=spec.dims+(spec.watertight===false?' · not watertight':''); bar.appendChild(d); }
    body.appendChild(bar);
  }
  // ── Calculator (fully interactive, no backend) ──
  // Safe expression evaluator: tokenize digits/./+-*/()% and recursive-descent
  // parse — no eval/Function. `%` is a postfix "divide this operand by 100".
  function calcEval(src){
    const clean=src.replace(/\s+/g,'');
    const toks=clean.match(/\d+\.?\d*|\.\d+|[+\-*\/()%]/g)||[];
    if(toks.join('')!==clean) throw new Error('bad expression');
    let i=0;
    const peek=()=>toks[i];
    function expr(){ let v=term(); while(peek()==='+'||peek()==='-'){ const op=toks[i++]; const r=term(); v = op==='+'? v+r : v-r; } return v; }
    function term(){ let v=factor(); while(peek()==='*'||peek()==='/'){ const op=toks[i++]; const r=factor(); v = op==='*'? v*r : v/r; } return v; }
    function factor(){ if(peek()==='-'){ i++; return -factor(); } if(peek()==='+'){ i++; return factor(); } return primary(); }
    function primary(){
      let v;
      if(peek()==='('){ i++; v=expr(); if(toks[i++]!==')') throw new Error('unbalanced parens'); }
      else { const t=toks[i++]; if(t==null||!/^[\d.]/.test(t)) throw new Error('expected number'); v=parseFloat(t); }
      while(peek()==='%'){ i++; v=v/100; }
      return v;
    }
    const v=expr();
    if(i<toks.length) throw new Error('trailing tokens');
    if(!Number.isFinite(v)) throw new Error('not finite');
    return v;
  }
  function renderCalculator(body, spec){
    const wrap=document.createElement('div'); wrap.className='wg-calc'; wrap.tabIndex=0;
    const out=document.createElement('div'); out.className='wg-calc-out'; out.textContent='0';
    const keys=['C','±','%','÷','7','8','9','×','4','5','6','−','1','2','3','+','0','.','='];
    const grid=document.createElement('div'); grid.className='wg-calc-grid';
    let expr='', justEvaled=false;
    const sym={'÷':'/','×':'*','−':'-','+':'+'};
    const toJs=e=>e.replace(/[÷×−]/g, m=>sym[m]);
    const fmt=v=>String(parseFloat(v.toPrecision(12)));   // kill float dust (0.30000000000000004 → 0.3)
    const show=v=>{ out.textContent = (v.length>12? v.slice(0,12) : v) || '0'; };
    const press=(k)=>{
      try{
        if(k==='C'){ expr=''; justEvaled=false; show('0'); return; }
        if(k==='⌫'){ expr=expr.slice(0,-1); justEvaled=false; show(expr); return; }
        if(k==='±'){ if(expr) expr = expr.startsWith('-')? expr.slice(1) : '-'+expr; show(expr); return; }
        if(k==='='){ if(expr){ const r=fmt(calcEval(toJs(expr))); show(r); expr=r; justEvaled=true; } return; }
        if(justEvaled && !'÷×−+%'.includes(k)){ expr=''; }
        justEvaled=false; expr+=k; show(expr);
      }catch{ show('Error'); expr=''; justEvaled=false; }
    };
    keys.forEach(k=>{
      const b=document.createElement('button'); b.className='wg-calc-key'; b.textContent=k;
      if('÷×−+='.includes(k)) b.classList.add('op'); if(k==='C') b.classList.add('clr');
      if(k==='0') b.classList.add('zero');
      b.onclick=()=>press(k);
      grid.appendChild(b);
    });
    // Keyboard input while the widget has focus (digits, ops, Enter/Esc/Backspace).
    wrap.addEventListener('keydown',(e)=>{
      if(e.metaKey||e.ctrlKey||e.altKey) return;
      const map={'/':'÷','*':'×','-':'−','+':'+','%':'%','.':'.','(':'(',')':')','Enter':'=','=':'=','Escape':'C','Backspace':'⌫'};
      const k=/^\d$/.test(e.key)? e.key : map[e.key];
      if(k==null) return;
      e.preventDefault(); press(k);
    });
    wrap.addEventListener('pointerup',()=>{ if(!wrap.contains(document.activeElement)) wrap.focus(); });
    wrap.append(out, grid); body.appendChild(wrap);
  }

  // ── Weather (renders data the agent provides; wire to an API later) ──
  function renderWeather(body, spec){
    if(!spec.current){ const e=document.createElement('div'); e.className='wg-empty'; e.textContent='No weather data yet.'; body.appendChild(e); return; }
    const w=document.createElement('div'); w.className='wg-weather';
    const cur=spec.current||{};
    const u=String(spec.unit||spec.units||'').toLowerCase();
    const unit=(u==='c'||u==='celsius'||u==='metric')?'°C':'°F';
    const ic=weatherIcon(cur.condition||cur.icon||'');
    w.innerHTML=`<div class="wg-wx-loc">${esc2(spec.location||'—')}</div>
      <div class="wg-wx-now"><span class="wg-wx-ic">${ic}</span><span class="wg-wx-temp">${cur.temp!=null?esc2(cur.temp)+'<span class="u">'+unit+'</span>':'—'}</span></div>
      <div class="wg-wx-cond">${esc2(cur.condition||'')}</div>
      <div class="wg-wx-meta">${cur.humidity!=null?'<span class="mi">'+dropIcon+'</span> '+esc2(cur.humidity)+'%':''}${cur.wind!=null?' · <span class="mi">'+windIcon+'</span> '+esc2(cur.wind)+' '+(unit==='°C'?'km/h':'mph'):''}</div>`;
    if(Array.isArray(spec.forecast)&&spec.forecast.length){
      const f=document.createElement('div'); f.className='wg-wx-fc';
      spec.forecast.slice(0,6).forEach(d=>{ const c=document.createElement('div'); c.className='wg-wx-day';
        c.innerHTML=`<span>${esc2(d.day||'')}</span><span class="i">${weatherIcon(d.condition||'')}</span><span class="t">${d.high!=null?esc2(d.high)+'°':''}${d.low!=null?' <em>'+esc2(d.low)+'°</em>':''}</span>`; f.appendChild(c); });
      w.appendChild(f);
    }
    body.appendChild(w);
  }
  // Weather icons in the console's own stroke language — one family, one
  // weight, monochrome (no emoji: they clash and render inconsistently).
  function weatherIcon(c){ c=(c||'').toLowerCase();
    const s=(p)=>`<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
    const CLOUD='M17.5 18H7a4 4 0 1 1 .6-7.96A5.5 5.5 0 0 1 18 8.7 3.9 3.9 0 0 1 17.5 18z';
    if(/storm|thunder/.test(c))return s(`<path d="${CLOUD}"/><path d="m12 20 2-3h-3l2-3"/>`);
    if(/snow|sleet|flurr/.test(c))return s(`<path d="${CLOUD}"/><path d="M9 21v.5M13 21v.5M11 23v.5"/>`);
    if(/rain|drizzle|shower/.test(c))return s(`<path d="${CLOUD}"/><path d="M9 20v2M13 20v2M16 19v2"/>`);
    if(/fog|mist|haze/.test(c))return s('<path d="M4 10h16M3 14h18M5 18h14"/>');
    if(/part/.test(c))return s(`<circle cx="8" cy="8" r="3"/><path d="M8 2v1.5M2 8h1.5M3.8 3.8l1 1"/><path d="M18.5 20H10a3.5 3.5 0 1 1 .5-6.96A4.8 4.8 0 0 1 19.7 12 3.4 3.4 0 0 1 18.5 20z"/>`);
    if(/cloud|overcast/.test(c))return s(`<path d="${CLOUD}"/>`);
    if(/clear|sun|hot/.test(c))return s('<circle cx="12" cy="12" r="4"/><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8"/>');
    return s('<path d="M14 14.8V5a2 2 0 1 0-4 0v9.8a4 4 0 1 0 4 0z"/>'); }
  const dropIcon='<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3s6 6.3 6 10.5a6 6 0 0 1-12 0C6 9.3 12 3 12 3z"/></svg>';
  const windIcon='<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8h11a2.5 2.5 0 1 0-2.5-2.5M3 12h15a2.5 2.5 0 1 1-2.5 2.5M3 16h8a2 2 0 1 1-2 2"/></svg>';
  const houseIcon='<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/></svg>';
  const checkIcon='<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m4 12.5 5 5L20 6.5"/></svg>';

  // ── Calendar (month grid + agenda; wire to Google Calendar later) ──
  function renderCalendar(body, spec){
    const now=new Date();
    const ym=(spec.month||'').match(/^(\d{4})-(\d{2})/);
    let year=ym?+ym[1]:now.getFullYear(), mon=ym?(+ym[2]-1):now.getMonth();
    const off=spec._monthOffset|0;
    if(off){ const d=new Date(year,mon+off,1); year=d.getFullYear(); mon=d.getMonth(); }
    const events=(spec.events||[]).reduce((m,e)=>{ const d=(e.date||'').slice(0,10); (m[d]=m[d]||[]).push(e); return m; },{});
    const c=document.createElement('div'); c.className='wg-cal';
    const first=new Date(year,mon,1), days=new Date(year,mon+1,0).getDate(), pad=first.getDay();
    const head=document.createElement('div'); head.className='wg-cal-head';
    const nav=(txt,delta,label)=>{ const b=document.createElement('button'); b.className='wg-cal-nav'; b.setAttribute('aria-label',label);
      b.innerHTML=txt;
      b.onclick=()=>{ body.innerHTML=''; renderCalendar(body,{...spec,_monthOffset:off+delta}); };
      return b; };
    head.appendChild(nav('<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>',-1,'Previous month'));
    const title=document.createElement('span'); title.textContent=first.toLocaleString(undefined,{month:'long',year:'numeric'});
    if(off){ title.style.cursor='pointer'; title.title='Back to this month'; title.onclick=()=>{ body.innerHTML=''; renderCalendar(body,{...spec,_monthOffset:0}); }; }
    head.appendChild(title);
    head.appendChild(nav('<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>',1,'Next month'));
    c.appendChild(head);
    const grid=document.createElement('div'); grid.className='wg-cal-grid';
    // Locale weekday labels (Sunday-first grid; 2023-01-01 was a Sunday).
    for(let i=0;i<7;i++){ const h=document.createElement('div'); h.className='wg-cal-dow';
      h.textContent=new Date(2023,0,1+i).toLocaleDateString(undefined,{weekday:'narrow'}); grid.appendChild(h); }
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
    const evAll=(spec.events||[]).filter(e=>e.title);
    const upcoming=evAll.slice(0,4);
    if(upcoming.length){ const ag=document.createElement('div'); ag.className='wg-cal-agenda';
      upcoming.forEach(e=>{ const r=document.createElement('div'); r.className='wg-cal-ev';
        r.innerHTML=`<span class="d">${esc2((e.date||'').slice(5,10))}</span><span class="ti">${esc2(e.time||'')}</span><span class="t">${esc2(e.title||'')}</span>`; ag.appendChild(r); });
      if(evAll.length>4){ const more=document.createElement('div'); more.className='wg-cal-more'; more.textContent='+'+(evAll.length-4)+' more'; ag.appendChild(more); }
      c.appendChild(ag);
    }
    body.appendChild(c);
  }

  // ── Code (self-contained highlighter — CSP-safe, no CDN) ──
  const HL_KW={
    js:'const let var function return if else for while do switch case break continue import export from new class extends implements interface type enum async await yield typeof instanceof in of delete void this super try catch finally throw static get set default public private protected readonly true false null undefined',
    python:'def class return if elif else for while break continue pass import from as with try except finally raise lambda global nonlocal yield assert del in is not and or async await self True False None',
    bash:'if then else elif fi for while until do done case esac in function select time export local readonly declare unset shift return exit trap set eval source alias echo printf read',
    json:'true false null',
  };
  HL_KW.ts=HL_KW.js+' any unknown never namespace declare abstract keyof infer satisfies';
  function hlKeywords(lang){
    const l=String(lang||'').toLowerCase();
    if(l==='python'||l==='py') return HL_KW.python;
    if(l==='bash'||l==='sh'||l==='shell'||l==='zsh') return HL_KW.bash;
    if(l==='json') return HL_KW.json;
    if(l==='ts'||l==='typescript'||l==='tsx') return HL_KW.ts;
    return HL_KW.js;   // fallback: js set
  }
  function hlCode(code, lang){
    const kw=hlKeywords(lang).trim().split(/\s+/).join('|');
    const RE=new RegExp(
      /(\/\/[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/|--[^\n]*)/.source
      +'|'+/(`(?:\\.|[^`\\])*`|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/.source
      +'|'+/\b(0x[\da-fA-F]+|\d+\.?\d*)\b/.source
      +'|\\b('+kw+')\\b','g');
    let out='',last=0,m; const e=s=>esc2(s);
    while((m=RE.exec(code))){ out+=e(code.slice(last,m.index));
      const cls=m[1]?'c-cm':m[2]?'c-st':m[3]?'c-nu':'c-kw';
      out+=`<span class="${cls}">${e(m[0])}</span>`; last=m.index+m[0].length; }
    out+=e(code.slice(last)); return out;
  }
  function renderCode(body, spec){
    const full=String(spec.code||spec.text||''); const lang=spec.language||spec.lang||'';
    const MAX=200000;
    const truncated=full.length>MAX;
    const code=truncated? full.slice(0,MAX) : full;
    const wrap=document.createElement('div'); wrap.className='wg-code';
    const bar=document.createElement('div'); bar.className='wg-code-bar';
    bar.innerHTML=`<span class="lang">${esc2(spec.filename||lang||'code')}</span>`;
    const cp=document.createElement('button'); cp.className='wg-code-copy'; cp.textContent='Copy';
    cp.onclick=async()=>{
      try{ await navigator.clipboard.writeText(full); cp.textContent='Copied'; }
      catch{ cp.textContent='Copy failed'; }
      setTimeout(()=>cp.textContent='Copy',1200);
    };
    bar.appendChild(cp);
    const pre=document.createElement('pre'); pre.className='wg-code-pre';
    const lines=code.split('\n');
    const gutter=lines.map((_,i)=>i+1).join('\n');
    pre.innerHTML=`<span class="wg-code-ln">${gutter}</span><code>${hlCode(code, lang)}</code>`;
    wrap.append(bar, pre);
    if(truncated){ const n=document.createElement('div'); n.className='wg-code-trunc';
      n.textContent=`Truncated — showing the first ${MAX.toLocaleString()} of ${full.length.toLocaleString()} characters. Copy grabs the full text.`; wrap.appendChild(n); }
    body.appendChild(wrap);
  }

  // ── Docker (live micro-app: list + user/agent control) ──
  function renderDocker(body, spec){
    if(!(spec.containers||[]).length){ body.innerHTML='<div class="wg-empty">No containers running.</div>'; return; }
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
    // Tolerate the coordinate shapes models actually emit: lng / lon / longitude.
    const num=v=>{ const n=Number(v); return Number.isFinite(n)?n:null; };
    // Reject "Null Island" (0,0 ± noise) — it's a model hallucination, not a place.
    const real=(lat,lng)=>!(Math.abs(lat)<0.5&&Math.abs(lng)<0.5);
    const pt=m=>{ if(!m) return null; const lat=num(m.lat!=null?m.lat:m.latitude), lng=num(m.lng!=null?m.lng:(m.lon!=null?m.lon:m.longitude)); return (lat==null||lng==null||!real(lat,lng))?null:[lat,lng]; };
    const mk=(spec.markers||[]).map(m=>({p:pt(m), label:m&&m.label})).filter(m=>m.p);
    const route=(Array.isArray(spec.route)?spec.route:[]).map(p=>Array.isArray(p)?[num(p[0]),num(p[1])]:null).filter(p=>p&&p[0]!=null&&p[1]!=null);
    if(!mk.length && !route.length && !spec.center){ const e=document.createElement('div'); e.className='wg-note'; e.textContent='Nothing to map yet.'; body.appendChild(e); el.remove(); return; }
    const center = (Array.isArray(spec.center)&&pt({lat:spec.center[0],lng:spec.center[1]})) || (mk[0]&&mk[0].p) || route[0] || [40.4168,-3.7038];
    const map = L.map(el, { zoomControl:true }).setView(center, spec.zoom||12);
    map.attributionControl.setPrefix(false);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom:19, attribution:'© OpenStreetMap' }).addTo(map);
    const bounds=[];
    mk.forEach(m=>{ const k=L.marker(m.p).addTo(map); if(m.label) k.bindPopup(esc2(m.label)); bounds.push(m.p); });
    if(route.length>1){ L.polyline(route,{color:'#76b900',weight:5,opacity:.9}).addTo(map); route.forEach(p=>bounds.push(p)); }
    // The widget is attached before render, so sizes are real — but the card's
    // entrance animation can still settle; sync once now and once next frame.
    try{ map.invalidateSize(); }catch{}
    if(bounds.length>1){ try{ map.fitBounds(bounds,{padding:[28,28]}); }catch{} }
    requestAnimationFrame(()=>{ try{ map.invalidateSize(); if(bounds.length>1) map.fitBounds(bounds,{padding:[28,28]}); }catch{} });
    if(wg){ if(wg._map){ try{wg._map.remove();}catch{} } wg._map=map;
      if(wg._mapRo){ try{wg._mapRo.disconnect();}catch{} wg._mapRo=null; }
      if(window.ResizeObserver){ wg._mapRo=new ResizeObserver(()=>{ try{ wg._map&&wg._map.invalidateSize(); }catch{} }); wg._mapRo.observe(el); }
    }
  }

  // ── Mail (inbox preview; wire to Gmail/Outlook later) ──
  function renderMail(body, spec){
    const list=document.createElement('div'); list.className='wg-mail';
    (spec.messages||[]).forEach(m=>{ const r=document.createElement('div'); r.className='wg-mail-row'+(m.unread?' unread':'');
      r.innerHTML=`<div class="wg-mail-top"><span class="from">${esc2(m.from||'')}</span><span class="date">${esc2(m.date||'')}</span></div>
        <div class="subj">${esc2(m.subject||'')}</div><div class="snip">${esc2(m.snippet||m.preview||'')}</div>`;
      const mu=safeUrl(m.url); if(mu){ r.style.cursor='pointer'; r.onclick=()=>window.open(mu,'_blank','noopener'); }
      list.appendChild(r); });
    if(!(spec.messages||[]).length){ list.innerHTML='<div class="wg-empty">No messages.</div>'; }
    body.appendChild(list);
  }

  // ── Vercel deployments (wire to the Vercel connector later) ──
  // Relative time for timestamps ("3h ago"); falls back to the raw value.
  function relTime(v){
    let t = typeof v==='number' ? v : (/^\d+$/.test(String(v)) ? Number(v) : Date.parse(v));
    if(!Number.isFinite(t)) return String(v==null?'':v);
    const s=Math.round((Date.now()-t)/1000);
    if(s<45) return 'just now';
    const m=Math.round(s/60); if(m<60) return m+'m ago';
    const h=Math.round(m/60); if(h<24) return h+'h ago';
    const d=Math.round(h/24); if(d<30) return d+'d ago';
    return new Date(t).toLocaleDateString();
  }
  function renderVercel(body, spec){
    const deps=spec.deployments||(spec.deployment?[spec.deployment]:[]);
    const list=document.createElement('div'); list.className='wg-vercel';
    deps.forEach(d=>{ const st=(d.state||d.readyState||'').toLowerCase();
      const cls=/ready|success/.test(st)?'ok':/build|queu|pending/.test(st)?'warn':/error|fail|cancel/.test(st)?'err':'';
      const r=document.createElement('div'); r.className='wg-vc-row';
      r.innerHTML=`<span class="dot ${cls}"></span><div class="grow"><div class="nm">${esc2(d.name||d.url||'deploy')}</div><div class="mt">${esc2(d.branch||'')}${d.created?' · '+esc2(relTime(d.created)):''}</div></div><span class="st ${cls}">${esc2((st?st.charAt(0).toUpperCase()+st.slice(1):''))}</span>`;
      const du=safeUrl(/^https?:\/\//i.test(d.url||'')?d.url:'https://'+d.url); if(du){ r.style.cursor='pointer'; r.onclick=()=>window.open(du,'_blank','noopener'); }
      list.appendChild(r); });
    if(!deps.length){ list.innerHTML='<div class="wg-empty">No deployments.</div>'; }
    body.appendChild(list);
  }

  function renderApp(body, spec){
    const src=safeUrl(spec.url);
    if(!src){ const e=document.createElement('div'); e.className='wg-empty'; e.textContent='Nothing to show.'; body.appendChild(e); return; }
    const f=document.createElement('iframe'); f.className='wg-app';
    f.setAttribute('sandbox','allow-scripts allow-same-origin allow-forms allow-popups allow-modals');
    f.src=src; body.appendChild(f);
    f.addEventListener('load',()=>{ try{ const t=f.contentDocument&&f.contentDocument.title; if(t&&!spec.title){ const tt=body.parentElement&&body.parentElement.querySelector('.wg-title'); if(tt) tt.textContent=t; } }catch{} });
  }
  function renderChart(body, spec, wg){
    if(typeof Chart==='undefined'){ body.textContent='chart library not loaded'; return; }
    const dsIn=spec.datasets||[], labels=spec.labels||[];
    if(!dsIn.length && !labels.length){ const e=document.createElement('div'); e.className='wg-empty'; e.textContent='No data to chart yet.'; body.appendChild(e); return; }
    // Theme colors at render time (fall back to the :root values).
    const cs=getComputedStyle(document.documentElement);
    const cvar=(n,fb)=>{ const v=(cs.getPropertyValue(n)||'').trim(); return v||fb; };
    const nv=cvar('--nv','#76b900'), tick=cvar('--ink-dim','#93a08f'), gridc=cvar('--line','rgba(255,255,255,.08)');
    const pal=[nv, ...PALETTE.slice(1)];
    const wrap=document.createElement('div'); wrap.className='wg-chart';
    const cv=document.createElement('canvas'); wrap.appendChild(cv); body.appendChild(wrap);
    const pie = spec.chart_type==='pie'||spec.chart_type==='doughnut';
    const datasets=dsIn.map((dd,i)=>({
      label: dd.label||('Series '+(i+1)), data: dd.data||[],
      backgroundColor: pie?pal:pal[i%pal.length],
      borderColor: pal[i%pal.length], borderWidth:1.5, fill:false, tension:.3,
    }));
    const chart = new Chart(cv.getContext('2d'), {
      type: spec.chart_type||'bar',
      data: { labels, datasets },
      options: { responsive:true, maintainAspectRatio:false, plugins:{ legend:{ labels:{ color:tick, font:{size:11}, boxWidth:12 } } },
        scales: pie?{}:{ x:{ ticks:{color:tick}, grid:{color:gridc} }, y:{ ticks:{color:tick}, grid:{color:gridc}, beginAtZero:true } } },
    });
    if(wg){ wg._chart = chart;
      if(wg._ro){ try{ wg._ro.disconnect(); }catch{} wg._ro=null; }
      if(window.ResizeObserver){ wg._ro = new ResizeObserver(()=>{ try{ wg._chart && wg._chart.resize(); }catch{} }); wg._ro.observe(wg); }
    }
  }
  function renderResults(body, spec){
    const items=spec.items||[];
    if(!items.length){ const e=document.createElement('div'); e.className='wg-empty'; e.textContent='No results.'; body.appendChild(e); return; }
    items.forEach(it=>{
      const row=document.createElement('div'); row.className='wg-item';
      row.innerHTML = (it.thumbnail?`<img class="wg-thumb" src="${esc2(it.thumbnail)}" onerror="this.style.visibility='hidden'"/>`:'')
        + `<div class="grow"><div class="wg-it-title">${esc2(it.title)}</div>${it.subtitle?`<div class="wg-it-sub">${esc2(it.subtitle)}</div>`:''}</div>`;
      if(it.action){ row.addEventListener('click',()=>{
        if(it.action.kind==='video') spawnWidget({ type:'video', title:it.title, url:it.action.url, provider:it.action.provider });
        else if(it.action.kind==='music') spawnWidget({ type:'music', title:it.title, url:it.action.url });
        else if(it.action.kind==='link' && safeUrl(it.action.url)) window.open(safeUrl(it.action.url),'_blank','noopener');
      }); } else { row.style.cursor='default'; }
      body.appendChild(row);
    });
  }
  function renderMusic(body, spec){
    const src=safeUrl(spec.url);
    if(!src){ const e=document.createElement('div'); e.className='wg-empty'; e.textContent='Nothing to play.'; body.appendChild(e); return; }
    const f=document.createElement('iframe'); f.className='wg-music'; f.src=src;
    f.setAttribute('sandbox','allow-scripts allow-same-origin allow-popups');
    f.setAttribute('allow','autoplay; encrypted-media; fullscreen; picture-in-picture');
    f.setAttribute('allowfullscreen',''); body.appendChild(f);
  }
  function renderVideo(body, spec){
    const src=embedUrl(spec.url, spec.provider);
    if((spec.provider==='direct') || (!src && /\.(mp4|webm|ogg)(\?|$)/i.test(spec.url||''))){
      // muted so autoplay is actually allowed to start; controls let you unmute.
      const v=document.createElement('video'); v.className='wg-video'; v.controls=true; v.autoplay=true; v.muted=true; v.src=spec.url||''; body.appendChild(v);
    } else if(src){
      const f=document.createElement('iframe'); f.className='wg-video'; f.src=src;
      f.setAttribute('sandbox','allow-scripts allow-same-origin allow-presentation');
      f.setAttribute('allow','autoplay; encrypted-media; picture-in-picture'); f.setAttribute('allowfullscreen','');
      body.appendChild(f);
    } else { const e=document.createElement('div'); e.className='wg-empty'; e.textContent='Cannot play this video.'; body.appendChild(e); }
  }
  function embedUrl(url, provider){
    if(!url) return null; let m;
    // muted autoplay (browsers block audible autoplay); privacy-enhanced YT domain.
    if(provider==='youtube' || /youtu/.test(url)){ m=url.match(/(?:v=|youtu\.be\/|embed\/|shorts\/)([\w-]{11})/); if(m) return `https://www.youtube-nocookie.com/embed/${m[1]}?autoplay=1&mute=1`; }
    if(provider==='vimeo' || /vimeo/.test(url)){ m=url.match(/vimeo\.com\/(?:video\/)?(\d+)/); if(m) return `https://player.vimeo.com/video/${m[1]}?autoplay=1&muted=1`; }
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
  // Widget-like behavior: drag by the header, Escape or click-outside to close.
  (function(){
    const head=settingsPanel.querySelector('.set-head'); if(!head) return;
    let d=null;
    head.addEventListener('pointerdown',e=>{
      if(e.target.closest('button')) return;
      const r=settingsPanel.getBoundingClientRect();
      settingsPanel.style.left=r.left+'px'; settingsPanel.style.top=r.top+'px'; settingsPanel.style.right='auto';
      d={sx:e.clientX,sy:e.clientY,ox:r.left,oy:r.top};
      settingsPanel.classList.add('dragging');
      head.setPointerCapture(e.pointerId);
    });
    head.addEventListener('pointermove',e=>{ if(!d)return;
      const x=Math.max(-40,Math.min(innerWidth-80, d.ox+(e.clientX-d.sx)));
      const y=Math.max(0,Math.min(innerHeight-48, d.oy+(e.clientY-d.sy)));
      settingsPanel.style.left=x+'px'; settingsPanel.style.top=y+'px';
    });
    head.addEventListener('pointerup',()=>{ d=null; settingsPanel.classList.remove('dragging'); });
    document.addEventListener('keydown',e=>{ if(e.key==='Escape'&&settingsPanel.classList.contains('open')) settingsPanel.classList.remove('open'); });
    document.addEventListener('pointerdown',e=>{
      if(!settingsPanel.classList.contains('open')) return;
      if(settingsPanel.contains(e.target)) return;
      if(e.target.closest('#gearBtn,#topMenu,.top-menu')) return;
      settingsPanel.classList.remove('open');
    });
  })();
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
    loadSmartHome();
    $('#haAddStart')?.addEventListener('click', haStartAdd);
  }

  // ── Smart home: HA status + integrations + pending setup + devices ──
  async function loadSmartHome(){
    const dot=$('#haDot'), state=$('#haState'), open=$('#haOpen'), tokForm=$('#haTokenForm');
    const entries=$('#haEntries'), flowsWrap=$('#haFlowsWrap'), flows=$('#haFlows'), devs=$('#haDevices');
    if(!dot) return;
    open.href=`http://${location.hostname}:8123`;
    let d=null;
    try{ d=await (await fetch('/v1/home/integrations',{credentials:'same-origin'})).json(); }catch{}
    if(!d||!d.configured){
      dot.className='pill-dot'; state.textContent='Not connected';
      tokForm.style.display=''; open.style.display='none'; flowsWrap.style.display='none';
      entries.innerHTML='<div class="set-muted">Connect Home Assistant to see integrations and devices.</div>';
      devs.innerHTML='<div class="set-muted">—</div>';
      $('#haTokenSave').onclick=async()=>{
        const t=($('#haToken').value||'').trim(); if(!t){ toast('Paste a token first'); return; }
        try{
          const r=await fetch('/v1/settings',{method:'PUT',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({ORB2_HA_TOKEN:t})});
          if(r.ok){ $('#haToken').value=''; toast('Connected — loading…'); setTimeout(loadSmartHome,800); }
          else toast(r.status===403?'Owner only':'Failed');
        }catch{ toast('Failed'); }
      };
      return;
    }
    tokForm.style.display='none'; open.style.display='';
    if(d.reachable===false){
      dot.className='pill-dot err'; state.textContent='Configured, but unreachable — '+(d.error||'check the service');
      entries.innerHTML='<div class="set-muted">—</div>'; devs.innerHTML='<div class="set-muted">—</div>'; flowsWrap.style.display='none';
      return;
    }
    dot.className='pill-dot ok';
    const list=d.entries||[], disc=d.discovered||[];
    state.textContent=`Connected · ${list.length} integration${list.length===1?'':'s'}`;
    // Discovered-but-unconfigured: each row opens the real pairing form inline.
    flowsWrap.style.display=disc.length?'':'none';
    flows.innerHTML='';
    disc.forEach(f=>{
      const row=document.createElement('div'); row.className='set-item';
      row.innerHTML=`<div class="grow"><div class="t">${esc(f.title||f.handler)}</div><div class="s">found on your network</div></div>`;
      const setup=document.createElement('button'); setup.className='set-btn'; setup.textContent='Set up';
      const dismiss=document.createElement('button'); dismiss.className='set-btn ghost'; dismiss.textContent='Dismiss';
      const formBox=document.createElement('div'); formBox.className='ha-flow-box'; formBox.style.display='none';
      setup.onclick=async()=>{
        formBox.style.display=''; formBox.innerHTML='<div class="set-muted small">Loading…</div>';
        try{
          const r=await fetch('/v1/home/flow/'+encodeURIComponent(f.flow_id),{credentials:'same-origin'});
          const j=await r.json();
          haFlowForm(formBox, j.flow, f.handler, fl=>{ if(fl&&fl.type==='create_entry') setTimeout(loadSmartHome,1200); });
        }catch{ formBox.innerHTML='<div class="set-muted small">Failed to load the setup form.</div>'; }
      };
      dismiss.onclick=async()=>{
        try{ await fetch('/v1/home/flow/'+encodeURIComponent(f.flow_id),{method:'DELETE',credentials:'same-origin'}); toast('Dismissed'); loadSmartHome(); }catch{ toast('Failed'); }
      };
      const btns=document.createElement('div'); btns.className='set-row'; btns.appendChild(setup); btns.appendChild(dismiss);
      row.appendChild(btns); flows.appendChild(row); flows.appendChild(formBox);
    });
    entries.innerHTML=list.length?'':'<div class="set-muted">No integrations yet.</div>';
    list.sort((a,b)=>String(a.title).localeCompare(String(b.title))).forEach(e=>{
      const ok=e.state==='loaded';
      const row=document.createElement('div'); row.className='set-item';
      row.innerHTML=`<div class="grow"><div class="t">${esc(e.title||e.domain)}</div><div class="s">${esc(e.domain)}</div></div>`+
        `<span class="set-muted small${ok?' ok-text':''}">${ok?'active':esc(e.state)}</span>`;
      entries.appendChild(row);
    });
    // Devices — the clean set the orb actually controls, grouped by area.
    // A device the bridge reaches directly (same speaker/TV via AirPlay) is
    // listed ONCE, in "On your network" — never twice.
    devs.innerHTML='<div class="set-muted">Loading…</div>';
    try{
      const [dd,bd]=await Promise.all([
        (await fetch('/v1/home/devices',{credentials:'same-origin'})).json(),
        (await fetch('/v1/bridge/devices',{credentials:'same-origin'})).json().catch(()=>({})),
      ]);
      const norm=s=>String(s||'').toLowerCase().replace(/[^a-z0-9]/g,'');
      const directNames=new Set((bd&&bd.speakers||[]).map(s=>norm(s.name)));
      const isDirect=c=>{ const n=norm(c.name); return (c.domain==='media_player'||!c.domain) && [...directNames].some(d=>d&&(d===n||d.includes(n)||n.includes(d))); };
      const cards=(dd.devices||[]).filter(c=>!isDirect(c));
      devs.innerHTML=cards.length?'':'<div class="set-muted">No devices yet — speakers, TVs and printers live under "On your network" above.</div>';
      const byArea={};
      cards.forEach(c=>{ (byArea[c.area||'Elsewhere']=byArea[c.area||'Elsewhere']||[]).push(c); });
      Object.keys(byArea).sort().forEach(area=>{
        const h=document.createElement('div'); h.className='set-muted small'; h.style.margin='8px 0 2px'; h.textContent=area; devs.appendChild(h);
        byArea[area].forEach(c=>{
          const row=document.createElement('div'); row.className='set-item';
          row.innerHTML=`<div class="grow"><div class="t">${esc(c.name)}</div><div class="s">${esc(c.kind||c.domain||'')}</div></div>`+
            `<span class="set-muted small">${esc(c.state||'')}</span>`;
          devs.appendChild(row);
        });
      });
    }catch{ devs.innerHTML='<div class="set-muted">Could not load devices.</div>'; }
    loadBridgeDevices();
    loadMatterCard();
  }
  // ── Unified Add Device (v0.2 S5): one box, the orb routes the code.
  //    MT:/digits → Matter controller (§7); X-HM:// → HomeKit guidance;
  //    anything else → the Home Assistant integration search below. ──
  (function wireAddDevice(){
    const inp=document.getElementById('addDevCode'), go=document.getElementById('addDevGo'), st=document.getElementById('addDevStatus');
    if(!inp||!go) return;
    const say=(t,ok)=>{ st.textContent=t; st.style.color=ok?'':'#ff9a7a'; };
    async function add(){
      const code=inp.value.trim();
      if(!code) return;
      if(/^X-HM:\/\//i.test(code)){
        say('That’s an Apple HomeKit code. Most recent HomeKit devices also print a Matter “MT:” QR or an 11-digit number — use that here. Older HomeKit-only devices pair in the Apple Home app instead.',false);
        return;
      }
      const digits=code.replace(/[^0-9]/g,'');
      if(/^MT:/i.test(code)||digits.length===11||digits.length===21){
        go.disabled=true;
        say('Looking for the device on your network… this can take up to a minute.',true);
        try{
          const r=await fetch('/v1/matter/commission',{method:'POST',credentials:'same-origin',
            headers:{'content-type':'application/json'},body:JSON.stringify({code})});
          const d=await r.json();
          if(r.ok&&d.ok){ say('Done — the device joined the orb. It will appear under Devices in a moment.',true); inp.value=''; }
          else if(/not found on the network/i.test(d.error||'')){
            say('Could not find it on the network. If it’s brand new: give it power, wait for its light to blink, and make sure it’s joined your Wi-Fi first (many devices only speak 2.4 GHz — if your phone is on the 5 GHz network, the device may be on a network the orb can’t see).',false);
          } else say('Pairing failed at commissioning: '+(d.error||'unknown')+'. The code may already be used — a Matter device needs a fresh code after a factory reset.',false);
        }catch{ say('The Matter service didn’t answer — is the orb fully started?',false); }
        finally{ go.disabled=false; }
        return;
      }
      // Not a pairing payload — treat as a product name for HA.
      const ha=document.getElementById('haAddName');
      if(ha){ ha.value=code; document.getElementById('haAddStart')?.click(); say('That doesn’t look like a setup code — searching Home Assistant integrations for “'+code+'” below.',true); }
      else say('That doesn’t look like a setup code.',false);
    }
    go.addEventListener('click', add);
    inp.addEventListener('keydown', e=>{ if(e.key==='Enter') add(); });
  })();
  // ── Apple Home & Siri: the Matter bridge pairing card ──
  async function loadMatterCard(){
    const card=$('#matterCard'); if(!card) return;
    let d=null;
    try{ d=await (await fetch('/v1/matter/pairing',{credentials:'same-origin'})).json(); }catch{}
    if(!d||!d.enabled){ card.style.display='none'; return; }
    card.style.display='';
    const dot=$('#mtDot'), st=$('#mtState'), code=$('#mtCode');
    if(d.commissioned){
      dot.className='pill-dot ok';
      st.textContent='Paired — Siri controls orb on every Apple device'+(d.devices?` · ${d.devices} bridged`:'');
      code.style.display='none';
    } else if(d.manualCode){
      dot.className='pill-dot';
      st.textContent='Ready to pair';
      const pretty=String(d.manualCode).replace(/(\d{4})(\d{3})(\d{4})/,'$1-$2-$3');
      code.style.display='block';
      code.innerHTML=`Setup code:<div class="dev-code-big">${esc(pretty)}</div>`;
    } else {
      dot.className='pill-dot err'; st.textContent=d.error||'Bridge starting…'; code.style.display='none';
    }
  }
  // Devices the LAN bridge reaches directly (AirPlay + IPP) — independent of HA.
  async function loadBridgeDevices(){
    const wrap=$('#bridgeWrap'), list=$('#bridgeDevices'), empty=$('#bridgeEmpty');
    if(!wrap) return;
    let d=null;
    try{ d=await (await fetch('/v1/bridge/devices',{credentials:'same-origin'})).json(); }catch{}
    if(!d||!d.enabled){ wrap.style.display='none'; if(empty){ empty.style.display=''; empty.textContent='The LAN bridge is not running — direct device access is off.'; } return; }
    const rows=[...(d.speakers||[]).map(s=>({name:s.name, sub:(s.model||'AirPlay')+' · speak & play music', state:'ready'})),
                ...(d.printers||[]).map(p=>({name:p.name, sub:'printer · print directly', state:'ready'}))];
    wrap.style.display=rows.length?'':'none';
    if(empty) empty.style.display=rows.length?'none':'';
    list.innerHTML='';
    rows.forEach(r=>{
      const it=document.createElement('div'); it.className='set-item';
      it.innerHTML=`<span class="pill-dot ok"></span><div class="grow"><div class="t">${esc(r.name)}</div><div class="s">${esc(r.sub)}</div></div>`;
      list.appendChild(it);
    });
  }
  async function haStartAdd(){
    const name=($('#haAddName').value||'').trim().toLowerCase(); const box=$('#haAddForm');
    if(!name){ toast('Name an integration, e.g. roomba'); return; }
    box.innerHTML='<div class="set-muted small">Starting…</div>';
    try{
      const r=await fetch('/v1/home/flow/start',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({handler:name})});
      const j=await r.json();
      if(!r.ok){ box.innerHTML=''; toast(j.error||'Failed — is that the integration id?'); return; }
      haFlowForm(box, j.flow, name, fl=>{ if(fl&&fl.type==='create_entry') setTimeout(loadSmartHome,1200); });
    }catch{ box.innerHTML=''; toast('Failed'); }
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
      // Public access (Funnel) toggle — the away-from-home switch.
      const fr=$('#fnRow'), fs=$('#fnState'), ft=$('#fnToggle'), fh=$('#fnHelp');
      if(fr&&s.serving){
        fr.style.display=''; if(fh) fh.style.display='';
        const on=!!s.funnel;
        fs.textContent=on?'ON — reachable from anywhere (sign-in required)':'off — tailnet only';
        fs.className='set-muted small'+(on?' ok-text':'');
        ft.textContent=on?'Turn off':'Turn on';
        ft.onclick=async()=>{
          if(!on && !confirm('Make this orb reachable from the public internet? Sign-in stays required, but the URL becomes public.')) return;
          ft.disabled=true;
          try{ const r=await fetch('/v1/tailscale/funnel',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({on:!on})});
            const j=await r.json().catch(()=>({}));
            toast(j.message||(r.ok?'Done':'Failed')); if(r.ok) setTimeout(loadTailscale,1200);
          }catch{ toast('Failed'); }
          ft.disabled=false;
        };
      }
    } else {
      state.textContent = (s && s.available===false) ? 'Not available on this host' : 'Not connected';
      state.className='set-muted small';
      urlRow.style.display='none'; down.style.display='none';
      conn.style.display = (s && s.available===false) ? 'none' : 'flex';
      help.style.display = (s && s.available===false) ? 'none' : 'block';
    }
    // Registered device URL (real cert), when this box is enrolled.
    try{ const info=await (await fetch('/v1/info',{credentials:'same-origin'})).json();
      if(info.device_url){ const c=$('#devUrlCard'), a=$('#setDeviceUrl');
        if(c&&a){ c.style.display=''; a.textContent=info.device_url.replace(/^https:\/\//,''); a.href=info.device_url; loadRemoteMode(); } }
      // Where answers come from (v0.2 §8) — quiet accountability.
      const t=info.turn_tiers||{};
      if((t.rules||t.local||t.cloud)&&$('#setSystem')){
        const row=document.createElement('div'); row.className='set-item';
        row.innerHTML=`<div class="grow"><div class="t">Answers by tier</div><div class="s">instant rules · local brain · cloud</div></div>`+
          `<code>${t.rules||0} · ${t.local||0} · ${t.cloud||0}</code>`;
        $('#setSystem').appendChild(row);
      }
      // Re-run the first-run introduction (v0.2 S3) any time.
      if($('#setSystem')&&!document.getElementById('frRerun')){
        const row=document.createElement('div'); row.className='set-item';
        row.innerHTML=`<div class="grow"><div class="t">Introduction</div><div class="s">name the orb, add people, review devices</div></div>`;
        const b=document.createElement('button'); b.id='frRerun'; b.className='set-btn ghost'; b.textContent='Run again';
        b.onclick=async()=>{ try{ await fetch('/v1/firstrun',{method:'POST',credentials:'same-origin',
          headers:{'content-type':'application/json'},body:JSON.stringify({action:'restart'})});
          document.getElementById('setClose')?.click(); window.__orbFirstRunTick?.(); }catch{} };
        row.appendChild(b); $('#setSystem').appendChild(row);
      }
      // Backup & migration (v0.2 S4).
      if($('#setSystem')&&!document.getElementById('bkExport')){
        const row=document.createElement('div'); row.className='set-item';
        row.innerHTML=`<div class="grow"><div class="t">Backup</div><div class="s">everything that makes this orb yours — treat the file like house keys</div></div>`;
        const ex=document.createElement('button'); ex.id='bkExport'; ex.className='set-btn ghost'; ex.textContent='Export';
        ex.onclick=async()=>{
          const pass=prompt('Choose a passphrase (8+ characters). You will need it to restore — there is no recovery.');
          if(!pass) return; if(pass.length<8){ toast('Passphrase too short'); return; }
          ex.disabled=true;
          try{
            const r=await fetch('/v1/backup/export',{method:'POST',credentials:'same-origin',
              headers:{'content-type':'application/json'},body:JSON.stringify({passphrase:pass})});
            if(!r.ok){ toast((await r.json()).error||'Export failed'); return; }
            const a=document.createElement('a'); a.href=URL.createObjectURL(await r.blob());
            a.download=(r.headers.get('content-disposition')||'').match(/filename="(.+)"/)?.[1]||'orb.orbbackup';
            a.click(); toast('Backup downloaded');
          }catch{ toast('Export failed'); } finally{ ex.disabled=false; }
        };
        const im=document.createElement('button'); im.className='set-btn ghost'; im.textContent='Restore';
        im.onclick=()=>{
          const fi=document.createElement('input'); fi.type='file'; fi.accept='.orbbackup';
          fi.onchange=async()=>{
            const f=fi.files&&fi.files[0]; if(!f) return;
            const pass=prompt('Passphrase for this backup:'); if(!pass) return;
            try{
              const buf=new Uint8Array(await f.arrayBuffer());
              let bin=''; for(let i=0;i<buf.length;i+=0x8000) bin+=String.fromCharCode.apply(null,buf.subarray(i,i+0x8000));
              const r=await fetch('/v1/backup/restore',{method:'POST',credentials:'same-origin',
                headers:{'content-type':'application/json'},body:JSON.stringify({passphrase:pass,data_b64:btoa(bin)})});
              const d=await r.json();
              if(r.ok&&d.ok){ toast(`Restored ${d.kv} entries, ${d.files} files${d.matter?', Matter fabric':''} — reloading`); setTimeout(()=>location.reload(),1800); }
              else toast(d.error||'Restore failed');
            }catch{ toast('Restore failed'); }
          };
          fi.click();
        };
        row.append(ex,im); $('#setSystem').appendChild(row);
      }
    }catch{}
  }
  // ── Device-URL remote mode: home-network A record vs DynDNS + router port ──
  async function loadRemoteMode(){
    const lanB=$('#rmLan'), dirB=$('#rmDirect'), st=$('#rmStatus');
    if(!lanB) return;
    let mode='lan';
    try{ mode=(await (await fetch('/v1/remote/status',{credentials:'same-origin'})).json()).mode||'lan'; }catch{}
    const paint=()=>{ lanB.className='set-btn'+(mode==='lan'?'':' ghost'); dirB.className='set-btn'+(mode==='direct'?'':' ghost'); };
    paint();
    const describe=(d)=>{
      if(!d||d.enabled===false){ st.textContent=''; return; }
      const bits=[];
      if(d.mode==='direct'){
        if(d.wan_ip) bits.push('public IP '+d.wan_ip);
        if(d.upnp&&d.upnp.ok) bits.push('router port opened automatically');
        else if(d.router&&d.router.steps) bits.push('router needs a one-time manual step: '+d.router.steps);
        if(d.probe) bits.push(d.probe.ok?'✓ verified reachable from the internet':'not reachable from the internet yet'+(d.probe.error?' ('+d.probe.error+')':''));
      } else bits.push('pointing at this home network');
      st.textContent=bits.join(' · ');
    };
    const set=async(m)=>{
      if(m===mode) return;
      if(m==='direct' && !confirm('Point your device URL at the internet? Sign-in stays required. Your router must forward port 9444 — the orb will try to open it automatically.')) return;
      st.textContent='Applying…';
      try{
        const r=await fetch('/v1/remote/mode',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({mode:m})});
        const d=await r.json();
        if(r.ok){ mode=m; paint(); describe(d); toast(m==='direct'?'Direct mode on':'Back to home-network mode'); }
        else toast(d.error||'Failed');
      }catch{ toast('Failed'); st.textContent=''; }
    };
    lanB.onclick=()=>set('lan');
    dirB.onclick=()=>set('direct');
    if(mode==='direct'){
      try{ describe(await (await fetch('/v1/remote/status?check=1',{credentials:'same-origin'})).json()); }catch{}
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
      ? `<button class="app-setup" data-id="${esc(w.id)}" data-setup="${esc(w.setup||'')}">${w.setup==='oauth'?'Connect':'Set up'}</button>`
      : `<button class="app-toggle${w.enabled?' on':''}" data-id="${esc(w.id)}" aria-label="Toggle ${esc(w.name)}"><span class="knob"></span></button>`;
    return `<div class="app-card${needsSetup?' dim':''}" data-search="${esc(search)}">
      <div class="app-ic">${BRAND_SVG[w.id]||BRAND_SVG[w.provider]||esc(w.icon||'▢')}</div>
      <div class="app-meta"><div class="app-name">${esc(w.name)} <span class="app-cat">${esc(w.category)}</span></div>
        <div class="app-desc">${esc(needsSetup ? (w.note||w.desc) : w.desc)}</div></div>
      ${action}
    </div>`;
  }
  // ── Official brand marks (Simple Icons path data, inlined — no network) ──
  const BRAND_SVG = {
    spotify: '<svg viewBox="0 0 24 24"><path fill="#1DB954" d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.42 1.56-.299.421-1.02.599-1.559.3z"/></svg>',
    google: '<svg viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>',
    microsoft: '<svg viewBox="0 0 24 24"><rect x="1" y="1" width="10" height="10" fill="#F25022"/><rect x="13" y="1" width="10" height="10" fill="#7FBA00"/><rect x="1" y="13" width="10" height="10" fill="#00A4EF"/><rect x="13" y="13" width="10" height="10" fill="#FFB900"/></svg>',
    apple: '<svg viewBox="0 0 24 24"><path fill="#e9f1e2" d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701"/></svg>',
    youtube: '<svg viewBox="0 0 24 24"><path fill="#FF0000" d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814z"/><path fill="#fff" d="M9.545 15.568V8.432L15.818 12z"/></svg>',
    gmail: '<svg viewBox="0 0 24 24"><path fill="#EA4335" d="M24 5.457v13.909c0 .904-.732 1.636-1.636 1.636h-3.819V11.73L12 16.64l-6.545-4.91v9.273H1.636A1.636 1.636 0 0 1 0 19.366V5.457c0-2.023 2.309-3.178 3.927-1.964L5.455 4.64 12 9.548l6.545-4.91 1.528-1.145C21.69 2.28 24 3.434 24 5.457z"/></svg>',
    vercel: '<svg viewBox="0 0 24 24"><path fill="#e9f1e2" d="M24 22.525H0l12-21.05 12 21.05z"/></svg>',
    telegram: '<svg viewBox="0 0 24 24"><path fill="#26A5E4" d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/></svg>',
    onedrive: '<svg viewBox="0 0 24 24"><rect x="1" y="1" width="10" height="10" fill="#F25022"/><rect x="13" y="1" width="10" height="10" fill="#7FBA00"/><rect x="1" y="13" width="10" height="10" fill="#00A4EF"/><rect x="13" y="13" width="10" height="10" fill="#FFB900"/></svg>',
  };
  // Fill every <span data-brand="..."> placeholder (settings cards).
  function paintBrands(root){
    (root||document).querySelectorAll('[data-brand]').forEach(el=>{
      const svg=BRAND_SVG[el.dataset.brand]; if(svg&&!el.firstChild) el.innerHTML=svg;
    });
  }
  try { paintBrands(document); } catch { /* pre-DOM */ }

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
      // Account-linked widgets connect in Your accounts; key-based ones
      // live in the Connections & keys drawer.
      if(btn.dataset.setup==='oauth'){
        const a=document.querySelector('[data-brand="google"]')?.closest('.set-card');
        if(a){ a.scrollIntoView({behavior:'smooth',block:'start'}); return; }
      }
      const c=$('.apps-conn'); if(c){ c.open=true; c.scrollIntoView({behavior:'smooth',block:'start'}); } }; });
    const sb=$('#appsSearch'); if(sb && !sb.dataset.wired){ sb.dataset.wired='1'; sb.oninput=()=>{
      const q=sb.value.toLowerCase().trim();
      grid.querySelectorAll('.app-card').forEach(c=>{ c.style.display=(!q||c.dataset.search.includes(q))?'':'none'; }); }; }
    const aw=$('#addWidget'); if(aw && !aw.dataset.wired){ aw.dataset.wired='1';
      aw.onclick=()=>togglePluginPanel(aw); }
  }

  // ── "Add your own" widget plugin: inline install panel ──
  const PLUGIN_TEMPLATE = [
    '// Custom widget: export render(el, spec, api).',
    '// The agent shows it with: Widget { type: "<your id>", title, ...anything }',
    'export function render(el, spec, api){',
    "  el.innerHTML = '<div style=\"padding:10px\">'+api.esc(spec.title||'My widget')+'</div>';",
    '}',
  ].join('\n');
  function togglePluginPanel(anchor){
    let p=$('#pluginPanel');
    if(p){ p.remove(); return; }
    p=document.createElement('div'); p.id='pluginPanel'; p.className='set-item'; p.style.flexDirection='column'; p.style.alignItems='stretch';
    p.innerHTML =
      `<div class="t" style="margin-bottom:6px;">Add a custom widget</div>`+
      `<div class="s" style="margin-bottom:8px;">Installs into the plugins folder (<code>.widgets/&lt;id&gt;/</code>) — manifest.json + render.js, no rebuild. Or paste an existing render.js.</div>`+
      `<div class="set-form"><input id="plgId" type="text" placeholder="id (e.g. dice)" style="flex:1;" /><input id="plgName" type="text" placeholder="Name" style="flex:1;" /><input id="plgIcon" type="text" placeholder="🧩" style="width:52px;" /></div>`+
      `<textarea id="plgJs" spellcheck="false" style="width:100%;min-height:140px;margin-top:8px;font-family:monospace;font-size:12px;background:rgba(0,0,0,.25);color:inherit;border:1px solid rgba(255,255,255,.12);border-radius:8px;padding:8px;">${esc(PLUGIN_TEMPLATE)}</textarea>`+
      `<div class="set-row" style="margin-top:8px;"><button id="plgInstall" class="set-btn">Install</button><label class="set-btn ghost" style="cursor:pointer;">Load render.js<input id="plgFile" type="file" accept=".js" style="display:none;" /></label><span id="plgMsg" class="set-muted small"></span></div>`+
      `<div id="plgList" style="margin-top:8px;"></div>`;
    anchor.insertAdjacentElement('afterend', p);
    $('#plgFile').onchange=async e=>{ const f=e.target.files[0]; if(f){ $('#plgJs').value=await f.text(); if(!$('#plgId').value) $('#plgId').value=f.name.replace(/\.js$/,'').replace(/[^A-Za-z0-9._-]/g,'-'); } };
    $('#plgInstall').onclick=async()=>{
      const id=$('#plgId').value.trim(), msg=$('#plgMsg');
      if(!id){ msg.textContent='id required'; return; }
      msg.textContent='Installing…';
      try{
        const r=await fetch('/v1/widgets/plugins',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},
          body:JSON.stringify({id, name:$('#plgName').value.trim()||id, icon:$('#plgIcon').value.trim()||'🧩', render_js:$('#plgJs').value})});
        const d=await r.json();
        if(r.ok){ msg.textContent='Installed.'; toast('Widget "'+id+'" installed'); loadPlugins(); loadAppsRegistry(); renderPluginList(); }
        else msg.textContent=d.error||'Failed.';
      }catch{ msg.textContent='Failed.'; }
    };
    renderPluginList();
  }
  async function renderPluginList(){
    const el=$('#plgList'); if(!el) return;
    let d={}; try{ d=await (await fetch('/v1/widgets/plugins',{credentials:'same-origin'})).json(); }catch{}
    const ps=d.plugins||[];
    el.innerHTML = ps.length ? ps.map(x=>`<div class="set-row" style="justify-content:space-between;"><span>${esc(x.icon||'🧩')} ${esc(x.name)} <span class="set-muted small">${esc(x.id)}</span></span><button class="set-btn ghost plg-rm" data-id="${esc(x.id)}">Remove</button></div>`).join('') : '<div class="set-muted small">No custom widgets installed yet.</div>';
    el.querySelectorAll('.plg-rm').forEach(b=>{ b.onclick=async()=>{
      try{ await fetch('/v1/widgets/plugins/'+encodeURIComponent(b.dataset.id),{method:'DELETE',credentials:'same-origin'}); toast('Removed'); loadPlugins(); loadAppsRegistry(); renderPluginList(); }catch{ toast('Failed'); } }; });
  }

  async function loadApps(){
    loadAppsRegistry();
    let s = {};
    try{ s = (await (await fetch('/v1/settings',{credentials:'same-origin'})).json()).settings || {}; }catch{}
    const set = (dot, state, on, label) => { const d=$(dot), t=$(state); if(d) d.className='pill-dot '+(on?'ok':''); if(t) t.textContent = on?('connected'+(label?' · '+label:'')):'not connected'; };
    set('#ytDot','#ytState', !!s.ORB2_YOUTUBE_API_KEY);
    set('#spDot','#spState', !!s.ORB2_SPOTIFY_CLIENT_ID && !!s.ORB2_SPOTIFY_CLIENT_SECRET);
    set('#nwDot','#nwState', !!s.ORB2_NEWSAPI_KEY);
    set('#vcDot','#vcState', !!s.ORB2_VERCEL_TOKEN, 'publishes to vercel.app');
    const put = async (body, ok) => { try{ const r=await fetch('/v1/settings',{method:'PUT',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify(body)}); toast(r.ok?ok:'Failed'); if(r.ok) setTimeout(loadApps,300); }catch{ toast('Failed'); } };
    const yt=$('#ytSave'); if(yt && !yt.dataset.w){ yt.dataset.w='1'; yt.onclick=()=>{ const k=$('#ytKey').value.trim(); if(k){ put({ORB2_YOUTUBE_API_KEY:k},'YouTube connected'); $('#ytKey').value=''; } }; }
        // Apple account (CalDAV app-specific password) + the accounts-card Spotify shortcut.
    (async()=>{
      try{
        const st=await (await fetch('/v1/apple/status',{credentials:'same-origin'})).json();
        const dot=$('#apDot'), acct=$('#apAcct'), disc=$('#apDisconnect');
        if(dot){ dot.className='pill-dot'+(st.connected?' ok':''); acct.textContent=st.connected?'iCloud Calendar connected':''; if(disc) disc.style.display=st.connected?'':'none'; }
      }catch{}
      const go=$('#apConnect');
      if(go&&!go.dataset.w){ go.dataset.w='1'; go.onclick=async()=>{
        const id=$('#apId').value.trim(), pw=$('#apPass').value.trim(), msg=$('#apMsg');
        if(!id||!pw){ msg.textContent='Both fields are needed.'; return; }
        go.disabled=true; msg.textContent='Checking with iCloud…';
        try{
          const r=await fetch('/v1/apple/connect',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({apple_id:id,app_password:pw})});
          const d=await r.json();
          if(r.ok&&d.ok){ msg.textContent='Connected — your iCloud calendar now feeds the morning deck.'; $('#apDot').className='pill-dot ok'; $('#apPass').value=''; $('#apDisconnect').style.display=''; }
          else msg.textContent=d.error||'Could not connect.';
        }catch{ msg.textContent='Could not reach the server.'; }
        finally{ go.disabled=false; }
      }; }
      const ad=$('#apDisconnect');
      if(ad&&!ad.dataset.w){ ad.dataset.w='1'; ad.onclick=async()=>{ try{ await fetch('/v1/apple/disconnect',{method:'POST',credentials:'same-origin'}); $('#apDot').className='pill-dot'; $('#apAcct').textContent=''; ad.style.display='none'; }catch{} }; }
      const sc=$('#spConnect2');
      if(sc&&!sc.dataset.w){ sc.dataset.w='1'; sc.onclick=()=>$('#spConnect')?.click(); }
      try{
        const st=await (await fetch('/v1/oauth/spotify/status',{credentials:'same-origin'})).json();
        const dot=$('#spAcctDot'), lbl=$('#spAcctState');
        if(dot){ dot.className='pill-dot'+(st.connected?' ok':''); lbl.textContent=st.connected?'your account is linked':(st.mode==='relay'?'ready — tap Connect':(st.mode==='own'?'house app set — link your account':'linking service not reachable yet')); }
      }catch{}
    })();
    const sp=$('#spSave'); if(sp && !sp.dataset.w){ sp.dataset.w='1'; sp.onclick=()=>{ const id=$('#spId').value.trim(), sec=$('#spSecret').value.trim(); if(id&&sec){ put({ORB2_SPOTIFY_CLIENT_ID:id,ORB2_SPOTIFY_CLIENT_SECRET:sec},'Spotify connected'); $('#spId').value=''; $('#spSecret').value=''; } }; }
    const nw=$('#nwSave'); if(nw && !nw.dataset.w){ nw.dataset.w='1'; nw.onclick=()=>{ const k=$('#nwKey').value.trim(); if(k){ put({ORB2_NEWSAPI_KEY:k},'News connected'); $('#nwKey').value=''; } }; }
    const vc=$('#vcSave'); if(vc && !vc.dataset.w){ vc.dataset.w='1'; vc.onclick=()=>{ const t=$('#vcToken').value.trim(); if(t){ put(Object.assign({ORB2_VERCEL_TOKEN:t}, $('#vcTeam').value.trim()?{ORB2_VERCEL_TEAM_ID:$('#vcTeam').value.trim()}:{}),'Vercel connected'); $('#vcToken').value=''; } }; }
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
    const gdSave=$('#gdSave'); if(gdSave && !gdSave.dataset.w){ gdSave.dataset.w='1'; gdSave.onclick=()=>{ const id=$('#gdId').value.trim(), sec=$('#gdSecret').value.trim(); if(id){ put(Object.assign({ORB2_GOOGLE_CLIENT_ID:id}, sec?{ORB2_GOOGLE_CLIENT_SECRET:sec}:{}),'Google saved'); $('#gdId').value=''; $('#gdSecret').value=''; } }; }
    const odSave=$('#odSave'); if(odSave && !odSave.dataset.w){ odSave.dataset.w='1'; odSave.onclick=()=>{ const id=$('#odId').value.trim(), sec=$('#odSecret').value.trim(); if(id){ put(Object.assign({ORB2_MS_CLIENT_ID:id}, sec?{ORB2_MS_CLIENT_SECRET:sec}:{}),'Microsoft saved'); $('#odId').value=''; $('#odSecret').value=''; } }; }
    try{
      const cs = await (await fetch('/v1/oauth/cloud/status',{credentials:'same-origin'})).json();
      const anyConn = !!(cs.google&&cs.google.connected) || !!(cs.microsoft&&cs.microsoft.connected);
      set('#csDot','#csState', anyConn);
      const wire=(p,dotSel,acctSel,connSel,discSel,redirSel,devSel,codeSel)=>{
        const st=cs[p]||{}; const acct=$(acctSel),conn=$(connSel),disc=$(discSel),redir=$(redirSel),dot=$(dotSel),dev=$(devSel),code=$(codeSel);
        if(dot) dot.className='pill-dot '+(st.connected?'ok':'');
        const relayMode = !st.connected && st.mode==='relay';
        if(acct) acct.textContent = st.connected?'✓ connected':(relayMode?'ready — tap Connect':(st.device?'not connected':'waiting for the shared 0rb app'));
        if(conn) conn.style.display = st.connected?'none':(st.mode==='own'&&st.configured?'':'none');
        if(dev){ dev.style.display = st.connected?'none':((relayMode||st.device)?'':'none');
          dev.textContent = relayMode?'Connect →':'Connect with code'; dev.dataset.mode = st.mode||''; }
        if(disc) disc.style.display = st.connected?'':'none';
        if(redir && st.redirect_uri) redir.textContent='Redirect URI: '+st.redirect_uri;
        if(conn && !conn.dataset.w){ conn.dataset.w='1'; conn.onclick=async()=>{ try{ const d=await (await fetch('/v1/oauth/cloud/'+p+'/start',{credentials:'same-origin'})).json(); if(d.url) location.href=d.url; else toast(d.error||'Configure first'); }catch{ toast('Failed'); } }; }
        if(disc && !disc.dataset.w){ disc.dataset.w='1'; disc.onclick=async()=>{ await fetch('/v1/oauth/cloud/'+p+'/disconnect',{method:'POST',credentials:'same-origin'}); toast('Disconnected'); loadApps(); }; }
        // device-code flow: start → show code/url → poll until connected
        if(dev && !dev.dataset.w){ dev.dataset.w='1'; dev.onclick=async()=>{
          if(dev.dataset.mode==='relay'){
            try{ const d=await (await fetch('/v1/oauth/cloud/'+p+'/start',{credentials:'same-origin'})).json();
              if(d.url) location.href=d.url; else toast(d.error||'Not available yet'); }catch{ toast('Failed'); }
            return;
          }
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
    el.innerHTML = `<p class="set-muted small">Can't run the model on this box? Point the brain at a cloud endpoint — any <strong>OpenAI-compatible</strong> API (OpenAI, OpenRouter, Together, Groq…) or the <strong>Anthropic API</strong> natively: endpoint <code>https://api.anthropic.com</code>, an sk-ant-… key, and a Claude model. Endpoint &amp; key changes take effect after a restart.</p>`+
      `<div class="set-form"><input id="brEndpoint" type="text" placeholder="https://api.openai.com/v1 or https://api.anthropic.com" value="${esc(isLocal?'':base)}" style="flex:2;" /></div>`+
      `<div class="set-form"><input id="brModel" type="text" placeholder="model id (gpt-4o, claude-sonnet-4-6…)" value="${esc(s.OPENAI_MODEL||'')}" /><input id="brKey" type="password" placeholder="API key" autocomplete="off" /></div>`+
      `<div class="set-row" style="margin-top:8px;"><button id="brSave" class="set-btn">Use cloud brain</button><button id="brLocal" class="set-btn ghost">Reset to local</button></div>`+
      // ── Smart routing (cost optimizer) ──
      `<div style="border-top:1px solid var(--line);margin:16px 0 0;padding-top:12px;">`+
      `<div class="set-row"><div class="info-label" style="color:var(--ink);">Smart routing</div>`+
      `<button id="rtToggle" class="set-switch${s.ORB2_ROUTER_ENABLED==='1'?' on':''}" aria-label="Toggle routing"><span class="knob"></span></button></div>`+
      `<p class="set-muted small">Keep the default model (local Qwen) for everyday turns, and automatically send <strong>coding &amp; hard reasoning</strong> to a stronger cloud model — optimizing quality vs cost. Voice stays local. Uses <strong>OpenRouter</strong> (one key → GPT &amp; Claude).</p>`+
      `<div class="set-form"><input id="rtKey" type="password" placeholder="OpenRouter API key (sk-or-…)" autocomplete="off" style="flex:2;" /><input id="rtModel" type="text" placeholder="strong model" value="${esc(s.ORB2_ROUTER_STRONG_MODEL||'openai/gpt-4o')}" /></div>`+
      `<div class="set-row" style="margin-top:8px;"><button id="rtSave" class="set-btn">Save routing</button><span class="set-muted small" id="rtState">${s.ORB2_OPENROUTER_KEY?'key set':'no key yet'}</span></div></div>`;
    $('#brSave').onclick=async()=>{ const body={}; const e=$('#brEndpoint').value.trim(),m=$('#brModel').value.trim(),k=$('#brKey').value.trim();
      if(e)body.OPENAI_BASE_URL=e; if(m)body.OPENAI_MODEL=m; if(k)body.OPENAI_API_KEY=k;
      if(!Object.keys(body).length){ toast('Enter an endpoint'); return; }
      try{ await fetch('/v1/settings',{method:'PUT',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify(body)}); toast('Saved — restart to apply the endpoint'); }catch{ toast('Failed'); } };
    $('#brLocal').onclick=async()=>{ try{ await fetch('/v1/settings',{method:'PUT',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({OPENAI_BASE_URL:'http://vllm:8888/v1'})}); toast('Reset to local — restart to apply'); renderBrainCfg({OPENAI_BASE_URL:'http://vllm:8888/v1',OPENAI_MODEL:s.OPENAI_MODEL}); }catch{ toast('Failed'); } };
    $('#rtToggle').onclick=async()=>{ const on=!$('#rtToggle').classList.contains('on'); $('#rtToggle').classList.toggle('on',on);
      try{ await fetch('/v1/settings',{method:'PUT',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({ORB2_ROUTER_ENABLED:on?'1':'0'})}); toast(on?'Smart routing on':'Smart routing off'); }catch{ toast('Failed'); } };
    $('#rtSave').onclick=async()=>{ const body={}; const k=$('#rtKey').value.trim(),m=$('#rtModel').value.trim();
      if(k)body.ORB2_OPENROUTER_KEY=k; if(m)body.ORB2_ROUTER_STRONG_MODEL=m;
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
      us.forEach((u,i)=>{ const it=document.createElement('div'); it.className='set-item';
        const role=u.role||(i===0?'owner':'member');
        it.innerHTML=`<div class="grow"><div class="t">${esc(u.email)}${u.label?` · <span class="set-muted">${esc(u.label)}</span>`:''} <span class="role-badge${role==='owner'?' owner':''}">${esc(role)}</span></div>`+
          `<div class="s">${u.telegram_chat_id?'Telegram: '+esc(u.telegram_chat_id):'email only'}${u.person_entity?' · presence: '+esc(u.person_entity):''}</div></div>`;
        const rl=document.createElement('button'); rl.className='set-btn ghost'; rl.textContent=role==='owner'?'Make member':'Make owner';
        rl.onclick=async()=>{
          const r=await fetch('/v1/auth/users',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({email:u.email,role:role==='owner'?'member':'owner'})});
          if(r.ok) loadUsers(); else toast((await r.json().catch(()=>({}))).error||'Owner-only action');
        };
        const del=document.createElement('button'); del.className='set-btn danger'; del.textContent='Remove';
        del.onclick=async()=>{ if(!confirm('Remove '+u.email+'?'))return;
          const r=await fetch('/v1/auth/users',{method:'DELETE',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({email:u.email})});
          if(r.ok) loadUsers(); else toast('Owner-only action'); };
        const info=document.createElement('button'); info.className='set-btn ghost'; info.textContent='Details';
        const panel=document.createElement('div'); panel.className='member-detail'; panel.style.display='none';
        info.onclick=async()=>{
          if(panel.style.display===''){ panel.style.display='none'; return; }
          panel.style.display=''; panel.innerHTML='<div class="set-muted small">Loading…</div>';
          try{
            const d=await (await fetch('/v1/members/'+encodeURIComponent(u.email)+'/profile',{credentials:'same-origin'})).json();
            panel.innerHTML='';
            const sec=(t)=>{ const h=document.createElement('div'); h.className='set-h4'; h.style.paddingLeft='0'; h.textContent=t; panel.appendChild(h); };
            sec('What Orb knows');
            const mem=document.createElement('div'); mem.className='member-mem';
            mem.textContent=d.memory&&d.memory.trim()?d.memory.slice(0,1200):'Nothing saved yet — Orb will note durable personal facts as it learns them.';
            panel.appendChild(mem);
            if(d.memory&&d.memory.trim()){ const fm=document.createElement('button'); fm.className='set-btn danger'; fm.textContent='Forget everything about me';
              fm.onclick=async()=>{ if(!confirm('Delete this personal memory file?'))return;
                await fetch('/v1/members/'+encodeURIComponent(u.email)+'/memory',{method:'DELETE',credentials:'same-origin'}); info.onclick(); info.onclick(); };
              panel.appendChild(fm); }
            const pk=Object.entries(d.prefs||{});
            if(pk.length){ sec('Preferences'); const pv=document.createElement('div'); pv.className='set-muted small';
              pv.textContent=pk.map(([k,v])=>k+': '+v).join(' · '); panel.appendChild(pv); }
            sec('Voice');
            const vr=document.createElement('div'); vr.className='set-row';
            vr.innerHTML='<span class="set-muted small">'+(d.voice_enrolled?'Voice recognized — learned from normal use':'Not enrolled yet — it learns automatically as they talk')+'</span>';
            if(d.voice_enrolled){ const vd=document.createElement('button'); vd.className='set-btn ghost'; vd.textContent='Re-learn';
              vd.onclick=async()=>{ await fetch('/v1/members/'+encodeURIComponent(u.email)+'/voice',{method:'DELETE',credentials:'same-origin'}); toast('Voice profile reset'); };
              vr.appendChild(vd); }
            panel.appendChild(vr);
            if((d.autonomy||[]).length){ sec('Always-allowed actions');
              d.autonomy.forEach(k=>{ const ar=document.createElement('div'); ar.className='set-row';
                ar.innerHTML='<span class="set-muted small" style="flex:1;">'+esc(k)+'</span>';
                const rv=document.createElement('button'); rv.className='set-btn ghost'; rv.textContent='Revoke';
                rv.onclick=async()=>{ await fetch('/v1/members/'+encodeURIComponent(u.email)+'/autonomy',{method:'DELETE',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({key:k})}); ar.remove(); toast('Revoked'); };
                ar.appendChild(rv); panel.appendChild(ar); });
            }
          }catch{ panel.innerHTML='<div class="set-muted small">Could not load.</div>'; }
        };
        it.appendChild(info); it.appendChild(rl); it.appendChild(del); list.appendChild(it); list.appendChild(panel);
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
    const tgOn=!!s.ORB2_TELEGRAM_BOT_TOKEN;
    const tg=document.createElement('div'); tg.className='set-card';
    tg.innerHTML=`<div class="set-row"><span class="pill-dot ${tgOn?'ok':''}"></span><div class="info-label" style="color:var(--ink);">Telegram</div><span class="set-muted small">${tgOn?'configured':'not configured'}</span></div>`+
      `<p class="set-muted small">Make a bot with <strong>@BotFather</strong> and paste its token. Owner chat id (optional) restricts who it answers.</p>`+
      `<div class="set-form"><input id="tgToken" type="password" placeholder="Bot token" autocomplete="off" style="flex:2;" /><input id="tgOwner" type="text" inputmode="numeric" placeholder="Owner chat id (optional)" /><button id="tgSave" class="set-btn">Save</button></div>`;
    list.appendChild(tg);
    $('#tgSave').onclick=async()=>{ const body={}; const t=$('#tgToken').value.trim(), o=$('#tgOwner').value.trim();
      if(t)body.ORB2_TELEGRAM_BOT_TOKEN=t; if(o)body.ORB2_TELEGRAM_OWNER_ID=o;
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
    const enabled=s.ORB2_VOICE_ENABLED||'1';
    const curVoice=s.ORB2_TTS_VOICE||'tara';

    // Voice enabled toggle
    const row=document.createElement('div'); row.className='set-item';
    row.innerHTML=`<div class="grow"><div class="t">Voice enabled</div><div class="s">the orb can listen &amp; speak</div></div>`;
    const sw=document.createElement('button'); sw.className='set-switch'+(enabled==='1'?' on':''); sw.setAttribute('aria-label','Toggle voice'); sw.innerHTML='<span class="knob"></span>';
    sw.onclick=async()=>{ const on=!sw.classList.contains('on'); sw.classList.toggle('on',on);
      try{ await fetch('/v1/settings',{method:'PUT',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({ORB2_VOICE_ENABLED:on?'1':'0'})}); toast(on?'Voice enabled':'Voice disabled'); }catch{ toast('Failed'); } };
    row.appendChild(sw); list.appendChild(row);

    // Voice selection (Orpheus expressive voices)
    const VOICES=[['tara','Tara — warm (default)'],['leah','Leah'],['jess','Jess'],['mia','Mia'],['zoe','Zoe'],['leo','Leo'],['dan','Dan'],['zac','Zac']];
    const vrow=document.createElement('div'); vrow.className='set-item';
    vrow.innerHTML=`<div class="grow"><div class="t">Voice</div><div class="s">how the orb sounds</div></div>`;
    const sel=document.createElement('select'); sel.className='set-select';
    for(const [v,label] of VOICES){ const o=document.createElement('option'); o.value=v; o.textContent=label; if(v===curVoice)o.selected=true; sel.appendChild(o); }
    sel.onchange=async()=>{ try{ await fetch('/v1/settings',{method:'PUT',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({ORB2_TTS_VOICE:sel.value})}); toast('Voice set to '+sel.value); }catch{ toast('Failed'); } };
    vrow.appendChild(sel); list.appendChild(vrow);

    try{ const v=await (await fetch('/v1/voice/status')).json();
      // raw engine URLs are plumbing — say where it runs, not the socket
      const pretty=(x,fall)=>{ const t=String(x||fall); return /http/.test(t)?('on this orb'+(/gpu/i.test(t)?' · GPU':'')):t; };
      list.insertAdjacentHTML('beforeend', chRow('Speech-to-text', pretty(v.stt,'Whisper'), !!v.ready));
      list.insertAdjacentHTML('beforeend', chRow('Text-to-speech', pretty(v.tts,'Kokoro'), !!v.ready));
    }catch{}
    // Vision is handled by the multimodal model itself now (not moondream2).
    list.insertAdjacentHTML('beforeend', chRow('Vision','the model · camera frames', true));
  }

  // ════════════════════════════════════════════════════════════════════════
  //  status + boot
  // ════════════════════════════════════════════════════════════════════════
  let toastT=null;
  // Stacking toasts: rapid actions each get their own chip (max 3 visible,
  // oldest yields), so no message is ever silently overwritten.
  function toast(t){
    const host=$('#toast'); if(!host) return;
    host.classList.add('stack');
    while(host.children.length>=3) host.firstChild.remove();
    const chip=document.createElement('div'); chip.className='toast-chip'; chip.textContent=t;
    host.appendChild(chip);
    requestAnimationFrame(()=>chip.classList.add('show'));
    setTimeout(()=>{ chip.classList.remove('show'); setTimeout(()=>chip.remove(),380); },3200);
  }
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
        name: 'orb2',
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
