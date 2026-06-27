/* ══════════════════════════════════════════════════════════════════════
 * Stop & Connect — Shared Account Widget
 * ----------------------------------------------------------------------
 * A small, unobtrusive Log in / Log out control shared across every hub
 * menu (hub landing, 7 Questions, A Word a Day, Auto-Biography).
 *
 * It reuses the Word-a-Day magic-link / 6-digit-code auth so the whole
 * hub shares ONE session, stored in localStorage under `wad_auth`.
 *   - Logged out → "Log in"  → email + code modal (POST /api/wad/auth/request,
 *                                                   POST /api/wad/auth/verify-code)
 *   - Logged in  → "Log out" → clears `wad_auth` (POST /api/wad/auth/logout)
 *
 * The resulting session token is long-lived on the server (no TTL); it only
 * clears on an INTENTIONAL logout here, or if the server rejects it.
 *
 * Mount: a `#auth-widget-mount` element if present, else a fixed bar at the
 * bottom of the page. After a successful login OR logout we reload so each
 * page re-reads `wad_auth` and stays consistent (Word-a-Day re-syncs its own
 * in-page session on reload — this widget never fights that flow).
 * ══════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  if (window.__scAuthWidgetLoaded) return;       // never mount twice
  window.__scAuthWidgetLoaded = true;

  var AUTH_KEY = 'wad_auth';
  var state = { token: null, account: null };

  function token() { try { return localStorage.getItem(AUTH_KEY); } catch (e) { return null; } }
  function api(path, body) {
    return fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    });
  }

  // ── Styles (self-contained, theme-agnostic, brand gold accent) ──
  function injectStyles() {
    if (document.getElementById('sc-auth-style')) return;
    var css = ''
      + '#sc-auth-widget{display:flex;justify-content:center;align-items:center;'
      +   'gap:8px;padding:10px;font-family:"Space Mono","Courier New",monospace;}'
      + '#sc-auth-widget.sc-auth-floating{position:fixed;left:0;right:0;bottom:10px;'
      +   'z-index:60;pointer-events:none;}'
      + '#sc-auth-widget.sc-auth-floating .sc-auth-btn{pointer-events:auto;}'
      + '.sc-auth-btn{background:transparent;border:1px solid rgba(236,170,39,.5);'
      +   'color:#ECAA27;border-radius:100px;padding:6px 16px;font-size:.7rem;'
      +   'letter-spacing:.04em;cursor:pointer;font-family:inherit;line-height:1;'
      +   'transition:background .15s,border-color .15s;backdrop-filter:blur(4px);}'
      + '.sc-auth-btn:hover{background:rgba(236,170,39,.12);border-color:#ECAA27;}'
      + '.sc-auth-email{font-size:.62rem;color:#9a9a9a;max-width:46vw;overflow:hidden;'
      +   'text-overflow:ellipsis;white-space:nowrap;pointer-events:auto;}'
      // modal
      + '#sc-auth-modal{position:fixed;inset:0;z-index:9999;display:none;'
      +   'align-items:center;justify-content:center;background:rgba(0,0,0,.72);'
      +   'padding:20px;font-family:"Inter",system-ui,sans-serif;}'
      + '#sc-auth-modal.open{display:flex;}'
      + '.sc-auth-card{width:100%;max-width:380px;background:#161616;color:#eee;'
      +   'border:1px solid rgba(236,170,39,.35);border-radius:16px;padding:26px 24px;'
      +   'box-shadow:0 24px 60px rgba(0,0,0,.55);}'
      + '.sc-auth-card h3{font-family:"Playfair Display",Georgia,serif;color:#ECAA27;'
      +   'font-size:1.25rem;margin:0 0 6px;font-weight:700;}'
      + '.sc-auth-card p{font-size:.82rem;color:#b9b9b9;margin:0 0 16px;line-height:1.5;}'
      + '.sc-auth-card input{width:100%;background:#0e0e0e;border:1px solid #333;'
      +   'border-radius:10px;padding:12px 14px;color:#fff;font-size:.95rem;'
      +   'margin-bottom:12px;font-family:inherit;}'
      + '.sc-auth-card input:focus{outline:none;border-color:#ECAA27;}'
      + '.sc-auth-row{display:flex;gap:10px;margin-top:4px;}'
      + '.sc-auth-primary{flex:1;background:#ECAA27;color:#1a1200;border:none;'
      +   'border-radius:10px;padding:12px;font-weight:600;font-size:.9rem;cursor:pointer;'
      +   'font-family:inherit;}'
      + '.sc-auth-primary:disabled{opacity:.5;cursor:default;}'
      + '.sc-auth-ghost{background:transparent;color:#999;border:1px solid #333;'
      +   'border-radius:10px;padding:12px 16px;cursor:pointer;font-size:.85rem;'
      +   'font-family:inherit;}'
      + '.sc-auth-status{font-size:.75rem;color:#ECAA27;min-height:1em;margin-top:10px;}'
      + '.sc-auth-link{background:none;border:none;color:#888;text-decoration:underline;'
      +   'cursor:pointer;font-size:.72rem;margin-top:12px;font-family:inherit;padding:0;}';
    var el = document.createElement('style');
    el.id = 'sc-auth-style';
    el.textContent = css;
    document.head.appendChild(el);
  }

  // ── Bottom button ──
  function mountButton() {
    var host = document.getElementById('sc-auth-widget');
    if (!host) {
      host = document.createElement('div');
      host.id = 'sc-auth-widget';
      var slot = document.getElementById('auth-widget-mount');
      if (slot) { slot.appendChild(host); }
      else { host.classList.add('sc-auth-floating'); document.body.appendChild(host); }
    }
    renderButton();
  }

  function renderButton() {
    var host = document.getElementById('sc-auth-widget');
    if (!host) return;
    host.innerHTML = '';
    if (state.token && state.account) {
      var email = state.account.email;
      if (email) {
        var label = document.createElement('span');
        label.className = 'sc-auth-email';
        label.textContent = email;
        host.appendChild(label);
      }
      var out = document.createElement('button');
      out.className = 'sc-auth-btn';
      out.textContent = 'Log out';
      out.addEventListener('click', doLogout);
      host.appendChild(out);
    } else {
      var login = document.createElement('button');
      login.className = 'sc-auth-btn';
      login.textContent = 'Log in';
      login.addEventListener('click', openModal);
      host.appendChild(login);
    }
  }

  // ── Modal (email → code) ──
  function buildModal() {
    if (document.getElementById('sc-auth-modal')) return;
    var modal = document.createElement('div');
    modal.id = 'sc-auth-modal';
    modal.innerHTML =
      '<div class="sc-auth-card" role="dialog" aria-modal="true">' +
        '<div data-step="email">' +
          '<h3>Log in</h3>' +
          '<p>Enter your email and we\'ll send you a login link and a 6-digit code. ' +
          'One account works across every Stop &amp; Connect app.</p>' +
          '<input type="email" id="sc-auth-email-in" placeholder="you@email.com" autocomplete="email" />' +
          '<div class="sc-auth-row">' +
            '<button class="sc-auth-ghost" data-act="close">Cancel</button>' +
            '<button class="sc-auth-primary" data-act="send">Send code →</button>' +
          '</div>' +
        '</div>' +
        '<div data-step="code" style="display:none;">' +
          '<h3>Check your inbox</h3>' +
          '<p>We sent a login link and a 6-digit code to <strong id="sc-auth-sent"></strong>. ' +
          'Click the link on this device, or enter the code below.</p>' +
          '<input type="text" id="sc-auth-code-in" inputmode="numeric" maxlength="6" placeholder="123456" />' +
          '<div class="sc-auth-row">' +
            '<button class="sc-auth-ghost" data-act="close">Cancel</button>' +
            '<button class="sc-auth-primary" data-act="verify">Log in →</button>' +
          '</div>' +
          '<button class="sc-auth-link" data-act="back">← Use a different email</button>' +
        '</div>' +
        '<div class="sc-auth-status" id="sc-auth-status"></div>' +
      '</div>';
    document.body.appendChild(modal);

    modal.addEventListener('click', function (e) {
      if (e.target === modal) closeModal();
      var act = e.target && e.target.getAttribute && e.target.getAttribute('data-act');
      if (act === 'close') closeModal();
      else if (act === 'send') sendCode();
      else if (act === 'verify') verifyCode();
      else if (act === 'back') showStep('email');
    });
  }

  function showStep(step) {
    var modal = document.getElementById('sc-auth-modal');
    modal.querySelector('[data-step="email"]').style.display = step === 'email' ? '' : 'none';
    modal.querySelector('[data-step="code"]').style.display = step === 'code' ? '' : 'none';
    setStatus('');
  }
  function setStatus(msg) { var s = document.getElementById('sc-auth-status'); if (s) s.textContent = msg || ''; }

  function openModal() {
    buildModal();
    showStep('email');
    document.getElementById('sc-auth-modal').classList.add('open');
    setTimeout(function () { var i = document.getElementById('sc-auth-email-in'); if (i) i.focus(); }, 30);
  }
  function closeModal() {
    var modal = document.getElementById('sc-auth-modal');
    if (modal) modal.classList.remove('open');
  }

  function sendCode() {
    var input = document.getElementById('sc-auth-email-in');
    var email = (input.value || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { setStatus('Please enter a valid email.'); return; }
    state.pendingEmail = email;
    setStatus('Sending…');
    var btn = document.querySelector('#sc-auth-modal [data-act="send"]');
    if (btn) btn.disabled = true;
    api('/api/wad/auth/request', { email: email })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (btn) btn.disabled = false;
        if (!data || !data.ok) { setStatus((data && data.error) || 'Could not send. Try again.'); return; }
        document.getElementById('sc-auth-sent').textContent = email;
        showStep('code');
        setTimeout(function () { var c = document.getElementById('sc-auth-code-in'); if (c) c.focus(); }, 30);
      })
      .catch(function () { if (btn) btn.disabled = false; setStatus('Network error. Try again.'); });
  }

  function verifyCode() {
    var code = (document.getElementById('sc-auth-code-in').value || '').trim();
    if (!/^\d{6}$/.test(code)) { setStatus('Enter the 6-digit code.'); return; }
    setStatus('Logging in…');
    var btn = document.querySelector('#sc-auth-modal [data-act="verify"]');
    if (btn) btn.disabled = true;
    // If there's an existing anonymous session, pass it so progress is preserved.
    var existing = token();
    api('/api/wad/auth/verify-code', { email: state.pendingEmail, code: code, authToken: existing || undefined })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
      .then(function (res) {
        if (!res.ok || !res.data || !res.data.authToken) {
          if (btn) btn.disabled = false;
          setStatus((res.data && res.data.error) || 'Invalid or expired code.');
          return;
        }
        try { localStorage.setItem(AUTH_KEY, res.data.authToken); } catch (e) {}
        setStatus('Logged in! Reloading…');
        location.reload();
      })
      .catch(function () { if (btn) btn.disabled = false; setStatus('Network error. Try again.'); });
  }

  function doLogout() {
    var t = token();
    try { localStorage.removeItem(AUTH_KEY); } catch (e) {}
    // Best-effort server revoke; reload regardless so every page re-reads state.
    api('/api/wad/auth/logout', { authToken: t }).catch(function () {}).then(function () {
      location.reload();
    });
    // Fallback: if the fetch hangs, reload anyway shortly.
    setTimeout(function () { location.reload(); }, 1200);
  }

  // ── Boot: validate any stored token, then render ──
  function boot() {
    injectStyles();
    var t = token();
    if (!t) { state.token = null; state.account = null; mountButton(); return; }
    state.token = t;
    api('/api/wad/auth/me', { authToken: t })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (data && data.ok) { state.account = data.account; }
        else { state.token = null; state.account = null; /* keep key; WAD page may still validate it */ }
        mountButton();
      })
      .catch(function () { mountButton(); });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
