// auth.js  (ES module — loaded with <script type="module">)
// Supabase auth for the paid tier. Sign-in options: email/password AND Google
// OAuth. Also handles sign-up (with email verification), password reset, the
// PASSWORD_RECOVERY landing flow, and the trial/licence ACCESS GATE:
//
//   • window.OrbkordAuth = { session, profile, hasAccess, status } is the one
//     source of truth; every change dispatches 'orbkord-auth-changed'.
//   • status: 'signedout' | 'loading' | 'trial' | 'pro' | 'expired' | 'error'
//   • hasAccess = has_active_license === true OR trial_ends_at in the future.
//   • No access → a blocking overlay over the workspace (login gate, or the
//     Gumroad paywall with the user's email prefilled). app.js additionally
//     guards MIDI/keyboard entry points off the same state.
//
// The frontend NEVER writes has_active_license / trial_ends_at — the Gumroad
// Ping hits a backend Supabase Edge Function which flips the licence flag;
// we only re-read the profile when the user comes back / reloads.
//
// Config resolution works in BOTH worlds:
//   • Vite/Electron later:  import.meta.env.VITE_SUPABASE_URL / _ANON_KEY
//   • zero-build now:       window.__ENV (js/env.js) — anon key is public by
//                           design; RLS is what protects the data.

import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

const ENV = (typeof import.meta !== 'undefined' && import.meta.env) || window.__ENV || {};
const SUPABASE_URL = ENV.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = ENV.VITE_SUPABASE_ANON_KEY;

const GUMROAD_URL = 'https://bleuorb.gumroad.com/l/orbkord';

// ------------------------------------------------------------ access helpers
// Pure functions — exposed on window so non-module code can reuse them.
export function isTrialActive(profile) {
  if (!profile || !profile.trial_ends_at) return false;
  const t = new Date(profile.trial_ends_at).getTime();
  return Number.isFinite(t) && t > Date.now();
}

export function computeHasAccess(profile) {
  // return;
  return !!profile && (profile.has_active_license === true || isTrialActive(profile));
}

export function gumroadCheckoutUrl(email) {
  return GUMROAD_URL + '?wanted=true' + (email ? '&email=' + encodeURIComponent(email) : '');
}

window.isTrialActive = isTrialActive;
window.computeHasAccess = computeHasAccess;
window.gumroadCheckoutUrl = gumroadCheckoutUrl;

const $ = (id) => document.getElementById(id);
const authBox = $('auth-box');

// ------------------------------------------------------- account UI preview
// The Account panel has six states, five of which need a real Supabase session
// to reach — so they were effectively un-eyeballable. This paints any of them
// on demand, purely visually. It lives outside the Supabase branch below so it
// works with no env configured, and it never touches real auth state: the
// buttons it draws are inert (marked data-preview) and nothing is published to
// window.OrbkordAuth, so the access gate is unaffected.
//
//   OrbkordAuthPreview('pro')      one state
//   OrbkordAuthPreview()           cycle to the next state
//   OrbkordAuthPreview(false)      hand the panel back to the live renderer
//   ?authpreview=trial             pick a state at page load
//
// Keep the markup here in step with render() below if that ever changes.
const AUTH_PREVIEW_STATES = ['signedout', 'loading', 'trial', 'trial-last-day',
                             'pro', 'expired', 'checking', 'error'];
let authPreviewIndex = -1;

function authPreviewHTML(state, email) {
  if (state === 'signedout') {
    return '<button class="btn accent" id="auth-trigger" data-preview aria-expanded="false">Log in</button>';
  }
  const badge = {
    loading:          '…',
    trial:            '5 days left',
    'trial-last-day': '1 day left',
    pro:              'PRO',
    expired:          'Trial expired',
    checking:         'Checking purchase…',
    error:            'status unavailable'
  }[state] || '…';

  // Upgrade appears only when we know the user is unlicensed — mirrors
  // `!licensed && profileState === 'ready' && !checkingPurchase` in render().
  const showUpgrade = state === 'trial' || state === 'trial-last-day' || state === 'expired';

  return `<span class="auth-email" title="${email}">${email}</span>` +
         `<span class="auth-trial">${badge}</span>` +
         (showUpgrade ? '<button class="btn accent" data-preview title="One-time purchase on Gumroad">Upgrade</button>' : '') +
         '<button class="btn" data-preview>Sign Out</button>';
}

