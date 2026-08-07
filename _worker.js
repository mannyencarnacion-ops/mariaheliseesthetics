/**
 * Mariah Elise Esthetics — lead handler (Cloudflare Pages Function)
 * Route: /api/lead
 *
 * ShopMora form standard. The rule: NEVER fake success.
 * Every failure returns a real error page, sets X-Lead-Error, and logs.
 *
 * !! Cloudflare edge trap: a Pages Function returning any 5xx has its body AND
 * headers replaced by Cloudflare's own generic error page — our branded error
 * page and the diagnostic header both vanish. So upstream failures return 424
 * (Failed Dependency): 4xx passes through untouched and honestly means
 * "our mail provider failed". Never use 5xx here.
 *
 * Env (Cloudflare Pages > Settings > Variables and secrets):
 *   RESEND_API_KEY  (type: Secret)  — from Mariah's OWN Resend account
 *   LEAD_TO         e.g. mariah@mariaheliseesthetics.com
 *   LEAD_FROM       e.g. Mariah Elise Esthetics <hello@mariaheliseesthetics.com>
 *
 * Env vars only bind on a NEW build. After adding them, redeploy
 * (git commit --allow-empty is the cleanest trigger).
 */

const ORIGIN = 'https://www.mariaheliseesthetics.com';
const BOOKING = 'https://mariaheliseesthetics.as.me/';
const INSTAGRAM = 'https://www.instagram.com/mariahelise.esthetics/';
const EMAIL = 'contact@mariaheliseesthetics.com';

const FORMS = {
  contact: {
    subject: 'New message from mariaheliseesthetics.com',
    thankYou: '/thank-you',
    required: ['name', 'email', 'message'],
    autoSubject: 'I got your message — Mariah Elise Esthetics',
    autoBody: (d) =>
      'Hi ' + d.name + ',\n\n' +
      "Thanks for reaching out. I've got your message and I read every one myself.\n\n" +
      "You'll hear back from me within one business day. If you'd rather not wait, the online " +
      'calendar shows real availability and books instantly:\n' + BOOKING + '\n\n' +
      'Talk soon,\nMariah\nMariah Elise Esthetics\n580 N Main St, Leominster, MA 01453'
  }
};

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

function isEmail(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(s == null ? '' : s).trim());
}

/** Failure page. Always carries a human fallback so the lead is never stranded. */
function errorPage(msg, status, detail) {
  const html =
    '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta name="robots" content="noindex">' +
    '<title>That didn’t send — Mariah Elise Esthetics</title>' +
    '<style>body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;background:#0C0B09;' +
    'color:#F3EEE6;display:grid;place-items:center;min-height:100vh;margin:0;padding:24px;' +
    'line-height:1.65}.box{max-width:540px;text-align:center}' +
    'h1{font-family:Georgia,"Times New Roman",serif;font-weight:400;font-size:2.5rem;' +
    'margin:0 0 14px;line-height:1.1}p{color:#B5AC9E;margin:0 0 20px}' +
    'a.btn{display:inline-block;background:#C9AE85;color:#0C0B09;padding:14px 30px;' +
    'border:1px solid #C9AE85;text-decoration:none;font-weight:600;letter-spacing:.1em;' +
    'text-transform:uppercase;font-size:.85rem}a.inline{color:#C9AE85}</style></head><body>' +
    '<div class="box"><h1>That didn’t send.</h1><p>' + esc(msg) + '</p>' +
    '<p>Nothing reached me, so nothing is lost on your end — please email ' +
    '<a class="inline" href="mailto:' + EMAIL + '">' + EMAIL + '</a>, book directly using the ' +
    'calendar below, or message me on <a class="inline" href="' + INSTAGRAM + '">Instagram</a>.</p>' +
    '<a class="btn" href="' + BOOKING + '">Book an appointment</a>' +
    '<p style="margin-top:26px"><a class="inline" href="' + ORIGIN + '/contact">Back to the form</a></p>' +
    '</div></body></html>';

  const headers = { 'Content-Type': 'text/html;charset=utf-8', 'Cache-Control': 'no-store' };
  if (detail) {
    headers['X-Lead-Error'] = String(detail).replace(/[\r\n]+/g, ' ').slice(0, 300);
  }
  return new Response(html, { status: status, headers: headers });
}

function redirectTo(path) {
  return new Response(null, {
    status: 303,
    headers: { Location: ORIGIN + path, 'Cache-Control': 'no-store' }
  });
}

async function sendViaResend(env, payload) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + env.RESEND_API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });
  const text = await res.text();
  if (!res.ok) throw new Error('Resend ' + res.status + ': ' + text.slice(0, 200));
  return text;
}

