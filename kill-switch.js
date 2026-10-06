/**
 * Kill Switch — reads the tools_enabled flag from the n8n verify-membership
 * webhook (which the backend returns on every call). If disabled, shows a
 * branded maintenance message and blocks the app. Load BEFORE membership-gate.js.
 *
 * The flag lives in Supabase app_config, but only n8n ever reads it — the
 * browser sees only the webhook response. To toggle:
 *   UPDATE app_config SET value='false' WHERE key='tools_enabled';  -- disable
 *   UPDATE app_config SET value='true'  WHERE key='tools_enabled';  -- enable
 */
const KillSwitch = (function() {
  const CHECK_INTERVAL = 5 * 60 * 1000; // re-check every 5 minutes
  let _isEnabled = true;
  let _checkTimer = null;

  async function checkStatus() {
    try {
      const base = (window.APP_CONFIG && window.APP_CONFIG.n8nWebhookBase) || '';
      const resp = await fetch(base + '/verify-membership', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}'
      });
      const data = await resp.json();

      _isEnabled = data.tools_enabled !== false;

      if (!_isEnabled) {
        showMaintenancePage();
      }

      return _isEnabled;
    } catch {
      return true;
    }
  }

  function showMaintenancePage() {
    document.querySelectorAll('.screen').forEach(function(s) {
      s.classList.remove('active');
      s.style.display = 'none';
    });

    let overlay = document.getElementById('killswitch-overlay');
    if (overlay) {
      overlay.style.display = 'flex';
      return;
    }

    overlay = document.createElement('div');
    overlay.id = 'killswitch-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;background:#f4f1ea;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;';
    overlay.innerHTML = '<div style="text-align:center;max-width:480px;padding:40px 32px;background:#fff;border:1px solid #e3dccd;border-top:5px solid #d81b60;border-radius:12px;box-shadow:0 24px 60px -30px rgba(22,20,15,.4);">' +
      '<div style="font-family:ui-monospace,Menlo,monospace;font-size:11px;letter-spacing:.22em;color:#d81b60;font-weight:700;margin-bottom:14px;">EDIÇÃO EM PAUSA</div>' +
      '<h1 style="font-size:34px;font-weight:800;margin-bottom:14px;color:#16140f;letter-spacing:-.01em;">Em manutenção</h1>' +
      '<p style="color:#5c564a;font-size:16px;line-height:1.6;margin-bottom:24px;">Estamos preparando melhorias no Mídia Kit IA. Ele volta ao ar em breve.</p>' +
      '<div style="display:inline-block;background:#f4f1ea;color:#16140f;padding:8px 20px;border-radius:100px;font-size:13px;font-weight:700;border:1px solid #a9864f;">Maestros da IA</div>' +
      '</div>';
    document.body.appendChild(overlay);
  }

  function startPeriodicCheck() {
    if (_checkTimer) clearInterval(_checkTimer);
    _checkTimer = setInterval(checkStatus, CHECK_INTERVAL);
  }

  async function init() {
    const enabled = await checkStatus();
    if (enabled) {
      startPeriodicCheck();
    }
    return enabled;
  }

  return {
    init: init,
    checkStatus: checkStatus,
    isEnabled: function() { return _isEnabled; }
  };
})();

window.KillSwitch = KillSwitch;
