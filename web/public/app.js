/**
 * KEBSEND ALL-IN-ONE WEB PLATFORM: DECOUPLED SPA & DASHBOARD ENGINE
 * Handles View Routing (Landing vs Auth vs Dashboard), Dark Mode, API Keys & SMS Dispatch
 */

let currentUser = null;
// Storage keys (renamed from the old Textora brand; old values are migrated once)
const AUTH_TOKEN_KEY = 'kebsend_auth_token';
const THEME_KEY = 'kebsend_theme';
migrateLegacyStorage();
let currentAuthToken = localStorage.getItem(AUTH_TOKEN_KEY) || null;
let currentCustomSenderIdFee = 8.0;
let pendingVerificationEmail = '';

function migrateLegacyStorage() {
  try {
    [['textora_auth_token', 'kebsend_auth_token'], ['textora_theme', 'kebsend_theme']].forEach(([oldKey, newKey]) => {
      const oldVal = localStorage.getItem(oldKey);
      if (oldVal !== null && localStorage.getItem(newKey) === null) localStorage.setItem(newKey, oldVal);
      if (oldVal !== null) localStorage.removeItem(oldKey);
    });
  } catch (e) { /* storage unavailable */ }
}

document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  initPasswordToggles();
  initComposerPreview();
  initAudienceSwitcher();
  initRouter();
  initAuthForms();
  initDashboardWorkspace();
  initPricingCalculator();
  initSenderIdValidator();
  initApiCodeSnippets();
  loadPublicPlans();
  initMobileNavMenu();
  checkAuthAndInitialize();
});

/* --------------------------------------------------------------------------
   1. THEME ENGINE (DARK / LIGHT MODE)
   -------------------------------------------------------------------------- */
function initTheme() {
  const toggleBtn = document.getElementById('btn-theme-toggle');
  const iconSun = document.getElementById('theme-icon-sun');
  const iconMoon = document.getElementById('theme-icon-moon');

  const savedTheme = localStorage.getItem(THEME_KEY) || 'light';
  document.documentElement.setAttribute('data-theme', savedTheme);
  updateThemeIcons(savedTheme);

  if (toggleBtn) {
    toggleBtn.addEventListener('click', () => {
      const current = document.documentElement.getAttribute('data-theme') || 'light';
      const next = current === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      localStorage.setItem(THEME_KEY, next);
      updateThemeIcons(next);
    });
  }

  function updateThemeIcons(theme) {
    if (theme === 'dark') {
      if (iconSun) iconSun.classList.remove('hidden');
      if (iconMoon) iconMoon.classList.add('hidden');
    } else {
      if (iconSun) iconSun.classList.add('hidden');
      if (iconMoon) iconMoon.classList.remove('hidden');
    }
  }
}

/* --------------------------------------------------------------------------
   2. VIEW ROUTER (LANDING VS AUTH VS DASHBOARD)
   -------------------------------------------------------------------------- */
function initRouter() {
  // Hash routing
  window.addEventListener('hashchange', handleRoute);

  // Link route triggers
  document.querySelectorAll('.nav-route-link').forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      const view = link.getAttribute('data-view');
      navigate(view);
    });
  });

  // CTA buttons gating to Register
  document.querySelectorAll('.cta-gate-register').forEach(btn => {
    btn.addEventListener('click', () => {
      if (currentUser) {
        navigate('dashboard');
      } else {
        navigate('register');
      }
    });
  });

  // Auth switch buttons
  document.querySelectorAll('.switch-auth-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.getAttribute('data-target');
      navigate(target);
    });
  });

  // Sign out button
  const btnLogout = document.getElementById('btn-logout');
  if (btnLogout) {
    btnLogout.addEventListener('click', () => {
      localStorage.removeItem(AUTH_TOKEN_KEY);
      currentAuthToken = null;
      currentUser = null;
      updateNavAuthState();
      navigate('landing');
    });
  }
}

function handleRoute() {
  const urlParams = new URLSearchParams(window.location.search);
  const resetToken = urlParams.get('token');
  if (window.location.pathname === '/reset-password' || resetToken) {
    navigate('reset', false);
    return;
  }
  const hash = window.location.hash.replace('#', '') || 'landing';
  if (['landing', 'login', 'register', 'forgot', 'reset', 'dashboard'].includes(hash)) {
    navigate(hash, false);
  }
}

function navigate(viewName, updateHash = true) {
  if (updateHash) {
    window.location.hash = '#' + viewName;
  }

  const landingView = document.getElementById('view-landing');
  const authView = document.getElementById('view-auth');
  const dashboardView = document.getElementById('view-dashboard');
  const landingNav = document.getElementById('landing-nav-links');
  const mobileNavToggle = document.getElementById('btn-mobile-nav-toggle');
  const mobileNavDropdown = document.getElementById('mobile-nav-dropdown');
  const mobileIconOpen = document.getElementById('mobile-menu-icon-open');
  const mobileIconClose = document.getElementById('mobile-menu-icon-close');

  if (mobileNavDropdown) mobileNavDropdown.classList.add('hidden');
  if (mobileIconOpen) mobileIconOpen.classList.remove('hidden');
  if (mobileIconClose) mobileIconClose.classList.add('hidden');

  if (mobileNavToggle) {
    if (viewName === 'landing') {
      mobileNavToggle.classList.remove('hidden');
    } else {
      mobileNavToggle.classList.add('hidden');
    }
  }

  const authLoginPanel = document.getElementById('auth-panel-login');
  const authRegPanel = document.getElementById('auth-panel-register');
  const authForgotPanel = document.getElementById('auth-panel-forgot');
  const authResetPanel = document.getElementById('auth-panel-reset');
  const authVerifyPanel = document.getElementById('auth-panel-verify');

  const mobileDashSubnav = document.getElementById('mobile-dash-subnav');
  if (mobileDashSubnav) {
    if (viewName === 'dashboard') {
      mobileDashSubnav.classList.remove('hidden');
      mobileDashSubnav.classList.add('block', 'md:hidden');
    } else {
      mobileDashSubnav.classList.add('hidden');
      mobileDashSubnav.classList.remove('block', 'md:hidden');
    }
  }

  // Hide all views first
  if (landingView) landingView.classList.add('hidden');
  if (authView) authView.classList.add('hidden');
  if (dashboardView) dashboardView.classList.add('hidden');

  if (viewName === 'dashboard') {
    if (!currentAuthToken || !currentUser) {
      navigate('login');
      return;
    }
    if (dashboardView) dashboardView.classList.remove('hidden');
    const navDashboardBtn = document.getElementById('nav-btn-dashboard');
    if (navDashboardBtn) navDashboardBtn.classList.add('hidden');
    if (landingNav) {
      landingNav.classList.add('hidden', 'hidden-nav');
      landingNav.style.display = 'none';
    }
    loadDashboardData();
  } else if (viewName === 'login') {
    if (authView) authView.classList.remove('hidden');
    if (authLoginPanel) authLoginPanel.classList.remove('hidden');
    if (authRegPanel) authRegPanel.classList.add('hidden');
    if (authForgotPanel) authForgotPanel.classList.add('hidden');
    if (authResetPanel) authResetPanel.classList.add('hidden');
    if (authVerifyPanel) authVerifyPanel.classList.add('hidden');
    if (landingNav) {
      landingNav.classList.add('hidden', 'hidden-nav');
      landingNav.style.display = 'none';
    }
  } else if (viewName === 'register') {
    if (authView) authView.classList.remove('hidden');
    if (authLoginPanel) authLoginPanel.classList.add('hidden');
    if (authRegPanel) authRegPanel.classList.remove('hidden');
    if (authForgotPanel) authForgotPanel.classList.add('hidden');
    if (authResetPanel) authResetPanel.classList.add('hidden');
    if (authVerifyPanel) authVerifyPanel.classList.add('hidden');
    if (landingNav) {
      landingNav.classList.add('hidden', 'hidden-nav');
      landingNav.style.display = 'none';
    }
  } else if (viewName === 'forgot') {
    if (authView) authView.classList.remove('hidden');
    if (authLoginPanel) authLoginPanel.classList.add('hidden');
    if (authRegPanel) authRegPanel.classList.add('hidden');
    if (authForgotPanel) authForgotPanel.classList.remove('hidden');
    if (authResetPanel) authResetPanel.classList.add('hidden');
    if (authVerifyPanel) authVerifyPanel.classList.add('hidden');
    if (landingNav) {
      landingNav.classList.add('hidden', 'hidden-nav');
      landingNav.style.display = 'none';
    }
  } else if (viewName === 'reset') {
    if (authView) authView.classList.remove('hidden');
    if (authLoginPanel) authLoginPanel.classList.add('hidden');
    if (authRegPanel) authRegPanel.classList.add('hidden');
    if (authForgotPanel) authForgotPanel.classList.add('hidden');
    if (authResetPanel) authResetPanel.classList.remove('hidden');
    if (authVerifyPanel) authVerifyPanel.classList.add('hidden');
    if (landingNav) {
      landingNav.classList.add('hidden', 'hidden-nav');
      landingNav.style.display = 'none';
    }
  } else if (viewName === 'verify') {
    if (authView) authView.classList.remove('hidden');
    if (authLoginPanel) authLoginPanel.classList.add('hidden');
    if (authRegPanel) authRegPanel.classList.add('hidden');
    if (authForgotPanel) authForgotPanel.classList.add('hidden');
    if (authResetPanel) authResetPanel.classList.add('hidden');
    if (authVerifyPanel) authVerifyPanel.classList.remove('hidden');
    const emailDisp = document.getElementById('verify-email-display');
    if (emailDisp && pendingVerificationEmail) emailDisp.textContent = pendingVerificationEmail;
    const codeInput = document.getElementById('auth-verify-code');
    if (codeInput) {
      codeInput.value = '';
      setTimeout(() => codeInput.focus(), 100);
    }
    if (landingNav) {
      landingNav.classList.add('hidden', 'hidden-nav');
      landingNav.style.display = 'none';
    }
  } else {
    // landing
    if (landingView) landingView.classList.remove('hidden');
    const navDashboardBtn = document.getElementById('nav-btn-dashboard');
    if (navDashboardBtn && currentUser && currentAuthToken) navDashboardBtn.classList.remove('hidden');
    if (landingNav) {
      if (currentUser && currentAuthToken) {
        landingNav.classList.add('hidden', 'hidden-nav');
        landingNav.style.display = 'none';
      } else {
        landingNav.classList.remove('hidden', 'hidden-nav');
        landingNav.style.display = '';
      }
    }
    initScrollAnimations();
  }

  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function initMobileNavMenu() {
  const toggleBtn = document.getElementById('btn-mobile-nav-toggle');
  const dropdown = document.getElementById('mobile-nav-dropdown');
  const iconOpen = document.getElementById('mobile-menu-icon-open');
  const iconClose = document.getElementById('mobile-menu-icon-close');
  if (!toggleBtn || !dropdown) return;

  function closeMenu() {
    dropdown.classList.add('hidden');
    if (iconOpen) iconOpen.classList.remove('hidden');
    if (iconClose) iconClose.classList.add('hidden');
  }

  function openMenu() {
    dropdown.classList.remove('hidden');
    if (iconOpen) iconOpen.classList.add('hidden');
    if (iconClose) iconClose.classList.remove('hidden');
  }

  toggleBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (dropdown.classList.contains('hidden')) {
      openMenu();
    } else {
      closeMenu();
    }
  });

  document.querySelectorAll('.mobile-nav-link').forEach(link => {
    link.addEventListener('click', () => {
      closeMenu();
    });
  });

  document.addEventListener('click', (e) => {
    if (!dropdown.contains(e.target) && !toggleBtn.contains(e.target)) {
      closeMenu();
    }
  });
}

