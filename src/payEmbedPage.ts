// The card-entry page, served by the Payments Worker in two ways with identical behaviour:
//   - GET /pay-embed#cs=<clientSecret>&pk=<publishableKey>&amt=<cents>&cur=<currency>[&mock=1] -- the
//     desktop invoice editor embeds it inline (an <iframe>), so the Stripe card fields run on this HTTPS
//     origin (the Electron renderer loads from file:// in the packaged app, where Stripe.js cannot
//     mount, and raw card data never reaches the desktop app's own code -- PCI SAQ A). Everything it
//     needs arrives in the URL fragment (never the query string, so never logged); the client secret
//     authorises confirming exactly one PaymentIntent and nothing else.
//   - GET /pay/<linkToken> -- the hosted payment link. The token is an unguessable capability for one
//     invoice; the page asks POST /pay/<linkToken>/intent for a fresh PaymentIntent and then behaves
//     exactly as above. A link can be emailed, texted, opened on a jobsite, or embedded in a Client
//     Portal page -- Payments do not depend on Client Portal.
//
// Mock mode (development, no real key): shows "Simulate" buttons that POST to
// /payment-gateway/stripe/mock-complete, which runs the exact same server path the real webhook would.
// On completion (real or mock) it posts a message to its parent frame:
//   window.parent.postMessage({ type: 'solesystems-payment', status: 'succeeded' | 'failed' }, '*')

