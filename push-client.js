// push-client.js
// Shared by the member app (/member/) and the staff mobile app (/mobile/):
// draws a "Turn on notifications" control and handles the browser side of
// web push — permission, subscribing through the app's service worker, and
// saving the subscription with api/push-subscribe.js.
//
//   LVBC_PUSH.mount('element-id', 'member' | 'staff')
//
// Depends on: window.supabase (the app's signed-in client). The service
// worker (member/sw.js, mobile/sw.js) shows the notification itself.
// iPhone only allows web push once the app is added to the Home Screen.

window.LVBC_PUSH = (function () {
  const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

  function urlBase64ToUint8Array(b64) {
    const pad = '='.repeat((4 - (b64.length % 4)) % 4);
    const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(raw, (c) => c.charCodeAt(0));
  }

  async function authHeaders() {
    const { data: { session } } = await window.supabase.auth.getSession();
    if (!session) throw new Error('Sign in first.');
    return { 'Content-Type': 'application/json', Authorization: 'Bearer ' + session.access_token };
  }

  async function currentSubscription() {
    const reg = await navigator.serviceWorker.ready;
    return reg.pushManager.getSubscription();
  }

  async function enable(audience) {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') throw new Error('Notifications are blocked. Allow them in your browser or phone settings, then try again.');
    const keyRes = await fetch('/api/push-subscribe');
    const keyData = await keyRes.json();
    if (!keyRes.ok) throw new Error(keyData.error || 'Notifications are not available yet.');
    const reg = await navigator.serviceWorker.ready;
    const sub = (await reg.pushManager.getSubscription())
      || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(keyData.publicKey) });
    const res = await fetch('/api/push-subscribe', {
      method: 'POST', headers: await authHeaders(), body: JSON.stringify({ subscription: sub.toJSON(), audience }),
    });
    if (!res.ok) throw new Error((await res.json()).error || 'Could not turn on notifications.');
  }

  async function disable(audience) {
    const sub = await currentSubscription();
    if (!sub) return;
    await fetch('/api/push-subscribe', {
      method: 'DELETE', headers: await authHeaders(), body: JSON.stringify({ endpoint: sub.endpoint, audience }),
    }).catch(() => { /* the push service will drop it on the next send anyway */ });
    await sub.unsubscribe();
  }

  async function mount(elId, audience) {
    const el = document.getElementById(elId);
    if (!el) return;
    const render = async (msg, isError) => {
      let on = false;
      if (supported && Notification.permission === 'granted') on = !!(await currentSubscription().catch(() => null));
      const blocked = supported && Notification.permission === 'denied';
      const label = on ? 'Turn Off' : 'Turn On';
      el.innerHTML =
        '<div class="comms-row" style="display:flex;align-items:center;justify-content:space-between;gap:12px;">'
        + '<div><div class="comms-label">Push Notifications</div>'
        + '<div class="comms-desc">' + (
          !supported ? 'Not supported on this device. On iPhone, add the app to your Home Screen first.'
          : blocked ? 'Blocked in your browser settings.'
          : on ? 'On for this device.' : 'Get alerts from the brewery on this device.') + '</div></div>'
        + (supported && !blocked ? '<button class="btn btn-secondary btn-sm" id="' + elId + '-btn">' + label + '</button>' : '')
        + '</div>'
        + (msg ? '<div style="font-size:12px;margin-top:6px;color:' + (isError ? 'var(--red)' : 'var(--teal)') + ';">' + msg + '</div>' : '');
      const btn = document.getElementById(elId + '-btn');
      if (btn) btn.onclick = async () => {
        btn.disabled = true;
        try {
          if (on) await disable(audience); else await enable(audience);
          render(on ? 'Notifications turned off.' : 'Notifications turned on.');
        } catch (e) { render(e.message, true); }
      };
    };
    render();
  }

  return { mount };
})();