/* --------------------------------------------------------------------------
   3. AUTH FORMS (LOGIN & REGISTER)
   -------------------------------------------------------------------------- */
function initAuthForms() {
  const formLogin = document.getElementById('form-auth-login');
  const formRegister = document.getElementById('form-auth-register');
  const loginError = document.getElementById('auth-login-error');
  const regError = document.getElementById('auth-reg-error');

  if (formLogin) {
    formLogin.addEventListener('submit', async (e) => {
      e.preventDefault();
      loginError.classList.add('hidden');
      const email = document.getElementById('auth-login-email').value.trim();
      const password = document.getElementById('auth-login-password').value;

      try {
        const res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password })
        });
        const data = await res.json();
        if (!res.ok || !data.ok) {
          if (data.requiresVerification && data.email) {
            pendingVerificationEmail = data.email;
            navigate('verify');
            const verifyMsg = document.getElementById('auth-verify-msg');
            if (verifyMsg) {
              verifyMsg.textContent = data.message || 'Please enter the 6-digit verification code sent to your email.';
              verifyMsg.classList.remove('hidden');
              verifyMsg.className = 'rounded-xl border px-4 py-3 text-sm font-medium bg-amber-50 text-amber-800 border-amber-200';
            }
            return;
          }
          loginError.textContent = data.message || 'Login failed';
          loginError.classList.remove('hidden');
          return;
        }

        currentAuthToken = data.token;
        localStorage.setItem(AUTH_TOKEN_KEY, currentAuthToken);
        currentUser = data.user;
        updateNavAuthState();
        navigate('dashboard');
      } catch (err) {
        loginError.textContent = 'Connection error: ' + err.message;
        loginError.classList.remove('hidden');
      }
    });
  }

  if (formRegister) {
    formRegister.addEventListener('submit', async (e) => {
      e.preventDefault();
      regError.classList.add('hidden');
      const name = document.getElementById('auth-reg-name').value.trim();
      const email = document.getElementById('auth-reg-email').value.trim();
      const phone = document.getElementById('auth-reg-phone').value.trim();
      const password = document.getElementById('auth-reg-password').value;

      try {
        const res = await fetch('/api/auth/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, email, phone, password })
        });
        const data = await res.json();
        if (!res.ok || !data.ok) {
          regError.textContent = data.message || 'Registration failed';
          regError.classList.remove('hidden');
          return;
        }

        if (data.requiresVerification && data.email) {
          pendingVerificationEmail = data.email;
          navigate('verify');
          const verifyMsg = document.getElementById('auth-verify-msg');
          if (verifyMsg) {
            verifyMsg.textContent = data.message || 'We sent a 6-digit confirmation code to your email.';
            verifyMsg.classList.remove('hidden');
            verifyMsg.className = 'rounded-xl border px-4 py-3 text-sm font-medium bg-blue-50 text-blue-800 border-blue-200';
          }
          return;
        }

        currentAuthToken = data.token;
        localStorage.setItem(AUTH_TOKEN_KEY, currentAuthToken);
        currentUser = data.user;
        updateNavAuthState();
        navigate('dashboard');
      } catch (err) {
        regError.textContent = 'Connection error: ' + err.message;
        regError.classList.remove('hidden');
      }
    });
  }

  const formForgot = document.getElementById('form-auth-forgot');
  const forgotMsg = document.getElementById('auth-forgot-msg');
  if (formForgot) {
    formForgot.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (forgotMsg) {
        forgotMsg.classList.add('hidden');
        forgotMsg.className = 'text-xs font-mono';
      }
      const email = document.getElementById('auth-forgot-email').value.trim();
      const btn = formForgot.querySelector('button[type="submit"]');
      const originalText = btn ? btn.textContent : 'Send Reset Link';
      if (btn) {
        btn.disabled = true;
        btn.textContent = 'Sending...';
      }

      try {
        const res = await fetch('/api/auth/forgot-password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email })
        });
        const data = await res.json();
        if (forgotMsg) {
          forgotMsg.textContent = data.message || 'If that email is registered, a reset link has been sent.';
          forgotMsg.classList.remove('hidden');
          forgotMsg.classList.add(res.ok && data.ok ? 'text-green-600' : 'text-red-600');
        }
        if (res.ok && data.ok) {
          formForgot.reset();
        }
      } catch (err) {
        if (forgotMsg) {
          forgotMsg.textContent = 'Connection error: ' + err.message;
          forgotMsg.classList.remove('hidden');
          forgotMsg.classList.add('text-red-600');
        }
      } finally {
        if (btn) {
          btn.disabled = false;
          btn.textContent = originalText;
        }
      }
    });
  }

  const formReset = document.getElementById('form-auth-reset');
  const resetMsg = document.getElementById('auth-reset-msg');
  if (formReset) {
    formReset.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (resetMsg) {
        resetMsg.classList.add('hidden');
        resetMsg.className = 'text-xs font-mono';
      }
      const password = document.getElementById('auth-reset-password').value;
      const confirm = document.getElementById('auth-reset-confirm').value;

      if (password !== confirm) {
        if (resetMsg) {
          resetMsg.textContent = 'Passwords do not match.';
          resetMsg.classList.remove('hidden');
          resetMsg.classList.add('text-red-600');
        }
        return;
      }

      const urlParams = new URLSearchParams(window.location.search);
      const token = urlParams.get('token') || (new URLSearchParams(window.location.hash.split('?')[1] || '')).get('token');
      if (!token) {
        if (resetMsg) {
          resetMsg.textContent = 'Missing reset token. Please use the link sent to your email.';
          resetMsg.classList.remove('hidden');
          resetMsg.classList.add('text-red-600');
        }
        return;
      }

      const btn = formReset.querySelector('button[type="submit"]');
      const originalText = btn ? btn.textContent : 'Update Password';
      if (btn) {
        btn.disabled = true;
        btn.textContent = 'Updating...';
      }

      try {
        const res = await fetch('/api/auth/reset-password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token, password })
        });
        const data = await res.json();
        if (!res.ok || !data.ok) {
          if (resetMsg) {
            resetMsg.textContent = data.message || 'Password reset failed.';
            resetMsg.classList.remove('hidden');
            resetMsg.classList.add('text-red-600');
          }
          return;
        }

        if (resetMsg) {
          resetMsg.textContent = data.message || 'Password updated successfully! Redirecting to sign in...';
          resetMsg.classList.remove('hidden');
          resetMsg.classList.add('text-green-600');
        }
        formReset.reset();
        setTimeout(() => {
          navigate('login');
        }, 2000);
      } catch (err) {
        if (resetMsg) {
          resetMsg.textContent = 'Connection error: ' + err.message;
          resetMsg.classList.remove('hidden');
          resetMsg.classList.add('text-red-600');
        }
      } finally {
        if (btn) {
          btn.disabled = false;
          btn.textContent = originalText;
        }
      }
    });
  }

  const formVerify = document.getElementById('form-auth-verify');
  const verifyMsg = document.getElementById('auth-verify-msg');
  const btnResend = document.getElementById('btn-resend-verification');

  if (formVerify) {
    formVerify.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (verifyMsg) {
        verifyMsg.classList.add('hidden');
        verifyMsg.className = 'rounded-xl border px-4 py-3 text-sm font-medium';
      }
      const code = document.getElementById('auth-verify-code').value.trim();
      const email = pendingVerificationEmail || document.getElementById('auth-reg-email')?.value.trim() || document.getElementById('auth-login-email')?.value.trim();

      const btn = formVerify.querySelector('button[type="submit"]');
      const originalText = btn ? btn.textContent : 'Verify & Activate Account';
      if (btn) {
        btn.disabled = true;
        btn.textContent = 'Verifying...';
      }

      try {
        const res = await fetch('/api/auth/verify-code', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, code })
        });
        const data = await res.json();
        if (!res.ok || !data.ok) {
          if (verifyMsg) {
            verifyMsg.textContent = data.message || 'Verification failed';
            verifyMsg.classList.remove('hidden');
            verifyMsg.className = 'rounded-xl border px-4 py-3 text-sm font-medium bg-rose-50 text-rose-700 border-rose-200';
          }
          return;
        }

        currentAuthToken = data.token;
        localStorage.setItem(AUTH_TOKEN_KEY, currentAuthToken);
        currentUser = data.user;
        updateNavAuthState();
        navigate('dashboard');
      } catch (err) {
        if (verifyMsg) {
          verifyMsg.textContent = 'Connection error: ' + err.message;
          verifyMsg.classList.remove('hidden');
          verifyMsg.className = 'rounded-xl border px-4 py-3 text-sm font-medium bg-rose-50 text-rose-700 border-rose-200';
        }
      } finally {
        if (btn) {
          btn.disabled = false;
          btn.textContent = originalText;
        }
      }
    });
  }

  if (btnResend) {
    btnResend.addEventListener('click', async () => {
      const email = pendingVerificationEmail || document.getElementById('auth-reg-email')?.value.trim() || document.getElementById('auth-login-email')?.value.trim();
      if (!email) {
        alert('Please enter your email first.');
        return;
      }
      btnResend.disabled = true;
      btnResend.textContent = 'Resending...';
      try {
        const res = await fetch('/api/auth/resend-code', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email })
        });
        const data = await res.json();
        if (verifyMsg) {
          verifyMsg.textContent = data.message || (res.ok ? 'Code resent!' : 'Failed to resend code');
          verifyMsg.classList.remove('hidden');
          verifyMsg.className = 'rounded-xl border px-4 py-3 text-sm font-medium ' + (res.ok ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-rose-50 text-rose-700 border-rose-200');
        }
      } catch (err) {
        if (verifyMsg) {
          verifyMsg.textContent = 'Error: ' + err.message;
          verifyMsg.classList.remove('hidden');
          verifyMsg.className = 'rounded-xl border px-4 py-3 text-sm font-medium bg-rose-50 text-rose-700 border-rose-200';
        }
      } finally {
        setTimeout(() => {
          btnResend.disabled = false;
          btnResend.textContent = 'Resend code';
        }, 4000);
      }
    });
  }
}