async function onRequestPost(context) {
  // Top-level guard: nothing escapes as an opaque platform 502.
  try {
    const request = context.request;
    const env = context.env || {};

    if (!env.RESEND_API_KEY) {
      return errorPage(
        'Our message form isn’t connected yet.',
        424,
        'RESEND_API_KEY missing — set env vars in Pages and redeploy'
      );
    }
    if (!env.LEAD_TO || !env.LEAD_FROM) {
      return errorPage(
        'Our message form is misconfigured on our end.',
        424,
        'RESEND_API_KEY set but LEAD_TO/LEAD_FROM missing'
      );
    }

    let data;
    try {
      const ct = request.headers.get('content-type') || '';
      if (ct.indexOf('application/json') !== -1) {
        data = await request.json();
      } else {
        data = Object.fromEntries(await request.formData());
      }
    } catch (e) {
      return errorPage('We could not read that submission.', 400, 'parse: ' + e.message);
    }

    const form = FORMS[data._form] || FORMS.contact;

    const missing = form.required.filter(function (f) {
      return !String(data[f] == null ? '' : data[f]).trim();
    });
    if (missing.length) {
      return errorPage('Please fill in: ' + missing.join(', ') + '.', 400, 'missing: ' + missing.join(','));
    }
    if (!isEmail(data.email)) {
      return errorPage('That email address does not look right.', 400, 'bad email');
    }

    const clean = {};
    Object.keys(data).forEach(function (k) {
      if (k.charAt(0) !== '_') clean[k] = data[k];
    });

    // --- the notification IS the lead ---
    try {
      const rows = Object.keys(clean).map(function (k) {
        return '<tr><td style="padding:8px 14px;border:1px solid #ddd;font-weight:700;text-transform:capitalize">' +
          esc(k) + '</td><td style="padding:8px 14px;border:1px solid #ddd">' + esc(clean[k]) + '</td></tr>';
      }).join('');
      await sendViaResend(env, {
        from: env.LEAD_FROM,
        to: [env.LEAD_TO],
        reply_to: String(data.email).trim(),
        subject: form.subject,
        html: '<div style="font-family:system-ui,sans-serif;color:#1a1a1a">' +
          '<h2>New message from the website</h2>' +
          '<table style="border-collapse:collapse;margin:16px 0">' + rows + '</table>' +
          '<p style="color:#666;font-size:12px">' + esc(new Date().toISOString()) + '</p></div>'
      });
    } catch (e) {
      console.error('lead: NOTIFICATION FAILED', e && e.message);
      return errorPage('We could not deliver your message just now.', 424, e && e.message);
    }

    // --- autoresponse: courtesy only, never blocks the lead ---
    try {
      await sendViaResend(env, {
        from: env.LEAD_FROM,
        to: [String(data.email).trim()],
        reply_to: env.LEAD_TO,
        subject: form.autoSubject,
        text: form.autoBody(data)
      });
    } catch (e) {
      console.error('lead: AUTORESPONSE FAILED (lead still captured)', e && e.message);
    }

    return redirectTo(form.thankYou);
  } catch (e) {
    console.error('lead: UNHANDLED', e && e.stack);
    return errorPage('Something broke on our end.', 424, 'unhandled: ' + (e && e.message));
  }
}

async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const env = context.env || {};

  // /api/lead?selftest=1 — exercises the LIVE delivery path and reports the raw
  // result as plain text. Diagnosable without dashboard access.
  if (url.searchParams.get('selftest') === '1') {
    const started = Date.now();
    if (!env.RESEND_API_KEY || !env.LEAD_TO || !env.LEAD_FROM) {
      return new Response(
        'SELFTEST FAILED: env not set. Need RESEND_API_KEY (secret), LEAD_TO, LEAD_FROM ' +
        'in Cloudflare Pages > Settings > Variables and secrets, then REDEPLOY.\n' +
        'RESEND_API_KEY=' + (env.RESEND_API_KEY ? 'set' : 'MISSING') +
        ' LEAD_TO=' + (env.LEAD_TO ? 'set' : 'MISSING') +
        ' LEAD_FROM=' + (env.LEAD_FROM ? 'set' : 'MISSING'),
        { status: 424, headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' } }
      );
    }
    try {
      const r = await sendViaResend(env, {
        from: env.LEAD_FROM,
        to: [env.LEAD_TO],
        subject: 'Selftest — mariaheliseesthetics.com /api/lead',
        text: 'Delivery path is live. Sent ' + new Date().toISOString()
      });
      return new Response('SELFTEST OK in ' + (Date.now() - started) + 'ms\n' + r, {
        status: 200,
        headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }
      });
    } catch (e) {
      return new Response('SELFTEST FAILED after ' + (Date.now() - started) + 'ms\n' + (e && e.message), {
        status: 424,
        headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }
      });
    }
  }

  return new Response('Mariah Elise Esthetics lead endpoint is alive. POST only.', {
    status: 405,
    headers: { 'Content-Type': 'text/plain', Allow: 'POST' }
  });
}


/**
 * Advanced-mode entry point.
 * Cloudflare Pages DIRECT UPLOAD (dashboard drag-drop) does not compile the
 * functions/ directory — only a root _worker.js. This routes /api/lead to the
 * handlers above and hands everything else to the static asset server, so the
 * form works identically whether the project was deployed by upload or by Git.
 * This file is the single source of truth for the lead endpoint.
 */
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/api/lead' || url.pathname === '/api/lead/') {
      const context = { request: request, env: env, waitUntil: ctx.waitUntil.bind(ctx) };
      if (request.method === 'POST') return onRequestPost(context);
      if (request.method === 'GET') return onRequestGet(context);
      return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, POST' } });
    }
    return env.ASSETS.fetch(request);
  }
};