export function renderPayEmbedHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Pay Invoice</title>
<script src="https://js.stripe.com/v3/"></script>
<style>
  body { font: 15px/1.5 -apple-system, "Segoe UI", Roboto, sans-serif; margin: 0; padding: 20px; color: #1f2933; background: #f5f7fa; }
  .pay-card { max-width: 460px; margin: 0 auto; background: #fff; border-radius: 12px; padding: 24px; box-shadow: 0 1px 3px rgba(0,0,0,0.12); }
  h1 { font-size: 16px; margin: 0 0 4px; }
  .pay-amount { font-size: 28px; font-weight: 700; margin: 0 0 16px; }
  button { font: inherit; padding: 10px 16px; border-radius: 8px; border: 0; cursor: pointer; background: #1f2933; color: #fff; }
  button.secondary { background: #e4e7eb; color: #1f2933; }
  button:disabled { opacity: 0.5; cursor: default; }
  #payment-element { margin: 16px 0; }
  .pay-message { margin-top: 12px; min-height: 20px; color: #52606d; }
  .pay-message.error { color: #b91c1c; }
  .pay-message.ok { color: #047857; }
  .pay-mock-note { font-size: 12px; color: #7b8794; margin-bottom: 12px; }
</style>
</head>
<body>
<div class="pay-card">
  <h1>Invoice payment</h1>
  <p class="pay-amount" id="pay-amount">&mdash;</p>
  <div id="pay-mock" hidden>
    <p class="pay-mock-note">Development mock &mdash; no real card is charged.</p>
    <button type="button" id="mock-succeed">Simulate successful payment</button>
    <button type="button" id="mock-fail" class="secondary">Simulate a failed payment</button>
  </div>
  <div id="pay-real" hidden>
    <div id="payment-element"></div>
    <button type="button" id="pay-submit">Pay now</button>
  </div>
  <div class="pay-message" id="pay-message"></div>
</div>
<script>
(function () {
  var params = new URLSearchParams((location.hash || '').replace(/^#/, ''));
  var clientSecret = params.get('cs') || '';
  var publishableKey = params.get('pk') || '';
  var amountCents = parseInt(params.get('amt') || '0', 10);
  var currency = (params.get('cur') || 'usd').toUpperCase();
  var isMock = params.get('mock') === '1' || clientSecret.indexOf('pi_mock_') === 0;
  var linkMatch = location.pathname.match(/^\/pay\/([a-f0-9]{64})$/);

  var messageEl = document.getElementById('pay-message');
  function setMessage(text, tone) {
    messageEl.textContent = text || '';
    messageEl.className = 'pay-message' + (tone ? ' ' + tone : '');
  }
  function notifyParent(status) {
    try { window.parent.postMessage({ type: 'solesystems-payment', status: status }, '*'); } catch (e) {}
  }

  if (linkMatch) {
    // Hosted payment link: get a PaymentIntent for this invoice, then continue exactly as the embed does.
    fetch('/pay/' + linkMatch[1] + '/intent', { method: 'POST' })
      .then(function (r) { return r.json(); })
      .then(function (body) {
        if (!body || !body.ok) {
          setMessage((body && body.message) || 'This payment link is not available.', 'error');
          return;
        }
        if (body.title) document.querySelector('.pay-card h1').textContent = body.title;
        clientSecret = body.clientSecret;
        publishableKey = body.publishableKey;
        amountCents = body.amountCents;
        currency = String(body.currency || 'usd').toUpperCase();
        isMock = Boolean(body.mock);
        start();
      })
      .catch(function () { setMessage('Could not reach the payment service.', 'error'); });
  } else {
    start();
  }

  function start() {

  try {
    document.getElementById('pay-amount').textContent =
      new Intl.NumberFormat('en-US', { style: 'currency', currency: currency }).format(amountCents / 100);
  } catch (e) {
    document.getElementById('pay-amount').textContent = (amountCents / 100).toFixed(2) + ' ' + currency;
  }

  if (!clientSecret) { setMessage('This payment link is missing its details.', 'error'); return; }

  if (isMock) {
    document.getElementById('pay-mock').hidden = false;
    var paymentIntentId = clientSecret.split('_secret_')[0];
    function mockComplete(outcome, button) {
      button.disabled = true;
      setMessage(outcome === 'failed' ? 'Simulating a failed payment...' : 'Simulating a successful payment...');
      fetch('/payment-gateway/stripe/mock-complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paymentIntentId: paymentIntentId, outcome: outcome })
      }).then(function (r) { return r.json(); }).then(function (body) {
        if (body && body.ok) {
          setMessage(outcome === 'failed' ? 'Payment marked as failed.' : 'Payment successful. Thank you!', outcome === 'failed' ? 'error' : 'ok');
          notifyParent(outcome === 'failed' ? 'failed' : 'succeeded');
        } else {
          setMessage((body && body.message) || 'Could not complete the simulated payment.', 'error');
          button.disabled = false;
        }
      }).catch(function () { setMessage('Could not reach the payment service.', 'error'); button.disabled = false; });
    }
    document.getElementById('mock-succeed').onclick = function () { mockComplete('succeeded', this); };
    document.getElementById('mock-fail').onclick = function () { mockComplete('failed', this); };
    return;
  }

  if (!window.Stripe || !publishableKey) { setMessage('Card payments are unavailable right now.', 'error'); return; }

  document.getElementById('pay-real').hidden = false;
  // The PaymentIntent belongs to the Business's own Stripe account, so its own publishable key is all
  // Stripe.js needs.
  var stripe = window.Stripe(publishableKey);
  var elements = stripe.elements({ clientSecret: clientSecret });
  elements.create('payment').mount('#payment-element');

  document.getElementById('pay-submit').onclick = function () {
    var submit = this;
    submit.disabled = true;
    setMessage('Processing payment...');
    stripe.confirmPayment({
      elements: elements,
      confirmParams: { return_url: location.origin + '/pay-embed' },
      redirect: 'if_required'
    }).then(function (result) {
      if (result.error) {
        setMessage(result.error.message || 'The payment could not be completed.', 'error');
        submit.disabled = false;
      } else if (result.paymentIntent && result.paymentIntent.status === 'succeeded') {
        setMessage('Payment successful. Thank you!', 'ok');
        notifyParent('succeeded');
      } else {
        setMessage('Payment is processing. You will get a confirmation shortly.', 'ok');
        notifyParent('processing');
      }
    });
  };
  }
})();
</script>
</body>
</html>`
}