async function checkAuthAndInitialize() {
  if (currentAuthToken) {
    try {
      const res = await fetch('/api/auth/me', {
        headers: { 'Authorization': `Bearer ${currentAuthToken}` }
      });
      if (res.ok) {
        const data = await res.json();
        if (data.ok && data.user) {
          currentUser = data.user;
          updateNavAuthState();
          await checkPendingSenderIdPayment();
          if (window.location.hash.startsWith('#dashboard') || window.location.hash === '') {
            navigate('dashboard');
          }
          return;
        }
      }
    } catch (e) {}
  }

  updateNavAuthState();
  handleRoute();
}

async function checkPendingSenderIdPayment() {
  const hash = window.location.hash || '';
  const search = window.location.search || '';
  const queryStr = search ? search.substring(1) : (hash.includes('?') ? hash.split('?')[1] : '');
  if (!queryStr) return;

  const params = new URLSearchParams(queryStr);
  const ref = params.get('ref');
  if (ref && ref.startsWith('sid_fee_') && currentAuthToken) {
    try {
      const res = await fetch(`/api/dashboard/sender-id/verify-payment?reference=${encodeURIComponent(ref)}`, {
        headers: { 'Authorization': `Bearer ${currentAuthToken}` }
      });
      const data = await res.json();
      if (data.ok) {
        setTimeout(() => {
          const sidFeedback = document.getElementById('dash-sid-feedback');
          if (sidFeedback) {
            sidFeedback.className = 'rounded-xl border border-teal-500/30 bg-teal-50 px-4 py-3 text-sm font-medium text-teal-700 dark:bg-teal-500/10 dark:text-teal-300';
            sidFeedback.textContent = data.message || 'Payment confirmed! Sender ID submitted for review.';
            sidFeedback.classList.remove('hidden');
          }
          loadDashboardData();
        }, 500);
      }
    } catch (e) {
      console.error('Error verifying Sender ID fee payment:', e);
    }
  }
}

function updateNavAuthState() {
  const unauthGroup = document.getElementById('nav-unauth-group');
  const authGroup = document.getElementById('nav-auth-group');
  const navBalance = document.getElementById('nav-user-balance');
  const landingNav = document.getElementById('landing-nav-links');
  const navDashboardBtn = document.getElementById('nav-btn-dashboard');

  if (currentUser && currentAuthToken) {
    if (unauthGroup) unauthGroup.classList.add('hidden');
    if (authGroup) authGroup.classList.remove('hidden');
    if (landingNav) {
      landingNav.classList.add('hidden', 'hidden-nav');
      landingNav.style.display = 'none';
    }
    if (navBalance) navBalance.textContent = `${currentUser.balance.toFixed(2)} Cr`;
    if (navDashboardBtn) {
      if (window.location.hash === '#dashboard') {
        navDashboardBtn.classList.add('hidden');
      } else {
        navDashboardBtn.classList.remove('hidden');
      }
    }
  } else {
    if (unauthGroup) unauthGroup.classList.remove('hidden');
    if (authGroup) authGroup.classList.add('hidden');
    if (landingNav && (!window.location.hash || window.location.hash === '#landing' || window.location.hash === '')) {
      landingNav.classList.remove('hidden', 'hidden-nav');
      landingNav.style.display = '';
    } else if (landingNav) {
      landingNav.classList.add('hidden', 'hidden-nav');
      landingNav.style.display = 'none';
    }
  }
}

/* --------------------------------------------------------------------------
   4. DEDICATED SAAS DASHBOARD WORKSPACE CONTROLLER
   -------------------------------------------------------------------------- */