window.OrbkordAuthPreview = function (state) {
  if (!authBox) return '#auth-box not in the DOM';
  if (state === false || state === null) {
    authPreviewIndex = -1;
    authPreviewActive = null;
    authBox.innerHTML = '';
    window.dispatchEvent(new CustomEvent('orbkord-auth-changed', { detail: window.OrbkordAuth }));
    return 'preview off — live renderer repaints on the next auth change';
  }
  if (state === undefined) {
    authPreviewIndex = (authPreviewIndex + 1) % AUTH_PREVIEW_STATES.length;
    state = AUTH_PREVIEW_STATES[authPreviewIndex];
  } else {
    authPreviewIndex = AUTH_PREVIEW_STATES.indexOf(state);
  }
  if (!AUTH_PREVIEW_STATES.includes(state)) {
    return `unknown state "${state}" — try one of: ${AUTH_PREVIEW_STATES.join(', ')}`;
  }
  authPreviewActive = state;
  authBox.innerHTML = authPreviewHTML(state, 'rahul@orbkord.app');
  return `previewing: ${state}`;
};

// The live render() runs whenever Supabase resolves and would paint straight
// over a preview — most visibly with ?authpreview=, which fires before the
// session lands. Re-assert instead of reaching into render(), which stays
// untouched and authoritative for real auth.
let authPreviewActive = null;
window.addEventListener('orbkord-auth-changed', () => {
  if (!authPreviewActive || !authBox) return;
  queueMicrotask(() => {
    if (authPreviewActive) authBox.innerHTML = authPreviewHTML(authPreviewActive, 'rahul@orbkord.app');
  });
});

