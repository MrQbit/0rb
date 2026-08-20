// orb2 sign-in (email / Telegram OTP). External file so the page works
// under a strict CSP (script-src 'self') — inline scripts are blocked.
(function () {
  var emailEl = document.getElementById('email');
  var codeEl = document.getElementById('code');
  var msg = document.getElementById('msg');
  var stepEmail = document.getElementById('step-email');
  var stepCode = document.getElementById('step-code');

  function setMsg(text, ok) { msg.textContent = text || ''; msg.className = 'msg ' + (ok ? 'ok' : 'err'); }

  // Already signed in (or auth disabled)? Go straight to the console.
  fetch('/v1/auth/me', { credentials: 'same-origin' })
    .then(function (r) { return r.json(); })
    .then(function (d) { if (d && d.authenticated) location.replace('/'); })
    .catch(function () {});

  var sendBtn = document.getElementById('sendBtn');
  var sendTgBtn = document.getElementById('sendTgBtn');

  function sendCode(via) {
    var email = emailEl.value.trim();
    if (!email) { setMsg('Enter your email', false); return; }
    sendBtn.disabled = true; sendTgBtn.disabled = true;
    setMsg('Sending code…', true);
    fetch('/v1/auth/request-otp', {
      method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin',
      body: JSON.stringify({ email: email, via: via }),
    }).then(function (r) { return r.json(); }).then(function () {
      document.getElementById('emailEcho').textContent = email;
      document.getElementById('viaEcho').textContent = via === 'telegram' ? 'Telegram' : 'email';
      stepEmail.classList.add('hide'); stepCode.classList.remove('hide');
      codeEl.focus();
      setMsg('If that account is allowed, a code is on its way.', true);
    }).catch(function () { setMsg('Could not reach the server', false); })
      .finally(function () { sendBtn.disabled = false; sendTgBtn.disabled = false; });
  }

  sendBtn.addEventListener('click', function () { sendCode('email'); });
  sendTgBtn.addEventListener('click', function () { sendCode('telegram'); });

  document.getElementById('verifyBtn').addEventListener('click', function () {
    var code = codeEl.value.trim();
    if (!code) { setMsg('Enter the code', false); return; }
    this.disabled = true; setMsg('Verifying…', true);
    fetch('/v1/auth/verify-otp', {
      method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin',
      body: JSON.stringify({ email: emailEl.value.trim(), code: code }),
    }).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) {
        if (res.ok && res.d.ok) { location.replace('/'); return; }
        setMsg(res.d.error || 'Invalid or expired code', false);
      }).catch(function () { setMsg('Could not reach the server', false); })
      .finally(function () { document.getElementById('verifyBtn').disabled = false; });
  });

  document.getElementById('backBtn').addEventListener('click', function () {
    stepCode.classList.add('hide'); stepEmail.classList.remove('hide'); setMsg('', true); emailEl.focus();
  });

  // Enter-key convenience.
  emailEl.addEventListener('keydown', function (e) { if (e.key === 'Enter') sendCode('email'); });
  codeEl.addEventListener('keydown', function (e) { if (e.key === 'Enter') document.getElementById('verifyBtn').click(); });
  // Digits only; auto-verify the moment the 6th digit lands (paste included).
  codeEl.addEventListener('input', function () {
    codeEl.value = codeEl.value.replace(/\D/g, '').slice(0, 6);
    if (codeEl.value.length === 6) document.getElementById('verifyBtn').click();
  });

  // ── Claim ceremony (v0.2 S2): a brand-new orb shows a QR + code instead
  //    of the sign-in form. The window exists only while no owner does.
  var stepClaim = document.getElementById('step-claim');
  var claimCode = '';
  function pollClaim() {
    fetch('/v1/claim', { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d || !d.available) {
          if (!stepClaim.classList.contains('hide')) location.reload();
          return;
        }
        claimCode = d.code || '';
        document.getElementById('claimCode').textContent = claimCode.replace(/(.{4})(.{4})/, '$1 · $2');
        document.getElementById('claimQr').src = '/v1/claim/qr.svg?t=' + d.expires_at;
        document.getElementById('subLine').textContent = 'Welcome';
        stepEmail.classList.add('hide'); stepCode.classList.add('hide');
        stepClaim.classList.remove('hide');
        // refresh before the 10-minute code expires
        setTimeout(pollClaim, 60000);
      })
      .catch(function () { setTimeout(pollClaim, 60000); });
  }
  pollClaim();

  // ── Invitation join mode (Profiles v2): ?invite=<token> ──
  (function inviteMode(){
    var token=new URLSearchParams(location.search).get('invite');
    if(!token) return;
    fetch('/v1/invites/'+encodeURIComponent(token),{credentials:'same-origin'})
      .then(function(r){ return r.json(); })
      .then(function(d){
        if(!d.valid){ setMsg('This invitation is no longer valid — ask for a fresh one.', false); return; }
        document.getElementById('subLine').textContent='You\u2019ve been invited to join '+(d.household||'this orb');
        stepEmail.classList.add('hide'); stepCode.classList.add('hide');
        var wrap=document.getElementById('step-invite');
        if(!wrap){
          wrap=document.createElement('div'); wrap.id='step-invite';
          wrap.innerHTML='<label for="invName">Your first name</label>'+
            '<input id="invName" type="text" autocomplete="given-name" placeholder="First name" />'+
            '<label for="invEmail">Your email</label>'+
            '<input id="invEmail" type="email" autocomplete="email" inputmode="email" placeholder="you@example.com" />'+
            '<button type="button" id="invJoin">Join</button>';
          document.querySelector('.card').insertBefore(wrap, msg);
        }
        document.getElementById('invJoin').onclick=function(){
          var email=document.getElementById('invEmail').value.trim();
          var name=document.getElementById('invName').value.trim();
          if(!email){ setMsg('Enter your email', false); return; }
          setMsg('Joining\u2026', true);
          fetch('/v1/invites/accept',{method:'POST',headers:{'content-type':'application/json'},credentials:'same-origin',
            body:JSON.stringify({token:token,email:email,first_name:name})})
            .then(function(r){ return r.json().then(function(d){ return {ok:r.ok,d:d}; }); })
            .then(function(res){
              if(!res.ok||!res.d.ok){ setMsg(res.d.error||'Could not join', false); return; }
              wrap.classList.add('hide');
              emailEl.value=email;
              document.getElementById('emailEcho').textContent=email;
              document.getElementById('viaEcho').textContent='email';
              stepCode.classList.remove('hide'); codeEl.focus();
              setMsg('Welcome! A sign-in code is on its way to '+email+'.', true);
            }).catch(function(){ setMsg('Could not reach the server', false); });
        };
      }).catch(function(){});
  })();

  var claimBtn = document.getElementById('claimBtn');
  function doClaim() {
    var email = document.getElementById('claimEmail').value.trim();
    if (!email) { setMsg('Enter your email', false); return; }
    claimBtn.disabled = true; setMsg('Claiming…', true);
    fetch('/v1/claim', {
      method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin',
      body: JSON.stringify({ code: claimCode, email: email }),
    }).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) {
        if (res.ok && res.d.ok) { setMsg('This orb is yours.', true); location.replace('/'); return; }
        setMsg(res.d.error || 'Could not claim', false);
      }).catch(function () { setMsg('Could not reach the server', false); })
      .finally(function () { claimBtn.disabled = false; });
  }
  claimBtn.addEventListener('click', doClaim);
  document.getElementById('claimEmail').addEventListener('keydown', function (e) { if (e.key === 'Enter') doClaim(); });
})();