function initDashboardWorkspace() {
  // Synchronized Tab switching (Desktop Sidebar + Mobile Pill Navigation)
  const navItems = document.querySelectorAll('.sidebar-nav-item');
  const mobileTabBtns = document.querySelectorAll('.mobile-dash-tab-btn');
  const workspaceTabs = document.querySelectorAll('.dash-workspace-tab');

  function switchDashTab(targetTab) {
    // Sync sidebar items
    navItems.forEach(item => {
      if (item.getAttribute('data-dash-tab') === targetTab) {
        item.classList.add('active');
      } else {
        item.classList.remove('active');
      }
    });

    // Sync mobile pill tabs
    mobileTabBtns.forEach(btn => {
      if (btn.getAttribute('data-dash-tab') === targetTab) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
    });

    // Show selected workspace tab
    workspaceTabs.forEach(tab => {
      if (tab.id === targetTab) {
        tab.classList.remove('hidden');
      } else {
        tab.classList.add('hidden');
      }
    });
  }

  navItems.forEach(item => {
    item.addEventListener('click', () => {
      switchDashTab(item.getAttribute('data-dash-tab'));
    });
  });

  mobileTabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      switchDashTab(btn.getAttribute('data-dash-tab'));
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  });

  // Top Up Modal triggers
  const modalTopup = document.getElementById('modal-topup');
  const btnDashTopup = document.getElementById('btn-dash-topup');
  const btnSidebarTopup = document.getElementById('btn-sidebar-topup');
  const btnWalletTopup = document.getElementById('btn-wallet-topup');
  const navBalancePill = document.getElementById('nav-user-balance-pill');

  function openTopupModal() {
    renderTopupModal();
    if (modalTopup) modalTopup.showModal();
  }

  if (btnDashTopup) btnDashTopup.addEventListener('click', openTopupModal);
  if (btnSidebarTopup) btnSidebarTopup.addEventListener('click', openTopupModal);
  if (btnWalletTopup) btnWalletTopup.addEventListener('click', openTopupModal);
  if (navBalancePill) navBalancePill.addEventListener('click', openTopupModal);

  // Quick Nav buttons inside cards
  document.querySelectorAll('.quick-nav-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.getAttribute('data-dash-tab');
      if (target) {
        switchDashTab(target);
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
    });
  });

  // Generate API key Modal
  const btnGenKey = document.getElementById('btn-generate-api-key');
  const modalGenKey = document.getElementById('modal-generate-key');
  const btnConfirmGenKey = document.getElementById('btn-confirm-generate-key');
  const genKeyNameInput = document.getElementById('gen-key-name-input');
  const genKeyStatus = document.getElementById('gen-key-status');

  if (btnGenKey && modalGenKey) {
    btnGenKey.addEventListener('click', () => {
      if (!currentAuthToken) return;
      if (genKeyStatus) {
        genKeyStatus.className = 'hidden rounded-xl px-4 py-3 text-sm';
        genKeyStatus.textContent = '';
      }
      if (genKeyNameInput) {
        genKeyNameInput.value = `Server Key ${new Date().toLocaleDateString()}`;
      }
      modalGenKey.showModal();
    });
  }

  if (btnConfirmGenKey && modalGenKey) {
    btnConfirmGenKey.addEventListener('click', async () => {
      if (!currentAuthToken) return;
      const keyName = genKeyNameInput ? genKeyNameInput.value.trim() : 'Production Server Key';
      if (!keyName) {
        if (genKeyStatus) {
          genKeyStatus.className = 'rounded-xl border border-error/30 bg-error/10 px-4 py-3 text-sm font-medium text-error';
          genKeyStatus.textContent = 'Please enter a name for your API key.';
        }
        return;
      }

      const originalText = btnConfirmGenKey.textContent;
      btnConfirmGenKey.disabled = true;
      btnConfirmGenKey.textContent = 'Generating...';

      try {
        const res = await fetch('/api/dashboard/api-keys', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${currentAuthToken}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ name: keyName })
        });
        const data = await res.json();
        if (data.ok) {
          modalGenKey.close();
          loadDashboardData();
        } else {
          if (genKeyStatus) {
            genKeyStatus.className = 'rounded-xl border border-error/30 bg-error/10 px-4 py-3 text-sm font-medium text-error';
            genKeyStatus.textContent = data.message || 'Failed to generate key.';
          }
        }
      } catch (err) {
        if (genKeyStatus) {
          genKeyStatus.className = 'rounded-xl border border-error/30 bg-error/10 px-4 py-3 text-sm font-medium text-error';
          genKeyStatus.textContent = 'Error: ' + err.message;
        }
      } finally {
        btnConfirmGenKey.disabled = false;
        btnConfirmGenKey.textContent = originalText;
      }
    });
  }

  // =========================================================================
  // DASHBOARD BULK SMS COMPOSER & CONTACT BOOK UPLOADER
  // =========================================================================
  const btnSendSms = document.getElementById('btn-dash-send-sms');
  const recipientsInput = document.getElementById('dash-sms-recipients');
  const messageInput = document.getElementById('dash-sms-message');
  const senderIdInput = document.getElementById('dash-sms-sender-id');
  const outputEl = document.getElementById('dash-sms-output');
  const contactDropzone = document.getElementById('contact-dropzone');
  const contactFileInput = document.getElementById('contact-file-input');
  const btnClearRecipients = document.getElementById('btn-clear-recipients');
  const btnDownloadSampleCsv = document.getElementById('btn-download-sample-csv');
  const statValidCount = document.getElementById('stat-valid-count');
  const statDupsCount = document.getElementById('stat-dups-count');
  const statInvalidCount = document.getElementById('stat-invalid-count');
  const dashCharCounter = document.getElementById('dash-char-counter');
  const dashSmsTotalCost = document.getElementById('dash-sms-total-cost');
  const dashComposerBalanceTag = document.getElementById('dash-composer-balance-tag');

  // Phone number normalizer
  function normalizeRecipientPhone(val) {
    if (!val) return null;
    const digits = String(val).replace(/\D/g, '');
    if (/^233\d{9}$/.test(digits)) return digits;
    if (/^0\d{9}$/.test(digits)) return `233${digits.slice(1)}`;
    if (/^\d{9}$/.test(digits)) return `233${digits}`;
    if (digits.length >= 7 && digits.length <= 15) return digits;
    return null;
  }

  // Parse text or CSV content into validated lists
  function parseAndValidateContacts(rawText) {
    if (!rawText || !rawText.trim()) {
      return { valid: [], dups: 0, invalid: 0 };
    }

    const tokens = rawText
      .split(/[\r\n,;|\t]+/)
      .map(t => t.replace(/["']/g, '').trim())
      .filter(t => t.length > 0);

    const valid = [];
    const seen = new Set();
    let dups = 0;
    let invalid = 0;

    tokens.forEach(token => {
      // Ignore header rows like "phone", "mobile", "number", "name"
      if (/^(phone|mobile|number|recipient|contact|tel|msisdn|name)$/i.test(token)) {
        return;
      }
      const normalized = normalizeRecipientPhone(token);
      if (!normalized) {
        invalid++;
      } else if (seen.has(normalized)) {
        dups++;
      } else {
        seen.add(normalized);
        valid.push(normalized);
      }
    });

    return { valid, dups, invalid };
  }

  // Update Composer Live Metrics
  function updateComposerMetrics() {
    const rawRecipients = recipientsInput ? recipientsInput.value : '';
    const rawMsg = messageInput ? messageInput.value : '';

    const { valid, dups, invalid } = parseAndValidateContacts(rawRecipients);

    if (statValidCount) statValidCount.textContent = valid.length.toLocaleString();
    if (statDupsCount) statDupsCount.textContent = dups.toLocaleString();
    if (statInvalidCount) statInvalidCount.textContent = invalid.toLocaleString();

    // GSM-7 vs Unicode check
    const isUnicode = /[^\u0000-\u007F]/.test(rawMsg);
    const msgLen = rawMsg.length;
    let parts = 0;

    if (msgLen > 0) {
      if (!isUnicode) {
        parts = msgLen <= 160 ? 1 : Math.ceil(msgLen / 153);
      } else {
        parts = msgLen <= 70 ? 1 : Math.ceil(msgLen / 67);
      }
    }

    if (dashCharCounter) {
      const typeLabel = isUnicode ? 'Unicode' : 'GSM-7';
      dashCharCounter.textContent = `${msgLen} chars | ${parts} part${parts === 1 ? '' : 's'} (${typeLabel})`;
    }

    const totalCredits = (valid.length || 0) * (parts || (msgLen > 0 ? 1 : 0));
    if (dashSmsTotalCost) {
      dashSmsTotalCost.textContent = `${totalCredits.toLocaleString()} Credits`;
    }
  }

  if (recipientsInput) {
    recipientsInput.addEventListener('input', updateComposerMetrics);
  }
  if (messageInput) {
    messageInput.addEventListener('input', updateComposerMetrics);
  }

  // Drag and Drop & File Upload handling
  if (contactDropzone && contactFileInput) {
    contactDropzone.addEventListener('click', () => contactFileInput.click());

    contactDropzone.addEventListener('dragover', (e) => {
      e.preventDefault();
      contactDropzone.classList.add('border-blue-500', 'bg-blue-50/50', 'dark:bg-blue-950/30');
    });

    contactDropzone.addEventListener('dragleave', () => {
      contactDropzone.classList.remove('border-blue-500', 'bg-blue-50/50', 'dark:bg-blue-950/30');
    });

    contactDropzone.addEventListener('drop', (e) => {
      e.preventDefault();
      contactDropzone.classList.remove('border-blue-500', 'bg-blue-50/50', 'dark:bg-blue-950/30');
      if (e.dataTransfer.files && e.dataTransfer.files[0]) {
        processContactFile(e.dataTransfer.files[0]);
      }
    });

    contactFileInput.addEventListener('change', (e) => {
      if (e.target.files && e.target.files[0]) {
        processContactFile(e.target.files[0]);
      }
    });
  }

  function processContactFile(file) {
    const reader = new FileReader();
    reader.onload = (e) => {
      const content = e.target.result;
      const { valid } = parseAndValidateContacts(content);
      if (recipientsInput) {
        recipientsInput.value = valid.join(', ');
        updateComposerMetrics();
      }
      if (outputEl) {
        outputEl.textContent = JSON.stringify({
          status: 'file_processed',
          fileName: file.name,
          fileSize: `${(file.size / 1024).toFixed(1)} KB`,
          validContactsLoaded: valid.length
        }, null, 2);
      }
    };
    reader.readAsText(file);
  }

  // Clear recipients
  if (btnClearRecipients) {
    btnClearRecipients.addEventListener('click', () => {
      if (recipientsInput) recipientsInput.value = '';
      if (contactFileInput) contactFileInput.value = '';
      updateComposerMetrics();
    });
  }

  // Download Sample CSV
  if (btnDownloadSampleCsv) {
    btnDownloadSampleCsv.addEventListener('click', (e) => {
      e.preventDefault();
      const csvContent = 'Phone Number,Full Name,Group\n0244123456,Harrison Essua,VIP Clients\n0501234567,Akosua Mensah,Retail\n233277889900,Kwadwo Antwi,Wholesale\n';
      const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.setAttribute('href', url);
      link.setAttribute('download', 'kebsend_contacts_sample.csv');
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    });
  }

  // Send Bulk SMS Execution
  if (btnSendSms) {
    btnSendSms.addEventListener('click', async () => {
      if (!currentAuthToken) return;
      const rawRecipients = recipientsInput ? recipientsInput.value.trim() : '';
      const message = messageInput ? messageInput.value.trim() : '';
      const senderId = senderIdInput ? senderIdInput.value.trim() || 'TXTORA' : 'TXTORA';

      const { valid } = parseAndValidateContacts(rawRecipients);

      if (valid.length === 0) {
        alert('Please enter or upload at least one valid phone recipient.');
        return;
      }
      if (!message) {
        alert('Please enter your SMS message text.');
        return;
      }

      const costText = (document.getElementById('dash-sms-total-cost') || {}).textContent || '';
      if (!confirm(`Send this message to ${valid.length} ${valid.length === 1 ? 'person' : 'people'} from ${senderId}?${costText ? `\n\nCost: ${costText}` : ''}`)) return;

      const originalBtnText = btnSendSms.textContent;
      btnSendSms.disabled = true;
      btnSendSms.textContent = `Sending to ${valid.length} ${valid.length === 1 ? 'person' : 'people'}...`;
      if (outputEl) outputEl.textContent = 'Sending your messages...';

      try {
        const res = await fetch('/api/dashboard/send-sms', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${currentAuthToken}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ to: valid.join(', '), message, senderId })
        });
        const data = await res.json();
        if (outputEl) outputEl.textContent = JSON.stringify(data, null, 2);
        if (data.ok) {
          loadDashboardData();
        }
      } catch (err) {
        if (outputEl) outputEl.textContent = JSON.stringify({ error: err.message }, null, 2);
      } finally {
        btnSendSms.disabled = false;
        btnSendSms.textContent = originalBtnText;
      }
    });
  }

  // Sender ID request with fee payment (Wallet or Paystack)
  const btnReqSid = document.getElementById('btn-dash-request-sid');
  const sidInput = document.getElementById('dash-new-sid');
  const sidPurpose = document.getElementById('dash-new-sid-purpose');
  const sidFeedback = document.getElementById('dash-sid-feedback');

  if (btnReqSid) {
    btnReqSid.addEventListener('click', async () => {
      if (!currentAuthToken) return;
      const sid = sidInput.value.trim().toUpperCase();
      const purpose = sidPurpose.value.trim();

      if (!sid || sid.length < 3 || sid.length > 11) {
        if (sidFeedback) {
          sidFeedback.className = 'rounded-xl border border-error/30 bg-error/10 px-4 py-3 text-sm font-medium text-error';
          sidFeedback.textContent = 'Sender ID must be 3-11 alphanumeric characters.';
          sidFeedback.classList.remove('hidden');
        }
        return;
      }

      // Check selected payment method
      const payMethodRadios = document.getElementsByName('sid-pay-method');
      let chosenMethod = 'wallet';
      for (const r of payMethodRadios) {
        if (r.checked) chosenMethod = r.value;
      }

      const origText = btnReqSid.textContent;
      btnReqSid.disabled = true;
      btnReqSid.textContent = chosenMethod === 'paystack' ? 'Initializing Paystack...' : 'Processing Payment...';

      try {
        const res = await fetch('/api/dashboard/sender-id', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${currentAuthToken}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ senderId: sid, purpose, paymentMethod: chosenMethod })
        });
        const data = await res.json();

        if (data.ok) {
          if (data.paymentRequired && data.checkout_url) {
            // Paystack checkout redirect
            if (sidFeedback) {
              sidFeedback.className = 'rounded-xl border border-blue-500/30 bg-blue-50 px-4 py-3 text-sm font-medium text-blue-700 dark:bg-blue-500/10 dark:text-blue-200';
              sidFeedback.textContent = `Redirecting to Paystack for ₵${currentCustomSenderIdFee.toFixed(2)} registration fee...`;
              sidFeedback.classList.remove('hidden');
            }
            window.location.href = data.checkout_url;
            return;
          }

          if (sidFeedback) {
            sidFeedback.className = 'rounded-xl border border-teal-500/30 bg-teal-50 px-4 py-3 text-sm font-medium text-teal-700 dark:bg-teal-500/10 dark:text-teal-300';
            sidFeedback.textContent = data.message || `Sender ID "${sid}" submitted for review. Registration fee (₵${currentCustomSenderIdFee.toFixed(2)}) deducted from your wallet balance.`;
            sidFeedback.classList.remove('hidden');
          }
          sidInput.value = '';
          sidPurpose.value = '';
          loadDashboardData();
        } else {
          if (sidFeedback) {
            sidFeedback.className = 'rounded-xl border border-error/30 bg-error/10 px-4 py-3 text-sm font-medium text-error';
            sidFeedback.textContent = data.message || 'Payment or submission failed.';
            sidFeedback.classList.remove('hidden');
          }
        }
      } catch (err) {
        if (sidFeedback) {
          sidFeedback.className = 'rounded-xl border border-error/30 bg-error/10 px-4 py-3 text-sm font-medium text-error';
          sidFeedback.textContent = 'Error: ' + err.message;
          sidFeedback.classList.remove('hidden');
        }
      } finally {
        btnReqSid.disabled = false;
        btnReqSid.innerHTML = `Register (<span id="dash-sid-fee-btn">₵${currentCustomSenderIdFee.toFixed(2)}</span>)`;
      }
    });
  }

  // Refresh logs button
  const btnRefreshLogs = document.getElementById('btn-refresh-logs');
  if (btnRefreshLogs) btnRefreshLogs.addEventListener('click', loadDashboardData);
}