// The ?authpreview= entry point is DEV-HOST ONLY. It grants no access — it just
// repaints #auth-box — but on production a shared link carrying it would mask a
// real user's account panel with a fake one. The console function stays available
// everywhere: reaching it already requires devtools, where you could rewrite the
// DOM regardless.
const AUTH_PREVIEW_DEV_HOST = ['localhost', '127.0.0.1', '::1', ''].includes(location.hostname);
if (AUTH_PREVIEW_DEV_HOST) {
  const requested = new URLSearchParams(location.search).get('authpreview');
  if (requested) window.OrbkordAuthPreview(requested);
}

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  // Unconfigured (local dev without env.js): don't publish OrbkordAuth at all —
  // app.js treats "never published" as ungated so development still works.
  console.warn('[auth] missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY — access gate disabled');
  if (authBox) authBox.innerHTML = '<span class="auth-note">auth not configured</span>';
} else {
  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    }
  });

  window.OrbkordSupabase = supabase;

  // -------------------------------------------------------------- state
  let session = null;         // current Supabase session (or null)
  let profile = null;         // { trial_ends_at, has_active_license } or null
  let profileState = 'idle';  // 'idle' | 'loading' | 'ready' | 'error'
  let booted = false;         // has the initial onAuthStateChange landed yet?
  // let session = { user: { id: 'dev-user', email: 'dev@local.com' } }; 
  // let profile = { has_active_license: true }; 
  // let profileState = 'ready';
  // let booted = true;
  let panelOpen = false;      // is the login dropdown showing?
  let view = 'signin';        // 'signin' | 'signup' | 'recovery'
  let licensePollInFlight = false;
  let checkingPurchase = false;



  const esc = (s) => String(s).replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function deriveStatus() {
    if (!booted) return 'loading';   // session not restored yet — don't flash the login gate
    if (!session) return 'signedout';
    if (profileState === 'loading' || profileState === 'idle') return 'loading';
    if (profileState === 'error') return 'error';
    if (profile && profile.has_active_license === true) return 'pro';
    if (isTrialActive(profile)) return 'trial';
    return 'expired';
  }

  // Publish the auth/access state: global + event + both UI surfaces.
  function publish() {
    const status = deriveStatus();
    window.OrbkordAuth = {
      session,
      profile,
      hasAccess: computeHasAccess(profile),
      status,
    };
    window.dispatchEvent(new CustomEvent('orbkord-auth-changed', { detail: window.OrbkordAuth }));
    render();
    renderGate();
  }

  // function publish() {
  //   // 🚧 SLEDGEHAMMER BYPASS: Lie to app.js, force Pro status
  //   window.OrbkordAuth = {
  //     session: true,
  //     profile: { has_active_license: true },
  //     hasAccess: true,
  //     status: 'pro',
  //   };
    
  //   window.dispatchEvent(new CustomEvent('orbkord-auth-changed', { detail: window.OrbkordAuth }));
    
  //   // Nuke the visual gate and the invisible click-blocker
  //   const gateEl = document.getElementById('app-gate');
  //   if (gateEl) gateEl.remove(); 
  // }

  // ---------------------------------------------------------------- UI
  function trialBadge() {
    if (checkingPurchase) return 'Checking purchase…';
    if (profileState === 'loading' || profileState === 'idle') return '…';
    if (profileState === 'error') return 'status unavailable';
    if (profile && profile.has_active_license) return 'PRO';
    if (isTrialActive(profile)) {
      const days = Math.ceil((new Date(profile.trial_ends_at).getTime() - Date.now()) / 86400000);
      return `${days} day${days === 1 ? '' : 's'} left`;
    }
    return 'Trial expired';
  }

  function render() {
    if (!authBox) return;

    if (session && view !== 'recovery') {
      panelOpen = false;
      const email = session.user.email || session.user.id;
      const licensed = !!(profile && profile.has_active_license);
      authBox.innerHTML =
        `<span class="auth-email" title="${esc(email)}">${esc(email)}</span>` +
        `<span class="auth-trial">${esc(trialBadge())}</span>` +
        (!licensed && profileState === 'ready' && !checkingPurchase
          ? '<button class="btn accent" id="btn-upgrade" title="One-time purchase on Gumroad">Upgrade</button>' : '') +
        '<button class="btn" id="btn-signout">Sign Out</button>';
      $('btn-signout').addEventListener('click', () => supabase.auth.signOut());
      const up = $('btn-upgrade');
      if (up) up.addEventListener('click', goToCheckout);
      return;
    }

    // Logged out (or mid password-recovery): trigger button + dropdown panel.
    authBox.innerHTML =
      `<button class="btn accent" id="auth-trigger" aria-expanded="${panelOpen}">Log in</button>` +
      (panelOpen ? panelHTML() : '');

    $('auth-trigger').addEventListener('click', (e) => {
      e.stopPropagation();
      panelOpen = !panelOpen;
      if (panelOpen && view === 'recovery') view = 'recovery'; // keep recovery
      else if (panelOpen) view = 'signin';
      render();
    });

    if (panelOpen) wirePanel();
  }

  function openPanel(startView = 'signin') {
    panelOpen = true;
    if (view !== 'recovery') view = startView;
    render();
  }

  // Checkout: logged-in users go straight to Gumroad with their email
  // prefilled; logged-out users are asked to log in / sign up first.
  function goToCheckout() {
    if (session && session.user && session.user.email) {
      window.open(gumroadCheckoutUrl(session.user.email), '_blank', 'noopener,noreferrer');
    } else {
      openPanel('signup');
    }
  }


  // ------------------------------------------------- access gate overlay
  // Blocks the workspace (sidebar + canvas) but not the top bar, so the login
  // dropdown and account controls stay reachable.
  function gateEl() {
    let el = $('app-gate');
    if (!el) {
      const host = document.querySelector('.workspace') || document.body;
      el = document.createElement('div');
      el.id = 'app-gate';
      el.className = 'app-gate';
      host.appendChild(el);
    }
    return el;
  }

  function renderGate() {
    // const el = document.getElementById('app-gate');
    // if (el) el.remove(); // 🚧 BYPASS: Destroys the invisible click-blocker
    // return;
    const el = gateEl();
    const status = deriveStatus();

    if (computeHasAccess(profile)) {   // trial or pro → app unlocked
      el.hidden = true;
      el.innerHTML = '';
      return;
    }
    el.hidden = false;

    let inner;
    if (status === 'loading') {
      inner = `
        <span class="gate-logo">ORBKORD</span>
        <span class="gate-title">Checking your account…</span>`;
    } else if (status === 'expired') {
      inner = `
        <span class="gate-logo">ORBKORD</span>
        <span class="gate-title">Your free trial has ended</span>
        <span class="gate-sub">Keep harmonising, sequencing and exporting with the full version just a one-time purchase on Gumroad.</span>
        <button class="btn accent gate-cta" id="gate-upgrade">Upgrade to Get OrbKord</button>
        <span class="gate-note">Already purchased? <button class="auth-link" id="gate-reload">Refresh license</button></span>`;
    } else if (status === 'error') {
      inner = `
        <span class="gate-logo">ORBKORD</span>
        <span class="gate-title">Couldn't check your account</span>
        <span class="gate-sub">Something went wrong looking up your trial status.</span>
        <button class="btn accent gate-cta" id="gate-reload">Reload</button>`;
    } else { // signedout
      inner = `
        <span class="gate-logo">ORBKORD</span>
        <span class="gate-title">Log in to start your 7-day free trial</span>
        <span class="gate-sub">Create a free account to play, harmonise, sequence and export. No card needed for the trial.</span>
        <span class="gate-sub">5 USD one-time after</span>
        <button class="btn accent gate-cta" id="gate-login">Log In / Sign Up</button>`;
    }

    el.innerHTML = `<div class="gate-card">${inner}</div>`;

    const login = $('gate-login');
    if (login) login.addEventListener('click', (e) => { e.stopPropagation(); openPanel('signup'); });
    const upgrade = $('gate-upgrade');
    if (upgrade) upgrade.addEventListener('click', goToCheckout);
    const reload = $('gate-reload');
    if (reload) reload.addEventListener('click', async () => {
      if (session) {
        const confirmed = await pollForLicense('refresh-license-button');

        if (!confirmed) {
          alert('Still syncing. Please wait a few seconds and try again.');
        }
      } else {
        window.location.reload();
      }
    });

  }

  function panelHTML() {
    if (view === 'recovery') {
      return `
      <div class="auth-panel" id="auth-panel">
        <div class="auth-panel-head">
          <span class="auth-title">Set a new password</span>
        </div>
        <div class="auth-msg" id="auth-msg" hidden></div>
        <input class="auth-input" id="auth-newpass" type="password"
               placeholder="New password" autocomplete="new-password" />
        <button class="btn accent auth-primary" id="auth-save">Save Password</button>
      </div>`;
    }

    const isSignup = view === 'signup';
    return `
    <div class="auth-panel" id="auth-panel">
      <div class="auth-panel-head">
        <span class="auth-title">${isSignup ? 'Create your account' : 'Welcome back'}</span>
        <span class="auth-sub">${isSignup ? 'Start your 7-day free trial' : 'Log in to continue'}</span>
      </div>

      <div class="auth-msg" id="auth-msg" hidden></div>

      <input class="auth-input" id="auth-email" type="email"
             placeholder="Email" autocomplete="email" />
      <input class="auth-input" id="auth-pass" type="password"
             placeholder="Password"
             autocomplete="${isSignup ? 'new-password' : 'current-password'}" />

      <button class="btn accent auth-primary" id="auth-submit">
        ${isSignup ? 'Sign Up' : 'Log In'}
      </button>

      <div class="auth-links">
        ${isSignup
          ? '<button class="auth-link" id="auth-toggle">Already have an account? Log in</button>'
          : '<button class="auth-link" id="auth-forgot">Forgot password?</button>' +
            '<button class="auth-link" id="auth-toggle">Create account</button>'}
      </div>

      <div class="auth-divider"><span>or</span></div>

      <button class="btn auth-google" id="auth-google">Continue with Google</button>
    </div>`;
  }

  function wirePanel() {
    const panel = $('auth-panel');
    if (panel) panel.addEventListener('click', (e) => e.stopPropagation());

    if (view === 'recovery') {
      $('auth-save').addEventListener('click', savePassword);
      return;
    }

    $('auth-submit').addEventListener('click', view === 'signup' ? signUp : logIn);
    $('auth-google').addEventListener('click', signInGoogle);
    const toggle = $('auth-toggle');
    if (toggle) toggle.addEventListener('click', () => {
      view = view === 'signup' ? 'signin' : 'signup';
      render();
    });
    const forgot = $('auth-forgot');
    if (forgot) forgot.addEventListener('click', forgotPassword);

    // Enter submits from either field.
    [$('auth-email'), $('auth-pass')].forEach((el) => el && el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') (view === 'signup' ? signUp : logIn)();
    }));
  }

  // -------------------------------------------------------- messaging
  function showMsg(text, kind = 'info') {
    const el = $('auth-msg');
    if (!el) return;
    el.textContent = text;
    el.className = 'auth-msg auth-msg-' + kind;
    el.hidden = false;
  }
  function busy(btnId, on, label) {
    const b = $(btnId);
    if (!b) return;
    b.disabled = on;
    if (label != null) b.textContent = label;
  }
  const creds = () => ({
    email: ($('auth-email') && $('auth-email').value.trim()) || '',
    pass: ($('auth-pass') && $('auth-pass').value) || '',
  });

  // ---------------------------------------------------------- flows
  async function logIn() {
    const { email, pass } = creds();
    if (!email || !pass) return showMsg('Enter your email and password.', 'error');
    busy('auth-submit', true, 'Logging in…');
    const { error } = await supabase.auth.signInWithPassword({ email, password: pass });
    if (error) {
      busy('auth-submit', false, 'Log In');
      showMsg(/invalid/i.test(error.message)
        ? 'Invalid email or password.' : error.message, 'error');
    }
    // success → onAuthStateChange closes the panel and renders the logged-in view.
  }

  async function signUp() {
    const { email, pass } = creds();
    if (!email || !pass) return showMsg('Enter an email and password.', 'error');
    if (pass.length < 6) return showMsg('Password must be at least 6 characters.', 'error');
    busy('auth-submit', true, 'Creating…');
    const { data, error } = await supabase.auth.signUp({
      email, password: pass,
      options: { emailRedirectTo: window.location.origin },
    });
    busy('auth-submit', false, 'Sign Up');
    if (error) return showMsg(error.message, 'error');
    // Verification enabled → no session yet; user must confirm via email.
    if (data && data.user && !data.session) {
      showMsg('Check your email to verify your account, then log in.', 'ok');
    } else {
      showMsg('Account created — you can log in now.', 'ok');
    }
  }

  async function forgotPassword() {
    const { email } = creds();
    if (!email) return showMsg('Enter your email above, then tap “Forgot password?”.', 'error');
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: window.location.origin,
    });
    showMsg(error ? error.message
      : 'Check your inbox for a password-reset link.', error ? 'error' : 'ok');
  }

  async function savePassword() {
    const el = $('auth-newpass');
    const pass = el ? el.value : '';
    if (!pass || pass.length < 6) return showMsg('Password must be at least 6 characters.', 'error');
    busy('auth-save', true, 'Saving…');
    const { error } = await supabase.auth.updateUser({ password: pass });
    busy('auth-save', false, 'Save Password');
    if (error) return showMsg(error.message, 'error');
    alert('Your password has been updated.');
    view = 'signin';
    panelOpen = false;
    publish(); // session is live → renders the logged-in view + gate
  }

  function signInGoogle() {
    // origin must be in Supabase → Auth → URL Configuration → Redirect URLs.
    supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: window.location.origin },
    });
  }

  // -------------------------------------------------------- profile fetch
  // READ-ONLY on the licence fields. The only write is the legacy-account
  // insert of (id, email); trial_ends_at comes from the column default and
  // has_active_license from the Gumroad webhook (backend) — never from here.
  async function fetchProfile(sess) {
    let { data, error } = await supabase
      .from('profiles')
      .select('trial_ends_at, has_active_license')
      .eq('id', sess.user.id)
      .maybeSingle();

    // Accounts predating the signup trigger have no row yet — create one
    // (trial_ends_at comes from the column default: now() + 7 days).
    if (!error && !data) {
      const ins = await supabase
        .from('profiles')
        .insert({ id: sess.user.id, email: sess.user.email })
        .select('trial_ends_at, has_active_license')
        .single();
      data = ins.data;
      error = ins.error;
    }

    return { data, error };
  }

  async function refreshProfile() {
    if (!session) { profile = null; profileState = 'idle'; publish(); return; }
    const forUser = session.user.id;
    profileState = 'loading';
    publish();
    const { data, error } = await fetchProfile(session);
    if (!session || session.user.id !== forUser) return;  // signed out mid-flight
    if (error || !data) {
      console.warn('[auth] profile lookup failed:', error && error.message);
      profile = null;
      profileState = 'error';
    } else {
      profile = data;
      profileState = 'ready';
    }
    publish();
  }
  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function pollForLicense(reason = 'manual') {
    if (!session) return false;

    if (licensePollInFlight) {
      console.log('[auth] license poll already in flight, skipping:', reason);
      return false;
    }

    licensePollInFlight = true;

    try {
      console.log('[auth] polling for license:', reason);

      const attempts = 8;
      const delayMs = 1500;

      for (let i = 0; i < attempts; i++) {
        await refreshProfile();

        if (window.OrbkordAuth && window.OrbkordAuth.status === 'pro') {
          console.log('[auth] license confirmed');
          return true;
        }

        await sleep(delayMs);
      }

      console.warn('[auth] license not confirmed after polling');
      return false;
    } finally {
      licensePollInFlight = false;
    }
  }


  function isPurchaseReturn() {
    const params = new URLSearchParams(window.location.search);
    return params.get('purchase') === 'complete';
  }

  function cleanPurchaseReturnUrl() {
    const url = new URL(window.location.href);
    url.searchParams.delete('purchase');
    window.history.replaceState({}, document.title, url.toString());
  }

  async function handlePurchaseReturn() {
    if (!session) return;

    checkingPurchase = true;
    publish();

    const confirmed = await pollForLicense('purchase-return');

    checkingPurchase = false;
    publish();

    if (confirmed) {
      alert('Purchase confirmed — OrbKord Pro is unlocked.');
    } else {
      alert('Purchase received, but your license is still syncing. Please wait a moment and press Refresh License.');
    }

    cleanPurchaseReturnUrl();
  }




  // -------------------------------------------------------- lifecycle
  // Fires immediately with the restored session (if any) and again on every
  // sign-in / sign-out / OAuth redirect / password-recovery landing.
  supabase.auth.onAuthStateChange((event, sess) => {
    booted = true;
    if (event === 'PASSWORD_RECOVERY') {
      // User clicked the reset link — force the "set new password" panel.
      session = sess;
      view = 'recovery';
      panelOpen = true;
      publish();
      return;
    }
    session = sess;
    profile = null;
    profileState = session ? 'loading' : 'idle';
    publish();
    if (session) refreshProfile();
  });

  // Re-check the licence when the user returns from Gumroad checkout in
  // another tab — the webhook may have flipped has_active_license by now.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && session && !(profile && profile.has_active_license)) {
      pollForLicense('tab-visible');
    }
  });


  // Click-outside closes the login dropdown (but never the recovery panel).
  document.addEventListener('click', () => {
    if (panelOpen && view !== 'recovery') { panelOpen = false; render(); }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && panelOpen && view !== 'recovery') { panelOpen = false; render(); }
  });

  // First paint (before the initial onAuthStateChange lands): status derives to
  // 'loading' via the `booted` flag, so the app never flashes unlocked (or the
  // login gate) for a visitor whose session is still being restored.
  if (isPurchaseReturn()) {
    window.addEventListener('orbkord-auth-changed', function onAuthReady() {
      const auth = window.OrbkordAuth;

      if (!auth || auth.status === 'loading') return;

      window.removeEventListener('orbkord-auth-changed', onAuthReady);

      if (auth.session) {
        handlePurchaseReturn();
      } else {
        cleanPurchaseReturnUrl();
      }
    });
  }

  // First paint...
  publish();


}
