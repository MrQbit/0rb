// rak00n sign-in (email / Telegram OTP). External file so the page works
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
})();