async function loadDashboardData() {
  if (!currentAuthToken) return;

  try {
    const res = await fetch('/api/dashboard/overview', {
      headers: { 'Authorization': `Bearer ${currentAuthToken}` }
    });
    if (!res.ok) return;
    const data = await res.json();
    if (!data.ok) return;

    currentUser = data.user;
    updateNavAuthState();

    // Top greeting & balance displays
    const firstName = currentUser.name.split(' ')[0];
    const greetingEl = document.getElementById('dash-greeting-name');
    if (greetingEl) greetingEl.textContent = firstName;
    const mobileGreetingEl = document.getElementById('dash-mobile-greeting-name');
    if (mobileGreetingEl) mobileGreetingEl.textContent = firstName;
    const userEmailEl = document.getElementById('dash-user-email');
    if (userEmailEl) userEmailEl.textContent = currentUser.email;
    const mobileUserEmailEl = document.getElementById('dash-mobile-user-email');
    if (mobileUserEmailEl) mobileUserEmailEl.textContent = currentUser.email;

    const sideBal = document.getElementById('sidebar-balance');
    if (sideBal) sideBal.textContent = `${currentUser.balance.toFixed(2)} Credits`;
    const cardBal = document.getElementById('card-balance');
    if (cardBal) cardBal.innerHTML = `${currentUser.balance.toFixed(2)} <span class="text-base font-semibold text-blue-200">Credits</span>`;
    const composerBalEl = document.getElementById('dash-composer-balance-tag');
    if (composerBalEl) composerBalEl.textContent = `Balance: ${currentUser.balance.toFixed(2)} Credits`;
    const sidBalEl = document.getElementById('sid-wallet-balance');
    if (sidBalEl) sidBalEl.textContent = `₵${currentUser.balance.toFixed(2)}`;
    if (data.customSenderIdFeeGHS !== undefined) {
      currentCustomSenderIdFee = Number(data.customSenderIdFeeGHS);
      const feeBadge = document.getElementById('dash-sid-fee-badge');
      if (feeBadge) feeBadge.textContent = `₵${currentCustomSenderIdFee.toFixed(2)}`;
      const feeBtn = document.getElementById('dash-sid-fee-btn');
      if (feeBtn) feeBtn.textContent = `₵${currentCustomSenderIdFee.toFixed(2)}`;
    }
    document.getElementById('card-api-keys-count').textContent = data.apiKeys.length;
    document.getElementById('card-sender-ids-count').textContent = (currentUser.senderIds || ['TXTORA']).length;

    // Render API Keys List
    const keysContainer = document.getElementById('dash-api-keys-list');
    if (keysContainer) {
      if (data.apiKeys.length === 0) {
        keysContainer.innerHTML = '<div class="rounded-2xl bg-cream-100 px-4 py-6 text-center text-sm text-ink dark:bg-night-900 dark:text-slate-400">No API keys yet. Click <b>+ New API key</b> to create one.</div>';
      } else {
        keysContainer.innerHTML = data.apiKeys.map(k => `
          <div class="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-cream-100 p-4 dark:bg-night-900">
            <div>
              <div class="font-bold text-navy-900 dark:text-white">${escapeHtml(k.name)}</div>
              <div class="mt-1 break-all font-mono text-xs text-blue-600 dark:text-blue-300">${k.key}</div>
              <div class="mt-0.5 text-xs text-ink dark:text-slate-400">Created: ${new Date(k.createdAt).toLocaleDateString()}</div>
            </div>
            <div class="flex items-center gap-2">
              <button class="ks-btn-ghost btn-sm copy-direct-btn" data-key="${k.key}">
                Copy Key
              </button>
              <button class="btn btn-sm btn-ghost font-semibold text-error hover:bg-error/10 revoke-key-btn" data-id="${k._id || k.id}">
                Revoke
              </button>
            </div>
          </div>
        `).join('');

        keysContainer.querySelectorAll('.copy-direct-btn').forEach(btn => {
          btn.addEventListener('click', () => {
            navigator.clipboard.writeText(btn.getAttribute('data-key'));
            btn.textContent = 'Copied!';
            setTimeout(() => btn.textContent = 'Copy Key', 1500);
          });
        });

        keysContainer.querySelectorAll('.revoke-key-btn').forEach(btn => {
          btn.addEventListener('click', async () => {
            if (!confirm('Are you sure you want to revoke this API key?')) return;
            const keyId = btn.getAttribute('data-id');
            await fetch(`/api/dashboard/api-keys/${keyId}`, {
              method: 'DELETE',
              headers: { 'Authorization': `Bearer ${currentAuthToken}` }
            });
            loadDashboardData();
          });
        });
      }
    }

    // Render Sender IDs dropdown, active badges, and request history table
    const sidDropdown = document.getElementById('dash-sms-sender-id');
    const sidBadges = document.getElementById('dash-active-sender-ids');
    if (sidDropdown && currentUser.senderIds) {
      sidDropdown.innerHTML = currentUser.senderIds.map(s => `<option value="${s}">${s}</option>`).join('');
    }
    if (sidBadges && currentUser.senderIds) {
      sidBadges.innerHTML = currentUser.senderIds.map(s => `
        <span class="inline-flex items-center gap-1.5 rounded-full bg-teal-50 px-3 py-1.5 text-sm font-bold text-teal-700 dark:bg-teal-500/10 dark:text-teal-300">
          <span class="h-1.5 w-1.5 rounded-full bg-teal-500"></span>${escapeHtml(s)}
        </span>
      `).join('');
    }

    const sidRequestsTable = document.getElementById('dash-sid-requests-table');
    if (sidRequestsTable) {
      const requests = data.senderIdRequests || [];
      if (requests.length === 0) {
        sidRequestsTable.innerHTML = '<tr><td colspan="5" class="py-6 text-center text-ink">No requests yet.</td></tr>';
      } else {
        sidRequestsTable.innerHTML = requests.map(req => {
          let statusBadge = '';
          if (req.status === 'approved') {
            statusBadge = '<span class="badge badge-success badge-sm font-semibold">Approved</span>';
          } else if (req.status === 'rejected') {
            statusBadge = '<span class="badge badge-error badge-sm font-semibold">Rejected</span>';
          } else {
            statusBadge = '<span class="badge badge-warning badge-sm font-semibold">Pending</span>';
          }

          const feeFormatted = `₵${Number(req.feeAmountGHS || 1).toFixed(2)} (${req.paymentMethod === 'paystack' ? 'Paystack' : 'Wallet'})`;

          return `
            <tr class="hover:bg-cream-50 dark:hover:bg-white/5">
              <td class="text-ink">${new Date(req.createdAt).toLocaleDateString()}</td>
              <td class="font-bold">${escapeHtml(req.senderId)}</td>
              <td class="text-ink dark:text-slate-400">${escapeHtml(req.purpose || 'Business Broadcast')}</td>
              <td>${feeFormatted}</td>
              <td>${statusBadge}</td>
            </tr>
          `;
        }).join('');
      }
    }

    // Render Message Logs Table
    const logsBody = document.getElementById('dash-logs-table-body');
    if (logsBody) {
      if (!data.logs || data.logs.length === 0) {
        logsBody.innerHTML = '<tr><td colspan="6" class="py-6 text-center text-ink">No messages sent yet.</td></tr>';
      } else {
        logsBody.innerHTML = data.logs.map(log => `
          <tr class="hover:bg-cream-50 dark:hover:bg-white/5">
            <td>${new Date(log.createdAt).toLocaleString()}</td>
            <td>${Array.isArray(log.recipients) ? log.recipients.join(', ') : log.recipients}</td>
            <td class="font-semibold">${escapeHtml(log.senderId || 'TXTORA')}</td>
            <td class="max-w-xs truncate">${escapeHtml(log.message)}</td>
            <td class="font-bold text-ember-600 dark:text-ember-400">-${log.unitsDebited}</td>
            <td><span class="badge badge-success badge-sm font-semibold">${escapeHtml(log.status)}</span></td>
          </tr>
        `).join('');
      }
    }

    // Render Dashboard Recharge Plans Grid
    const dashPlansGrid = document.getElementById('dash-plans-grid');
    if (dashPlansGrid) {
      const plans = [
        { id: 1, priceGHS: 20, credits: 400, tag: 'Starter' },
        { id: 2, priceGHS: 50, credits: 1000, tag: 'Basic' },
        { id: 3, priceGHS: 100, credits: 2000, tag: 'Growth', popular: true },
        { id: 4, priceGHS: 200, credits: 4000, tag: 'Pro' },
        { id: 5, priceGHS: 500, credits: 10000, tag: 'Business' },
        { id: 6, priceGHS: 1000, credits: 20000, tag: 'Scale' }
      ];

      dashPlansGrid.innerHTML = plans.map(p => `
        <div class="relative flex flex-col justify-between rounded-2xl border-2 p-4 ${p.popular ? 'border-ember-500 bg-ember-50/60 dark:bg-ember-500/10' : 'border-transparent bg-cream-100 dark:bg-night-900'}">
        ${p.popular ? '<span class="absolute -top-2.5 left-3 rounded-full bg-ember-500 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white">Popular</span>' : ''}
          <div>
            <div class="text-xs font-bold uppercase tracking-wider text-ink dark:text-slate-400">${p.tag}</div>
            <div class="mt-0.5 text-xl font-black text-navy-900 dark:text-white">GH₵ ${p.priceGHS}</div>
            <div class="mt-1 text-sm font-bold text-teal-600 dark:text-teal-400">${p.credits.toLocaleString()} credits</div>
          </div>
          <button class="btn btn-sm btn-block mt-3 ${p.popular ? 'ks-btn-primary' : 'ks-btn-navy'} pay-dash-plan-btn" data-plan="${p.id}">
            Buy Plan
          </button>
        </div>
      `).join('');

      dashPlansGrid.querySelectorAll('.pay-dash-plan-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const planId = btn.getAttribute('data-plan');
          triggerPaystackRecharge(planId);
        });
      });
    }

  } catch (err) {
    console.error('Error loading dashboard data:', err);
  }
}

