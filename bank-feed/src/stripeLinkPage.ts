// The Stripe Financial Connections linking page, served by this Worker so Stripe.js runs on an HTTPS origin.
//
// Why it exists: the desktop app's renderer is loaded from file:// (packaged and dev-build alike). Stripe's
// Financial Connections authentication frame (connections-auth.stripe.com) sends "frame-ancestors *", which
// matches only network schemes, so it refuses to load anywhere inside a file:// page -- the modal then hangs
// on "Hang on, nearly there". The desktop therefore opens THIS page as the top-level page of its own small,
// sandboxed window (no Node, no preload) and never mounts Stripe.js in the main renderer.
//
//   GET /stripe/link#cs=<clientSecret>&pk=<publishableKey>&sid=<sessionId>
//       Everything it needs arrives in the URL fragment (never the query string, so never sent to or logged by
//       this Worker). The client secret authorises collecting accounts for exactly one Session.
//       When Stripe finishes it replaces itself with /stripe/link/done?status=...; the desktop watches for that
//       navigation, cancels it, reads the status, and closes the window.
//   GET /stripe/link/done?status=connected|cancelled|error&session=<id>&message=<text>
//       A static page ("you can close this window") -- it only exists so the redirect target resolves if the
//       window is opened in an ordinary browser. It carries no secret.
//
// Account linking itself is unchanged: the desktop then calls POST /stripe/connections/complete with the session
// id, and this Worker lists the accounts for that session from Stripe with the Business's own key.

const responseHeaders = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  // The page is only ever a top-level page; it must never be framed.
  'content-security-policy': "frame-ancestors 'none'",
}

const pageStyle = `
  body { font: 15px/1.5 -apple-system, "Segoe UI", Roboto, sans-serif; margin: 0; padding: 24px; color: #1f2933; background: #f5f7fa; }
  .card { max-width: 420px; margin: 40px auto; background: #fff; border-radius: 12px; padding: 24px; box-shadow: 0 1px 3px rgba(0,0,0,0.12); }
  h1 { font-size: 17px; margin: 0 0 8px; }
  p { margin: 0; color: #52606d; }
`

export function renderStripeLinkHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, minimum-scale=1" />
<title>Connect a bank account</title>
<script src="https://js.stripe.com/v3/"></script>
<style>${pageStyle}</style>
</head>
<body>
<div class="card">
  <h1>Connect a bank account</h1>
  <p id="link-message">Opening Stripe&hellip;</p>
</div>
<script>
(function () {
  var params = new URLSearchParams((location.hash || '').replace(/^#/, ''));
  var clientSecret = params.get('cs') || '';
  var publishableKey = params.get('pk') || '';
  var sessionId = params.get('sid') || '';
  var message = document.getElementById('link-message');

  function finish(status, extra) {
    var query = new URLSearchParams(Object.assign({ status: status }, extra || {}));
    // replace(), so the fragment carrying the client secret leaves the window's history too.
    location.replace('/stripe/link/done?' + query.toString());
  }

  if (!clientSecret || !publishableKey || typeof Stripe !== 'function') {
    finish('error', { message: typeof Stripe !== 'function' ? 'Stripe could not be loaded.' : 'The link details are missing.' });
    return;
  }

  var stripe = Stripe(publishableKey);
  stripe.collectFinancialConnectionsAccounts({ clientSecret: clientSecret }).then(function (result) {
    if (result && result.error) {
      finish('error', { message: (result.error.message || 'Stripe could not complete the bank connection.').slice(0, 200) });
      return;
    }
    var session = result && result.financialConnectionsSession;
    var linked = (session && session.accounts) || [];
    finish(linked.length > 0 ? 'connected' : 'cancelled', { session: (session && session.id) || sessionId });
  }).catch(function (error) {
    message.textContent = 'Something went wrong.';
    finish('error', { message: String((error && error.message) || error).slice(0, 200) });
  });
})();
</script>
</body>
</html>`
}

export function renderStripeLinkDoneHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Bank connection</title>
<style>${pageStyle}</style>
</head>
<body>
<div class="card">
  <h1>All done</h1>
  <p>You can close this window and return to Business Suite.</p>
</div>
</body>
</html>`
}

export function handleStripeLinkPage(request: Request): Response {
  if (request.method !== 'GET') return new Response('Method not allowed', { status: 405, headers: { allow: 'GET' } })
  return new Response(renderStripeLinkHtml(), { status: 200, headers: responseHeaders })
}

export function handleStripeLinkDonePage(request: Request): Response {
  if (request.method !== 'GET') return new Response('Method not allowed', { status: 405, headers: { allow: 'GET' } })
  return new Response(renderStripeLinkDoneHtml(), { status: 200, headers: responseHeaders })
}