/* --------------------------------------------------------------------------
   5. PAYSTACK TOP-UP MODAL & TRANSACTION HANDLER
   -------------------------------------------------------------------------- */
function renderTopupModal() {
  const container = document.getElementById('topup-plans-container');
  if (!container) return;

  const plans = [
    { id: 1, priceGHS: 20, credits: 400, tag: 'Starter' },
    { id: 2, priceGHS: 50, credits: 1000, tag: 'Basic' },
    { id: 3, priceGHS: 100, credits: 2000, tag: 'Growth', popular: true },
    { id: 4, priceGHS: 200, credits: 4000, tag: 'Pro' },
    { id: 5, priceGHS: 500, credits: 10000, tag: 'Business' },
    { id: 6, priceGHS: 1000, credits: 20000, tag: 'Scale' }
  ];

  container.innerHTML = plans.map(p => `
    <div class="relative flex flex-col justify-between rounded-2xl border-2 p-4 ${p.popular ? 'border-ember-500 bg-ember-50/60 dark:bg-ember-500/10' : 'border-transparent bg-cream-100 dark:bg-night-900'}">
        ${p.popular ? '<span class="absolute -top-2.5 left-3 rounded-full bg-ember-500 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white">Popular</span>' : ''}
      <div>
        <div class="text-xs font-bold uppercase tracking-wider text-ink dark:text-slate-400">${p.tag}</div>
        <div class="mt-0.5 text-xl font-black text-navy-900 dark:text-white">GH₵ ${p.priceGHS}</div>
        <div class="mt-1 text-sm font-bold text-teal-600 dark:text-teal-400">${p.credits.toLocaleString()} credits</div>
      </div>
      <button class="btn btn-sm btn-block mt-3 ${p.popular ? 'ks-btn-primary' : 'ks-btn-navy'} pay-modal-btn" data-plan="${p.id}">
        Pay GH₵ ${p.priceGHS}
      </button>
    </div>
  `).join('');

  container.querySelectorAll('.pay-modal-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const planId = btn.getAttribute('data-plan');
      triggerPaystackRecharge(planId);
    });
  });
}

async function triggerPaystackRecharge(planId) {
  if (!currentAuthToken) {
    navigate('register');
    return;
  }

  const modalTopup = document.getElementById('modal-topup');
  if (modalTopup && !modalTopup.open) modalTopup.showModal();

  const statusEl = document.getElementById('topup-status');
  statusEl.classList.remove('hidden');
  statusEl.textContent = 'Opening secure checkout...';

  try {
    const res = await fetch('/api/dashboard/recharge', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${currentAuthToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ planId })
    });
    const data = await res.json();
    if (data.ok && data.checkout_url) {
      statusEl.innerHTML = `Checkout ready. <a href="${data.checkout_url}" target="_blank" class="font-bold text-ember-600 underline">Click here to complete payment</a>`;
      
      setTimeout(async () => {
        const vRes = await fetch(`/api/dashboard/verify-payment?reference=${data.reference}`, {
          headers: { 'Authorization': `Bearer ${currentAuthToken}` }
        });
        const vData = await vRes.json();
        if (vData.ok) {
          statusEl.innerHTML = `<span class="font-bold text-teal-600">Payment successful! Added ${vData.creditsAdded} credits.</span>`;
          loadDashboardData();
        }
      }, 2000);
    }
  } catch (err) {
    statusEl.textContent = 'Error: ' + err.message;
  }
}

/* --------------------------------------------------------------------------
   6. PUBLIC PRICING CALCULATOR & PLANS
   -------------------------------------------------------------------------- */
function initPricingCalculator() {
  const volumeSlider = document.getElementById('calc-volume-slider');
  const volumeInput = document.getElementById('calc-volume-input');
  const destTypeSelect = document.getElementById('calc-dest-type');
  const messageInput = document.getElementById('calc-message-input');

  const charCountEl = document.getElementById('calc-char-count');
  const encodingTypeEl = document.getElementById('calc-encoding-type');
  const segmentsCountEl = document.getElementById('calc-segments-count');
  const ratePerSmsEl = document.getElementById('calc-rate-per-sms');
  const totalCostEl = document.getElementById('calc-total-cost');
  const unitCreditsEl = document.getElementById('calc-unit-credits');

  if (!volumeSlider || !messageInput) return;

  function calculateSegments(text) {
    const isGsm = !/[^\u0000-\u007F]/.test(text);
    const len = text.length;
    if (len === 0) return { segments: 1, isGsm: true };
    if (isGsm) {
      return { segments: len <= 160 ? 1 : Math.ceil(len / 153), isGsm: true };
    }
    return { segments: len <= 70 ? 1 : Math.ceil(len / 67), isGsm: false };
  }

  function updatePricing() {
    const volume = parseInt(volumeSlider.value, 10) || 100;
    volumeInput.value = volume;

    const message = messageInput.value;
    const { segments, isGsm } = calculateSegments(message);

    const isLocal = destTypeSelect.value === 'local';
    const rate = isLocal ? 0.05 : 0.08;

    const totalCost = (volume * segments * rate).toFixed(2);
    const totalCredits = volume * segments * (isLocal ? 1 : 1.6);

    charCountEl.textContent = `${message.length} characters`;
    encodingTypeEl.textContent = isGsm ? 'GSM-7 (Standard)' : 'Unicode (Emoji/Special)';
    encodingTypeEl.className = isGsm
      ? 'badge badge-sm badge-outline text-blue-600 border-blue-600 font-mono'
      : 'badge badge-sm badge-warning font-mono';
    
    segmentsCountEl.textContent = `${segments} ${segments === 1 ? 'part' : 'parts'}`;
    ratePerSmsEl.textContent = `GH₵ ${rate.toFixed(2)} / SMS`;
    totalCostEl.textContent = `GH₵ ${Number(totalCost).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
    unitCreditsEl.textContent = `${Math.round(totalCredits).toLocaleString()} Units`;
  }

  volumeSlider.addEventListener('input', () => {
    volumeInput.value = volumeSlider.value;
    updatePricing();
  });

  volumeInput.addEventListener('input', () => {
    let val = parseInt(volumeInput.value, 10);
    if (isNaN(val) || val < 1) val = 1;
    if (val > 100000) val = 100000;
    volumeSlider.value = val;
    updatePricing();
  });

  destTypeSelect.addEventListener('change', updatePricing);
  messageInput.addEventListener('input', updatePricing);

  updatePricing();
}

async function loadPublicPlans() {
  try {
    const pRes = await fetch('/api/plans');
    if (pRes.ok) {
      const pData = await pRes.json();
      if (pData.pricing && pData.pricing.customSenderIdFeeGHS) {
        currentCustomSenderIdFee = Number(pData.pricing.customSenderIdFeeGHS);
        const feeBadge = document.getElementById('dash-sid-fee-badge');
        if (feeBadge) feeBadge.textContent = `₵${currentCustomSenderIdFee.toFixed(2)}`;
        const feeBtn = document.getElementById('dash-sid-fee-btn');
        if (feeBtn) feeBtn.textContent = `₵${currentCustomSenderIdFee.toFixed(2)}`;
      }
    }
  } catch (e) {}

  const container = document.getElementById('plans-grid-container');
  if (!container) return;

  const plans = [
    { id: 1, priceGHS: 20, credits: 400, tag: 'Starter' },
    { id: 2, priceGHS: 50, credits: 1000, tag: 'Basic' },
    { id: 3, priceGHS: 100, credits: 2000, tag: 'Growth', popular: true },
    { id: 4, priceGHS: 200, credits: 4000, tag: 'Pro' },
    { id: 5, priceGHS: 500, credits: 10000, tag: 'Business' },
    { id: 6, priceGHS: 1000, credits: 20000, tag: 'Scale' }
  ];

  container.innerHTML = plans.map(plan => `
    <div class="ks-card relative flex flex-col p-5 sm:p-6 ${plan.popular ? '!border-2 !border-ember-500' : ''}">
      ${plan.popular ? '<span class="absolute -top-3 left-5 rounded-full bg-ember-500 px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-wide text-white">Most popular</span>' : ''}
      <div class="text-xs font-bold uppercase tracking-wider text-ink dark:text-slate-400">${plan.tag}</div>
      <div class="mt-1 text-3xl font-black text-navy-900 dark:text-white">GH₵ ${plan.priceGHS}</div>
      <div class="mt-1 text-sm font-bold text-teal-600 dark:text-teal-400">${plan.credits.toLocaleString()} credits</div>
      <p class="text-xs text-slate-500 mt-2">Instant top-up via Mobile Money or Card.</p>
      <button class="cta-gate-register btn-block btn-sm mt-auto ${plan.popular ? 'ks-btn-primary' : 'ks-btn-ghost'}" style="margin-top:1.25rem">
        Buy Credits
      </button>
    </div>
  `).join('');

  container.querySelectorAll('.cta-gate-register').forEach(btn => {
    btn.addEventListener('click', () => {
      if (currentUser) {
        navigate('dashboard');
      } else {
        navigate('register');
      }
    });
  });
}

/* --------------------------------------------------------------------------
   7. SENDER ID VALIDATOR & CODE SNIPPETS
   -------------------------------------------------------------------------- */
function initSenderIdValidator() {
  const input = document.getElementById('sid-validator-input');
  const statusBadge = document.getElementById('sid-status-badge');
  const feedbackList = document.getElementById('sid-feedback-list');

  if (!input || !statusBadge) return;

  input.addEventListener('input', () => {
    const val = input.value.trim();
    const len = val.length;
    const isAlphaNum = /^[a-zA-Z0-9_-]+$/.test(val);
    const hasOnlyDigits = /^[0-9]+$/.test(val);

    const issues = [];
    if (len === 0) {
      issues.push('Enter a custom Sender ID (3 to 11 characters).');
    } else {
      if (len < 3) issues.push('Must be at least 3 characters long.');
      if (len > 11) issues.push('Cannot exceed 11 characters.');
      if (!isAlphaNum) issues.push('Only letters, numbers, hyphens allowed.');
      if (hasOnlyDigits) issues.push('Cannot be purely numbers.');
    }

    if (issues.length === 0) {
      statusBadge.textContent = 'Valid Sender ID';
      statusBadge.className = 'badge badge-success font-bold py-3 px-4 text-xs';
      feedbackList.innerHTML = '<li class="font-semibold text-teal-600 dark:text-teal-400">Looks good! You can request it from your dashboard.</li>';
    } else {
      statusBadge.textContent = 'Needs changes';
      statusBadge.className = 'badge badge-warning font-bold py-3 px-4 text-xs';
      feedbackList.innerHTML = issues.map(i => `<li class="text-slate-600 dark:text-slate-400">• ${i}</li>`).join('');
    }
  });
}

function initApiCodeSnippets() {
  const langTabs = document.querySelectorAll('.api-lang-tab');
  const codeBlocks = document.querySelectorAll('.api-code-snippet');

  langTabs.forEach(tab => {
    tab.addEventListener('click', () => {
      langTabs.forEach(t => t.classList.remove('tab-active', 'bg-blue-600', 'text-white'));
      tab.classList.add('tab-active', 'bg-blue-600', 'text-white');

      const targetLang = tab.getAttribute('data-lang');
      document.querySelectorAll('.copy-btn').forEach(b => b.setAttribute('data-target', `code-display-${targetLang}`));
      codeBlocks.forEach(block => {
        if (block.getAttribute('data-lang') === targetLang) {
          block.classList.remove('hidden');
        } else {
          block.classList.add('hidden');
        }
      });
    });
  });

  document.querySelectorAll('.copy-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const targetId = btn.getAttribute('data-target');
      const textEl = document.getElementById(targetId);
      if (textEl) {
        navigator.clipboard.writeText(textEl.textContent.trim());
        btn.textContent = 'Copied!';
        setTimeout(() => btn.textContent = 'Copy', 1500);
      }
    });
  });
}

function initScrollAnimations() {
  const scrollElements = document.querySelectorAll('.scroll-reveal, .scroll-reveal-left, .scroll-reveal-right');
  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) entry.target.classList.add('is-visible');
    });
  }, { threshold: 0.1 });
  scrollElements.forEach(el => observer.observe(el));
}

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/* --------------------------------------------------------------------------
   PASSWORD SHOW / HIDE
   -------------------------------------------------------------------------- */
function initPasswordToggles() {
  document.querySelectorAll('.ks-toggle-password').forEach(btn => {
    btn.addEventListener('click', () => {
      const input = document.getElementById(btn.getAttribute('data-target'));
      if (!input) return;
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      btn.textContent = show ? 'Hide' : 'Show';
    });
  });
}

/* --------------------------------------------------------------------------
   LIVE PHONE PREVIEW IN THE SMS COMPOSER
   -------------------------------------------------------------------------- */
function initComposerPreview() {
  const messageInput = document.getElementById('dash-sms-message');
  const senderSelect = document.getElementById('dash-sms-sender-id');
  const previewText = document.getElementById('dash-sms-preview-text');
  const previewSender = document.getElementById('dash-sms-preview-sender');
  if (!messageInput || !previewText) return;

  const placeholder = 'Your message will appear here.';
  const update = () => {
    const text = messageInput.value.trim();
    previewText.textContent = text || placeholder;
    previewText.classList.toggle('text-ink', !text);
    if (previewSender && senderSelect) previewSender.textContent = senderSelect.value || 'TXTORA';
  };
  messageInput.addEventListener('input', update);
  if (senderSelect) {
    senderSelect.addEventListener('change', update);
    // Sender IDs are loaded after sign-in; keep the preview in sync when options change.
    new MutationObserver(update).observe(senderSelect, { childList: true });
  }
  update();
}

/* --------------------------------------------------------------------------
   "WHO IT'S FOR" AUDIENCE SWITCHER (landing page)
   -------------------------------------------------------------------------- */
function initAudienceSwitcher() {
  const tabs = Array.from(document.querySelectorAll('.ks-aud-tab'));
  const panels = document.querySelectorAll('[data-audience-panel]');
  if (!tabs.length) return;

  const select = (key) => {
    tabs.forEach(t => t.setAttribute('aria-selected', String(t.dataset.audience === key)));
    panels.forEach(p => p.classList.toggle('hidden', p.dataset.audiencePanel !== key));
  };

  // Rotate through audiences until the visitor picks one (skipped for reduced motion)
  let timer = null;
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!reduce) {
    let i = 0;
    timer = setInterval(() => { i = (i + 1) % tabs.length; select(tabs[i].dataset.audience); }, 5000);
  }
  const stop = () => { if (timer) { clearInterval(timer); timer = null; } };

  tabs.forEach((tab, idx) => {
    tab.addEventListener('click', () => { stop(); select(tab.dataset.audience); });
    tab.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowDown' && e.key !== 'ArrowLeft' && e.key !== 'ArrowUp') return;
      e.preventDefault(); stop();
      const next = tabs[(idx + (e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : tabs.length - 1)) % tabs.length];
      select(next.dataset.audience); next.focus();
    });
  });
}
