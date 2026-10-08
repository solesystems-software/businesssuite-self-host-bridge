// Client_Portal_Mode_CR_Task_Spec_20260822.md Part B Phase 3/4: the static, backend-agnostic portal
// page a Business embeds on their own site via <iframe src="https://.../embed/{inviteToken}">. Served
// directly by this same Worker (source plan section 5/17 says "Cloudflare Pages/Workers" -- serving it
// from the Worker avoids a second Cloudflare Pages project/build pipeline for what is a genuinely small,
// dependency-light page). Plain HTML/CSS/vanilla JS, no build step, no framework -- this page runs in an
// arbitrary Client's browser on an arbitrary Business's website, not inside this codebase's own
// Electron/Vite pipeline, so it cannot import anything from this repo's desktop app; pdf.js and
// signature_pad are loaded from a CDN (jsdelivr), the same two libraries the desktop Signing UI screen
// already uses server-side-adjacent (FieldsSignaturesSigningScreen.tsx / SignatureCaptureBlock.tsx) --
// this is a genuinely separate browser-side reimplementation of the same interaction, not shared code,
// exactly as Client_Portal_Mode_CR_Task_Spec_20260822.md Part B Phase 4 step 1 anticipated.
//
// Phase 3 (read-only) and Phase 4 (signing + photo upload) are built together here rather than as two
// separate deploys, since Phase 4 only adds interactivity on top of Phase 3's exact same render pass --
// splitting them would mean throwing away and rebuilding the same page shell.
//
// Reworked (2026-08-23, Client_Portal_and_Contracts_Corrections_Task_Spec_20260823.md follow-up):
// the previous version rendered every document's full PDF + fields inline at once, and photos as a
// thumbnail grid -- neither matched "the client-side and application side are the same in appearance,
// excluding only the checkboxes in the leftmost column." Contracts and Photos are now each a
// FilesSelector-style list (bordered header + clickable rows) -- click a row to open that one
// document/photo in place (back arrow returns to the list), the same list/open-file/back-arrow
// pattern src/components/FilesSelector.tsx uses app-side, just without a checkbox column (this page
// has nothing to select -- selection already happened application-side before Publish). Signature
// fields also no longer show their full Draw/Type/canvas/Use capture UI inline over the document at
// all times -- that read as "inserted over" the document, cluttered. A field is now a single clean
// clickable box (yellow, matching the existing .portal-field-input/FieldsSignaturesSigningScreen.css
// convention) that opens a shared modal (outside the document's own layout entirely) to actually
// capture the signature; once captured, the field collapses back to one clean box showing the real
// captured signature image (or typed name) instead of a generic "Captured" label.

// relayOrigin (e.g. "https://businesssuite-client-portal.<account>.workers.dev", from the incoming
// request's own url.origin -- see clientPortalWorkerEntry.ts) drives the oEmbed discovery <link> tag
// below (Client_Portal_and_Contracts_Corrections_Task_Spec_20260823.md): this is what lets a Business
// paste this page's bare /embed/{inviteToken} URL directly into WordPress's block editor and have it
// auto-render as an embedded iframe, rather than requiring the Business to build their own
// <iframe src="..."> snippet by hand. See handleOembed in clientPortalWorkerEntry.ts for the endpoint
// this link points to. (Publii and some other site builders have no such auto-embed mechanism at all
// -- see ClientPortalModule.tsx's own "Embed code" field, a ready iframe snippet for those tools.)
export function renderEmbedShellHtml(inviteToken: string, relayOrigin: string): string {
  const escapedToken = inviteToken.replace(/[^a-f0-9]/g, '')
  const embedUrl = `${relayOrigin}/embed/${escapedToken}`
  const oembedDiscoveryUrl = `${relayOrigin}/oembed?url=${encodeURIComponent(embedUrl)}&format=json`

  return '<!doctype html>\n' +
    '<html lang="en">\n' +
    '<head>\n' +
    '<meta charset="utf-8" />\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1" />\n' +
    '<title>Client Portal</title>\n' +
    '<link rel="alternate" type="application/json+oembed" href="' + oembedDiscoveryUrl + '" title="Client Portal" />\n' +
    '<script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.6.82/pdf.min.mjs" type="module" id="pdfjs-script"></script>\n' +
    '<script src="https://cdn.jsdelivr.net/npm/signature_pad@5.0.4/dist/signature_pad.umd.min.js"></script>\n' +
    '<style>' + embedShellCss + '</style>\n' +
    '</head>\n' +
    '<body>\n' +
    '<div id="portal-root">\n' +
    '  <div id="portal-loading">Loading...</div>\n' +
    '  <div id="portal-error" class="portal-hidden"></div>\n' +
    '  <div id="portal-content" class="portal-hidden">\n' +
    '    <h1 id="portal-title"></h1>\n' +
    '    <p id="portal-job-summary"></p>\n' +
    '    <div id="portal-contracts-section" class="portal-files-selector portal-hidden">\n' +
    '      <div class="portal-files-selector-header">\n' +
    '        <button type="button" id="portal-contracts-back" class="portal-files-selector-back portal-hidden">&larr;</button>\n' +
    '        <span class="portal-files-selector-header-title">Contracts</span>\n' +
    '      </div>\n' +
    '      <div id="portal-contracts-list" class="portal-files-selector-list"></div>\n' +
    '      <div id="portal-contracts-open" class="portal-hidden"></div>\n' +
    '    </div>\n' +
    '    <div id="portal-photos-section" class="portal-files-selector portal-hidden">\n' +
    '      <div class="portal-files-selector-header">\n' +
    '        <button type="button" id="portal-photos-back" class="portal-files-selector-back portal-hidden">&larr;</button>\n' +
    '        <span class="portal-files-selector-header-title">Photos</span>\n' +
    '      </div>\n' +
    '      <div id="portal-photos-list" class="portal-files-selector-list"></div>\n' +
    '      <div id="portal-photos-open" class="portal-hidden"></div>\n' +
    '    </div>\n' +
    '    <div id="portal-notes-section" class="portal-notes-section portal-hidden">\n' +
    '      <div class="portal-files-selector-header"><span class="portal-files-selector-header-title">Notes</span></div>\n' +
    '      <div id="portal-notes-body" class="portal-notes-body"></div>\n' +
    '    </div>\n' +
    '    <div id="portal-payment-section" class="portal-files-selector portal-hidden">\n' +
    '      <div class="portal-files-selector-header"><span class="portal-files-selector-header-title" id="portal-payment-title">Payment</span></div>\n' +
    '      <div id="portal-payment-summary"></div>\n' +
    '      <button type="button" id="portal-payment-pay">Pay Now</button>\n' +
    '      <div id="portal-payment-status"></div>\n' +
    '      <div id="portal-payment-frame"></div>\n' +
    '    </div>\n' +
    '    <div id="portal-estimate-section" class="portal-files-selector portal-hidden">\n' +
    '      <div class="portal-files-selector-header"><span class="portal-files-selector-header-title" id="portal-estimate-title">Estimate</span><span id="portal-estimate-status-badge" class="portal-estimate-status-badge"></span></div>\n' +
    '      <div id="portal-estimate-body" class="portal-estimate-body"></div>\n' +
    '      <div id="portal-estimate-actions" class="portal-estimate-actions">\n' +
    '        <button type="button" id="portal-estimate-accept">Accept</button>\n' +
    '        <button type="button" id="portal-estimate-decline" class="portal-estimate-decline">Decline</button>\n' +
    '      </div>\n' +
    '      <div id="portal-estimate-status"></div>\n' +
    '    </div>\n' +
    '    <div id="portal-invoice-section" class="portal-files-selector portal-hidden">\n' +
    '      <div class="portal-files-selector-header"><span class="portal-files-selector-header-title" id="portal-invoice-title">Invoice</span><span id="portal-invoice-status-badge" class="portal-estimate-status-badge"></span></div>\n' +
    '      <div id="portal-invoice-body" class="portal-estimate-body"></div>\n' +
    '    </div>\n' +
    '    <div id="portal-upload-section">\n' +
    '      <h2>Add Photos</h2>\n' +
    '      <input type="file" id="portal-photo-input" accept="image/*" multiple />\n' +
    '      <div id="portal-upload-status"></div>\n' +
    '    </div>\n' +
    '  </div>\n' +
    '</div>\n' +
    '<div id="portal-signature-modal" class="portal-hidden">\n' +
    '  <div class="portal-signature-modal-backdrop"></div>\n' +
    '  <div class="portal-signature-modal-panel">\n' +
    '    <div class="portal-signature-tabs">\n' +
    '      <button type="button" id="portal-sig-draw-tab" class="active">Draw</button>\n' +
    '      <button type="button" id="portal-sig-type-tab">Type</button>\n' +
    '    </div>\n' +
    '    <canvas id="portal-sig-canvas" class="portal-signature-canvas"></canvas>\n' +
    '    <input type="text" id="portal-sig-typed-input" class="portal-signature-typed-input portal-hidden" placeholder="Type your full name" />\n' +
    '    <div class="portal-signature-modal-actions">\n' +
    '      <button type="button" id="portal-sig-clear">Clear</button>\n' +
    '      <button type="button" id="portal-sig-cancel">Cancel</button>\n' +
    '      <button type="button" id="portal-sig-use">Use This Signature</button>\n' +
    '    </div>\n' +
    '  </div>\n' +
    '</div>\n' +
    '<script type="module">\n' +
    'const INVITE_TOKEN = ' + JSON.stringify(escapedToken) + ';\n' +
    embedShellJs +
    '</script>\n' +
    '</body>\n' +
    '</html>\n'
}

// FilesSelector-matching visual language (src/components/FilesSelector.css) reimplemented here with
// portal- prefixed class names -- this page cannot import that CSS file directly (a separate,
// standalone Worker deploy with no build step), so the values below are deliberately copied to match
// it, not merely inspired by it.
const embedShellCss = `
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin: 0; padding: 16px; color: #1a1a1a; background: #f5f5f5; }
  #portal-root { max-width: 900px; margin: 0 auto; }
  #portal-loading, #portal-error { padding: 24px; text-align: center; color: #666; }
  #portal-error { color: #b02a37; }
  .portal-hidden { display: none !important; }
  h1 { font-size: 1.4em; margin: 0 0 4px 0; }
  #portal-job-summary { color: #555; margin: 0 0 16px 0; }

  .portal-files-selector { background: #ffffff; border: 1px solid #dddddd; margin-bottom: 16px; }
  .portal-files-selector-header { display: flex; align-items: center; gap: 8px; height: 38px; padding: 0 12px; box-sizing: border-box; border-bottom: 1px solid #000000; background: #f3f3f3; font-weight: bold; }
  .portal-files-selector-back { border: 1px solid #999999; background: #ffffff; width: 24px; height: 24px; line-height: 1; cursor: pointer; flex: 0 0 auto; }
  .portal-files-selector-list { max-height: 260px; overflow-y: auto; }
  .portal-files-selector-row { display: flex; justify-content: space-between; align-items: center; height: 36px; padding: 0 12px; border-bottom: 1px solid #dddddd; cursor: pointer; }
  .portal-files-selector-row:hover { background: #f0f4f8; }
  .portal-files-selector-row-title { font-weight: bold; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .portal-files-selector-empty { padding: 16px; color: #777777; font-style: italic; text-align: center; }
  .portal-files-selector-open { padding: 12px; }

  .portal-document-title { font-weight: 600; margin-bottom: 8px; }
  .portal-document-actions { display: flex; gap: 8px; margin-bottom: 8px; }
  .portal-document-action-button { display: inline-block; padding: 6px 12px; border: 1px solid #999; border-radius: 6px; background: #fff; color: #1a1a1a; text-decoration: none; font-size: 0.9em; cursor: pointer; }
  .portal-document-action-button:hover { background: #f0f4f8; }
  .portal-document-page-wrap { position: relative; display: inline-block; margin-bottom: 8px; box-shadow: 0 1px 4px rgba(0,0,0,0.2); }
  .portal-document-page-canvas { display: block; }
  /* Client_Portal_and_Contracts_Corrections_Task_Spec_20260823.md: fields present as clean, single
     boxes -- the actual capture interaction (Draw/Type/canvas/Use) happens in
     #portal-signature-modal, entirely outside this document's own layout, not inline over it. */
  .portal-field-overlay { position: absolute; box-sizing: border-box; z-index: 1; }
  .portal-field-input { border: 1px solid #999; background: #fffdeb; font-size: 12px; padding: 0 4px; }
  .portal-field-checkbox { accent-color: #2a6ebb; }
  .portal-field-signature { border: 1px dashed #999; background: #fffdeb; display: flex; align-items: center; justify-content: center; font-size: 11px; color: #777; cursor: pointer; overflow: hidden; padding: 2px; }
  .portal-field-signature img { max-width: 100%; max-height: 100%; object-fit: contain; }
  /* Correction (2026-08-24): a staged (already-captured) signature must extend to match the field's
     own dimensions exactly, not float small and centered inside it -- the base rule's padding/
     object-fit:contain above is still correct for the pre-capture placeholder, but once staged the
     image is stretched to fill the box edge to edge instead. */
  .portal-field-signature.staged { border-style: solid; border-color: #6ba86b; background: #f2fff2; cursor: default; padding: 0; }
  .portal-field-signature.staged img { width: 100%; height: 100%; max-width: 100%; max-height: 100%; object-fit: fill; }
  .portal-document-submit { margin-top: 8px; padding: 8px 16px; border: 1px solid #999; border-radius: 6px; background: #fff; color: #1a1a1a; font-size: 0.95em; cursor: pointer; }
  .portal-document-submit:hover { background: #f0f4f8; }
  .portal-document-submit:disabled { color: #999; cursor: not-allowed; }
  .portal-document-status { margin-top: 6px; font-size: 0.9em; }
  .portal-document-status.success { color: #1e7e34; }
  .portal-document-status.error { color: #b02a37; }

  .portal-photo-open-image { max-width: 100%; display: block; margin: 0 auto 8px; }
  .portal-photo-open-caption { color: #555; font-size: 0.9em; text-align: center; }

  .portal-notes-section { background: #ffffff; border: 1px solid #dddddd; margin-bottom: 16px; }
  .portal-notes-body { padding: 12px; overflow-wrap: break-word; }
  .portal-notes-body img { max-width: 100%; height: auto; display: block; }
  .portal-notes-body table { border-collapse: collapse; max-width: 100%; }
  .portal-notes-body td, .portal-notes-body th { border: 1px solid #cccccc; padding: 4px 8px; }

  #portal-upload-section { background: #fff; border: 1px solid #ddd; padding: 12px; }
  #portal-upload-status { margin-top: 8px; font-size: 0.9em; }

  /* BS-2: published Estimate view -- read-only body + Accept / Decline. */
  .portal-estimate-status-badge { margin-left: auto; font-size: 0.75em; font-weight: 600; text-transform: uppercase; color: #555; }
  .portal-estimate-body { padding: 12px; overflow-x: auto; }
  .portal-estimate-body .est-doc-head { display: flex; justify-content: space-between; gap: 12px; margin-bottom: 6px; }
  .portal-estimate-body .est-doc-meta { color: #555; font-size: 0.9em; margin-bottom: 10px; }
  .portal-estimate-body table.est-doc-lines { width: 100%; border-collapse: collapse; margin-bottom: 10px; }
  .portal-estimate-body .est-doc-lines th { text-align: left; background: #3b3f45; color: #fff; padding: 6px 8px; font-size: 0.85em; }
  .portal-estimate-body .est-doc-lines th.num, .portal-estimate-body .est-doc-lines td.num { text-align: right; }
  .portal-estimate-body .est-doc-lines td { padding: 6px 8px; border-bottom: 1px solid #e4e7eb; }
  .portal-estimate-body .est-doc-totals { margin-left: auto; width: 260px; }
  .portal-estimate-body .est-total-row { display: flex; justify-content: space-between; padding: 2px 0; }
  .portal-estimate-body .est-total-grand { border-top: 1px solid #cdd2d8; margin-top: 4px; padding-top: 6px; font-weight: 700; }
  .portal-estimate-body .est-doc-notes { margin-top: 14px; }
  .portal-estimate-body .est-doc-footer { margin-top: 14px; color: #888; font-size: 0.8em; }
  .portal-estimate-actions { display: flex; gap: 8px; padding: 0 12px 12px; }
  .portal-estimate-actions button { padding: 8px 18px; border: 1px solid #999; border-radius: 6px; background: #fff; cursor: pointer; font-size: 0.95em; }
  .portal-estimate-actions button:disabled { color: #999; cursor: not-allowed; }
  .portal-estimate-actions #portal-estimate-accept { background: #f2fff2; border-color: #6ba86b; }
  .portal-estimate-actions .portal-estimate-decline { background: #fff4f4; border-color: #c98d8d; }
  #portal-estimate-status { padding: 0 12px 12px; font-size: 0.9em; }
  #portal-estimate-status.success { color: #1e7e34; }
  #portal-estimate-status.error { color: #b02a37; }

  #portal-signature-modal { position: fixed; inset: 0; z-index: 1000; display: flex; align-items: center; justify-content: center; padding: 16px; }
  .portal-signature-modal-backdrop { position: absolute; inset: 0; background: rgba(0,0,0,0.45); }
  .portal-signature-modal-panel { position: relative; z-index: 1; background: #ffffff; width: 420px; max-width: 100%; padding: 16px; box-shadow: 0 2px 12px rgba(0,0,0,0.35); }
  .portal-signature-tabs { display: flex; gap: 6px; margin-bottom: 10px; }
  .portal-signature-tabs button { font-size: 12px; padding: 4px 10px; background: #fff; border: 1px solid #999; cursor: pointer; }
  .portal-signature-tabs button.active { font-weight: 700; text-decoration: underline; }
  .portal-signature-canvas { width: 100%; height: 160px; border: 1px solid #ccc; background: #fff; touch-action: none; display: block; }
  .portal-signature-typed-input { width: 100%; font-size: 20px; font-family: 'Brush Script MT', cursive; padding: 8px; margin-top: 8px; box-sizing: border-box; }
  .portal-signature-modal-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 10px; }
  .portal-signature-modal-actions button { padding: 6px 12px; cursor: pointer; }
`

// Vanilla JS, ES module scope (loaded via <script type="module">). Deliberately avoids any build
// tooling/bundler dependency -- this string is served byte-for-byte by the Worker.
const embedShellJs = `
function apiUrl(path) {
  return window.location.origin + path;
}

function showError(message) {
  document.getElementById('portal-loading').classList.add('portal-hidden');
  const errorEl = document.getElementById('portal-error');
  errorEl.textContent = message;
  errorEl.classList.remove('portal-hidden');
}

async function loadSnapshot() {
  try {
    const response = await fetch(apiUrl('/portal/' + INVITE_TOKEN));
    const data = await response.json();
    if (!data.ok) {
      showError(data.message || 'This link is no longer valid.');
      return;
    }
    render(data.snapshot);
  } catch (err) {
    showError('Unable to load this Client Portal right now. Please try again later.');
  }
}

function render(snapshot) {
  document.getElementById('portal-loading').classList.add('portal-hidden');
  document.getElementById('portal-title').textContent = snapshot.title || 'Client Portal';
  const jobSummaryEl = document.getElementById('portal-job-summary');
  if (snapshot.jobSummary) {
    jobSummaryEl.textContent = snapshot.jobSummary;
  } else {
    jobSummaryEl.classList.add('portal-hidden');
  }

  renderContractsSection(snapshot.documents || []);
  renderPhotosSection(snapshot.photos || []);
  renderNotesSection(snapshot.notesHtml || null);
  renderPaymentSection(snapshot.payment || null);
  renderEstimateSection(snapshot.estimate || null);
  renderInvoiceSection(snapshot.invoice || null);

  document.getElementById('portal-content').classList.remove('portal-hidden');
  wireUploadSection();
}

// BS-2 (Part C-2 / C-5): a published Estimate -> read-only body + Accept / Decline. Opening the
// section fires a 'viewed' beacon; the buttons fire 'accepted' / 'declined'. Each POST goes to
// /portal/{token}/estimate-event and becomes an estimate_event packet the Business polls.
function postEstimateEvent(estimateRef, event) {
  return fetch(apiUrl('/portal/' + INVITE_TOKEN + '/estimate-event'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ estimateRef: estimateRef, event: event }),
  });
}

function renderEstimateSection(estimate) {
  const section = document.getElementById('portal-estimate-section');
  if (!estimate || !estimate.estimateRef) { section.classList.add('portal-hidden'); return; }
  section.classList.remove('portal-hidden');

  document.getElementById('portal-estimate-title').textContent = (estimate.documentTerm || 'Estimate') + ' ' + (estimate.numberLabel || '');
  document.getElementById('portal-estimate-status-badge').textContent = estimate.status || '';
  document.getElementById('portal-estimate-body').innerHTML = estimate.bodyHtml || '';

  const actionsEl = document.getElementById('portal-estimate-actions');
  const statusEl = document.getElementById('portal-estimate-status');
  const acceptButton = document.getElementById('portal-estimate-accept');
  const declineButton = document.getElementById('portal-estimate-decline');
  acceptButton.textContent = 'Accept ' + (estimate.documentTerm || 'Estimate');

  const terminal = ['accepted', 'rejected', 'converted', 'expired'];
  if (terminal.indexOf(estimate.status) !== -1) {
    actionsEl.classList.add('portal-hidden');
    if (estimate.status === 'accepted' || estimate.status === 'converted') {
      statusEl.textContent = 'You accepted this ' + (estimate.documentTerm || 'estimate') + '.';
      statusEl.className = 'success';
    } else if (estimate.status === 'rejected') {
      statusEl.textContent = 'You declined this ' + (estimate.documentTerm || 'estimate') + '.';
    } else if (estimate.status === 'expired') {
      statusEl.textContent = 'This ' + (estimate.documentTerm || 'estimate') + ' has expired.';
    }
  }

  // Fire-and-forget 'viewed' beacon on open.
  void postEstimateEvent(estimate.estimateRef, 'viewed').catch(function () {});

  function decide(event) {
    acceptButton.disabled = true;
    declineButton.disabled = true;
    statusEl.textContent = 'Submitting...';
    statusEl.className = '';
    postEstimateEvent(estimate.estimateRef, event).then(function (response) {
      return response.json();
    }).then(function (data) {
      if (!data.ok) {
        statusEl.textContent = data.message || 'Unable to record your response.';
        statusEl.className = 'error';
        acceptButton.disabled = false;
        declineButton.disabled = false;
        return;
      }
      actionsEl.classList.add('portal-hidden');
      statusEl.textContent = event === 'accepted'
        ? 'Thank you -- your acceptance has been sent.'
        : 'Your response has been sent.';
      statusEl.className = 'success';
    }).catch(function () {
      statusEl.textContent = 'Unable to record your response right now. Please try again.';
      statusEl.className = 'error';
      acceptButton.disabled = false;
      declineButton.disabled = false;
    });
  }

  acceptButton.onclick = function () { decide('accepted'); };
  declineButton.onclick = function () { decide('declined'); };
}

// BS-3 (Part D / D-4): a published Invoice deep-link -> read-only body. Opening the section fires a
// 'viewed' beacon (POST /portal/{token}/invoice-event) that becomes an invoice_event packet the
// Business polls into an invoice status change + notification.
function renderInvoiceSection(invoice) {
  const section = document.getElementById('portal-invoice-section');
  if (!invoice || !invoice.invoiceRef) { section.classList.add('portal-hidden'); return; }
  section.classList.remove('portal-hidden');

  document.getElementById('portal-invoice-title').textContent = 'Invoice ' + (invoice.numberLabel || '');
  document.getElementById('portal-invoice-status-badge').textContent = invoice.status || '';
  document.getElementById('portal-invoice-body').innerHTML = invoice.bodyHtml || '';

  void fetch(apiUrl('/portal/' + INVITE_TOKEN + '/invoice-event'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ invoiceRef: invoice.invoiceRef, event: 'viewed' }),
  }).catch(function () {});
}

// A published "Payment Gateway" item -> the Client pays the invoice here. Payments are an independent
// service: "Pay Now" opens the Payments Worker's hosted payment link (payment.payUrl) in an iframe (the
// Stripe card fields run on that HTTPS origin only). A postMessage from that frame -- accepted only from
// the payment link's own origin -- updates the status line. Client Portal takes no payments itself.
function renderPaymentSection(payment) {
  const section = document.getElementById('portal-payment-section');
  if (!payment || !payment.invoiceRef || !payment.payUrl) { section.classList.add('portal-hidden'); return; }
  section.classList.remove('portal-hidden');

  let amountText;
  try {
    amountText = new Intl.NumberFormat('en-US', { style: 'currency', currency: (payment.currency || 'usd').toUpperCase() }).format(payment.amountCents / 100);
  } catch (e) { amountText = (payment.amountCents / 100).toFixed(2) + ' ' + (payment.currency || 'usd').toUpperCase(); }

  document.getElementById('portal-payment-title').textContent = payment.title || 'Payment';
  document.getElementById('portal-payment-summary').textContent = 'Amount due: ' + amountText;

  const statusEl = document.getElementById('portal-payment-status');
  const frameEl = document.getElementById('portal-payment-frame');
  const payButton = document.getElementById('portal-payment-pay');

  let payOrigin = '';
  try { payOrigin = new URL(payment.payUrl).origin; } catch (e) { section.classList.add('portal-hidden'); return; }

  window.addEventListener('message', function (event) {
    if (event.origin !== payOrigin) return;
    if (!event.data || event.data.type !== 'solesystems-payment') return;
    if (event.data.status === 'succeeded') {
      statusEl.textContent = 'Payment received. Thank you!';
      frameEl.innerHTML = '';
      payButton.classList.add('portal-hidden');
    } else if (event.data.status === 'failed') {
      statusEl.textContent = 'That payment did not go through. You can try again.';
    } else if (event.data.status === 'processing') {
      statusEl.textContent = 'Payment is processing.';
    }
  });

  payButton.onclick = function () {
    payButton.disabled = true;
    statusEl.textContent = '';
    const iframe = document.createElement('iframe');
    iframe.src = payment.payUrl;
    iframe.style.width = '100%';
    iframe.style.height = '520px';
    iframe.style.border = '0';
    frameEl.innerHTML = '';
    frameEl.appendChild(iframe);
  };
}

function renderFilesSelectorList(listEl, items, emptyMessage, buildRowTitle, onOpen) {
  listEl.innerHTML = '';
  if (items.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'portal-files-selector-empty';
    empty.textContent = emptyMessage;
    listEl.appendChild(empty);
    return;
  }
  items.forEach(function (item) {
    const row = document.createElement('div');
    row.className = 'portal-files-selector-row';
    const titleEl = document.createElement('span');
    titleEl.className = 'portal-files-selector-row-title';
    titleEl.textContent = buildRowTitle(item);
    row.appendChild(titleEl);
    row.addEventListener('click', function () { onOpen(item); });
    listEl.appendChild(row);
  });
}

function openFilesSelectorFile(sectionPrefix, buildOpenContent) {
  document.getElementById('portal-' + sectionPrefix + '-list').classList.add('portal-hidden');
  document.getElementById('portal-' + sectionPrefix + '-back').classList.remove('portal-hidden');
  const openEl = document.getElementById('portal-' + sectionPrefix + '-open');
  openEl.innerHTML = '';
  openEl.className = 'portal-files-selector-open';
  buildOpenContent(openEl);
}

function closeFilesSelectorFile(sectionPrefix) {
  document.getElementById('portal-' + sectionPrefix + '-list').classList.remove('portal-hidden');
  document.getElementById('portal-' + sectionPrefix + '-back').classList.add('portal-hidden');
  const openEl = document.getElementById('portal-' + sectionPrefix + '-open');
  openEl.className = 'portal-hidden';
  openEl.innerHTML = '';
}

function renderContractsSection(documents) {
  const section = document.getElementById('portal-contracts-section');
  if (documents.length === 0) { section.classList.add('portal-hidden'); return; }
  section.classList.remove('portal-hidden');

  const listEl = document.getElementById('portal-contracts-list');
  renderFilesSelectorList(listEl, documents, 'No current Contracts on this Record.', function (doc) {
    return doc.title + ' (v' + doc.versionNumber + ')';
  }, function (doc) {
    openFilesSelectorFile('contracts', function (openEl) { void buildDocumentOpenContent(doc, openEl); });
  });

  document.getElementById('portal-contracts-back').onclick = function () { closeFilesSelectorFile('contracts'); };
}

function renderPhotosSection(photos) {
  const section = document.getElementById('portal-photos-section');
  if (photos.length === 0) { section.classList.add('portal-hidden'); return; }
  section.classList.remove('portal-hidden');

  const listEl = document.getElementById('portal-photos-list');
  renderFilesSelectorList(listEl, photos, "No photos found in this Record's Notes.", function (photo) {
    return photo.originalFileName;
  }, function (photo) {
    openFilesSelectorFile('photos', function (openEl) { buildPhotoOpenContent(photo, openEl); });
  });

  document.getElementById('portal-photos-back').onclick = function () { closeFilesSelectorFile('photos'); };
}

// Correction (2026-08-24): notesHtml is the Business's own locked Notes canvas (paragraphs,
// headings, tables, images -- whichever blocks they left checked), rendered once at Publish time
// (ClientPortalRuntimeService.publishRecord) and shipped as plain markup. Every embedded image was
// already rewritten server-side from a data: URL to a bare data-object-id placeholder (D1's 2MB
// row cap won't hold real photo bytes) -- this fills in the actual src the same way
// buildPhotoOpenContent above always has, from the object id, not from anything baked into the HTML.
function renderNotesSection(notesHtml) {
  const section = document.getElementById('portal-notes-section');
  if (!notesHtml) { section.classList.add('portal-hidden'); return; }
  section.classList.remove('portal-hidden');

  const bodyEl = document.getElementById('portal-notes-body');
  bodyEl.innerHTML = notesHtml;
  bodyEl.querySelectorAll('[data-object-id]').forEach(function (el) {
    el.src = apiUrl('/portal/' + INVITE_TOKEN + '/objects/' + el.getAttribute('data-object-id'));
  });
}

function buildPhotoOpenContent(photo, openEl) {
  const img = document.createElement('img');
  img.className = 'portal-photo-open-image';
  img.src = apiUrl('/portal/' + INVITE_TOKEN + '/objects/' + photo.objectId);
  img.alt = photo.caption || photo.originalFileName || '';
  openEl.appendChild(img);
  if (photo.caption) {
    const caption = document.createElement('div');
    caption.className = 'portal-photo-open-caption';
    caption.textContent = photo.caption;
    openEl.appendChild(caption);
  }
}

const RENDER_SCALE = 1.5;

async function buildDocumentOpenContent(doc, openEl) {
  const title = document.createElement('div');
  title.className = 'portal-document-title';
  title.textContent = doc.title || 'Document';
  openEl.appendChild(title);

  // Correction (2026-08-24): available both before and after signing -- before, for printing a
  // physical copy to sign by hand; after, for the Client's own records. Both link directly to the
  // same raw object URL the canvas render below fetches from, opened in a new tab so the browser's
  // own native PDF viewer (with its own working Print/Save, the same one the desktop app's own
  // Contracts/Client Portal PDF preview already relies on) handles it -- this custom canvas-per-page
  // render exists only to support the interactive signing overlay, not to reimplement print/download.
  const objectUrl = apiUrl('/portal/' + INVITE_TOKEN + '/objects/' + doc.sourceObjectId);
  const actionsRow = document.createElement('div');
  actionsRow.className = 'portal-document-actions';
  const downloadLink = document.createElement('a');
  downloadLink.className = 'portal-document-action-button';
  downloadLink.href = objectUrl;
  downloadLink.download = (doc.title || 'document') + '.pdf';
  downloadLink.textContent = 'Download';
  const printLink = document.createElement('a');
  printLink.className = 'portal-document-action-button';
  printLink.href = objectUrl;
  printLink.target = '_blank';
  printLink.rel = 'noopener';
  printLink.textContent = 'Print';
  actionsRow.appendChild(downloadLink);
  actionsRow.appendChild(printLink);
  openEl.appendChild(actionsRow);

  const fieldState = {};
  const markState = {};

  const submitButton = document.createElement('button');
  submitButton.type = 'button';
  submitButton.className = 'portal-document-submit';
  submitButton.textContent = 'Submit';

  const statusEl = document.createElement('div');
  statusEl.className = 'portal-document-status';

  await renderDocumentPdf(doc, openEl, fieldState, markState, statusEl);

  submitButton.addEventListener('click', function () {
    void submitDocument(doc, fieldState, markState, statusEl, submitButton);
  });

  openEl.appendChild(submitButton);
  openEl.appendChild(statusEl);
}

async function renderDocumentPdf(doc, section, fieldState, markState, statusEl) {
  try {
    const pdfjsLib = window.pdfjsLib;
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.6.82/pdf.worker.min.mjs';

    const objectUrl = apiUrl('/portal/' + INVITE_TOKEN + '/objects/' + doc.sourceObjectId);
    const loadingTask = pdfjsLib.getDocument({ url: objectUrl });
    const pdfDocument = await loadingTask.promise;

    const fieldsByPage = {};
    (doc.fields || []).forEach(function (field) {
      const list = fieldsByPage[field.pageNumber] || [];
      list.push(field);
      fieldsByPage[field.pageNumber] = list;
    });

    for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
      const page = await pdfDocument.getPage(pageNumber);
      const viewport = page.getViewport({ scale: RENDER_SCALE });

      const pageWrap = document.createElement('div');
      pageWrap.className = 'portal-document-page-wrap';

      const canvas = document.createElement('canvas');
      canvas.className = 'portal-document-page-canvas';
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      pageWrap.appendChild(canvas);

      const context = canvas.getContext('2d');
      await page.render({ canvasContext: context, viewport: viewport }).promise;

      (fieldsByPage[pageNumber] || []).forEach(function (field) {
        pageWrap.appendChild(buildFieldOverlay(field, viewport.height, fieldState, markState, statusEl));
      });

      section.appendChild(pageWrap);
    }
  } catch (err) {
    statusEl.textContent = 'Unable to render this document.';
    statusEl.className = 'portal-document-status error';
  }
}

function buildFieldOverlay(field, canvasHeight, fieldState, markState, statusEl) {
  const left = field.xPosition * RENDER_SCALE;
  const top = canvasHeight - (field.yPosition + field.height) * RENDER_SCALE;
  const width = field.width * RENDER_SCALE;
  const height = field.height * RENDER_SCALE;

  if (field.fieldType === 'signature' || field.fieldType === 'initials') {
    const box = document.createElement('div');
    box.className = 'portal-field-overlay portal-field-signature';
    box.style.left = left + 'px';
    box.style.top = top + 'px';
    box.style.width = width + 'px';
    box.style.height = height + 'px';
    box.textContent = field.fieldType === 'initials' ? 'Initials' : 'Signature';
    box.addEventListener('click', function () {
      if (box.classList.contains('staged')) return;
      openSignatureModal(function (result) {
        markState[field.id] = { fieldId: field.id, captureMode: result.captureMode, signatureImageDataUrl: result.signatureImageDataUrl, typedName: result.typedName };
        box.classList.add('staged');
        box.textContent = '';
        if (result.captureMode === 'drawn' && result.signatureImageDataUrl) {
          const img = document.createElement('img');
          img.src = result.signatureImageDataUrl;
          box.appendChild(img);
        } else {
          box.textContent = result.typedName || '';
        }
      });
    });
    return box;
  }

  if (field.fieldType === 'checkbox') {
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.className = 'portal-field-overlay portal-field-checkbox';
    input.style.left = left + 'px';
    input.style.top = top + 'px';
    input.style.width = width + 'px';
    input.style.height = height + 'px';
    input.addEventListener('change', function () {
      fieldState[field.id] = input.checked;
    });
    return input;
  }

  const input = document.createElement('input');
  input.type = field.fieldType === 'date' ? 'date' : 'text';
  input.className = 'portal-field-overlay portal-field-input';
  input.style.left = left + 'px';
  input.style.top = top + 'px';
  input.style.width = width + 'px';
  input.style.height = height + 'px';
  input.addEventListener('input', function () {
    fieldState[field.id] = input.value;
  });
  return input;
}

// Client_Portal_and_Contracts_Corrections_Task_Spec_20260823.md: one shared modal (outside the
// document's own layout entirely, #portal-signature-modal in the page shell) for the actual Draw/
// Type/canvas/Use capture interaction -- a field itself is only ever a single clean clickable box
// (buildFieldOverlay above), never an inline-expanding cluster of controls over the document.
let activeSignaturePad = null;

function openSignatureModal(onCapture) {
  const modal = document.getElementById('portal-signature-modal');
  const drawTab = document.getElementById('portal-sig-draw-tab');
  const typeTab = document.getElementById('portal-sig-type-tab');
  const canvas = document.getElementById('portal-sig-canvas');
  const typedInput = document.getElementById('portal-sig-typed-input');
  const clearButton = document.getElementById('portal-sig-clear');
  const cancelButton = document.getElementById('portal-sig-cancel');
  const useButton = document.getElementById('portal-sig-use');

  let mode = 'drawn';
  typedInput.value = '';
  drawTab.className = 'active';
  typeTab.className = '';
  canvas.classList.remove('portal-hidden');
  typedInput.classList.add('portal-hidden');

  function setupPad() {
    const ratio = Math.max(window.devicePixelRatio || 1, 1);
    canvas.width = canvas.offsetWidth * ratio;
    canvas.height = canvas.offsetHeight * ratio;
    canvas.getContext('2d').scale(ratio, ratio);
    activeSignaturePad = new window.SignaturePad(canvas, { backgroundColor: 'rgba(255,255,255,1)' });
  }

  modal.classList.remove('portal-hidden');
  setTimeout(setupPad, 0);

  drawTab.onclick = function () {
    mode = 'drawn';
    drawTab.className = 'active';
    typeTab.className = '';
    canvas.classList.remove('portal-hidden');
    typedInput.classList.add('portal-hidden');
  };
  typeTab.onclick = function () {
    mode = 'typed_name';
    typeTab.className = 'active';
    drawTab.className = '';
    canvas.classList.add('portal-hidden');
    typedInput.classList.remove('portal-hidden');
  };
  clearButton.onclick = function () {
    if (activeSignaturePad) activeSignaturePad.clear();
    typedInput.value = '';
  };
  function closeModal() {
    modal.classList.add('portal-hidden');
    activeSignaturePad = null;
  }
  cancelButton.onclick = closeModal;
  useButton.onclick = function () {
    if (mode === 'drawn') {
      if (!activeSignaturePad || activeSignaturePad.isEmpty()) return;
      const dataUrl = activeSignaturePad.toDataURL('image/png');
      closeModal();
      onCapture({ captureMode: 'drawn', signatureImageDataUrl: dataUrl, typedName: null });
    } else {
      const name = typedInput.value.trim();
      if (!name) return;
      closeModal();
      onCapture({ captureMode: 'typed_name', signatureImageDataUrl: null, typedName: name });
    }
  };
}

async function submitDocument(doc, fieldState, markState, statusEl, submitButton) {
  submitButton.disabled = true;
  statusEl.textContent = 'Submitting...';
  statusEl.className = 'portal-document-status';

  try {
    const response = await fetch(apiUrl('/portal/' + INVITE_TOKEN + '/submit'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        packetType: 'document_signing_response',
        payload: {
          documentId: doc.documentId,
          fieldValues: fieldState,
          marks: Object.keys(markState).map(function (key) { return markState[key]; }),
        },
      }),
    });
    const data = await response.json();
    if (!data.ok) {
      statusEl.textContent = data.message || 'Unable to submit.';
      statusEl.className = 'portal-document-status error';
      submitButton.disabled = false;
      return;
    }
    statusEl.textContent = data.message || 'Submitted -- pending Business review.';
    statusEl.className = 'portal-document-status success';
  } catch (err) {
    statusEl.textContent = 'Unable to submit right now. Please try again.';
    statusEl.className = 'portal-document-status error';
    submitButton.disabled = false;
  }
}

function wireUploadSection() {
  const input = document.getElementById('portal-photo-input');
  const statusEl = document.getElementById('portal-upload-status');

  input.addEventListener('change', function () {
    const files = Array.from(input.files || []);
    files.forEach(function (file) { void uploadPhoto(file, statusEl); });
  });
}

async function uploadPhoto(file, statusEl) {
  statusEl.textContent = 'Uploading ' + file.name + '...';
  try {
    const response = await fetch(apiUrl('/portal/' + INVITE_TOKEN + '/upload'), {
      method: 'POST',
      headers: { 'X-SoleSystems-Content-Type': file.type || 'application/octet-stream' },
      body: file,
    });
    const data = await response.json();
    if (!data.ok) {
      statusEl.textContent = data.message || ('Unable to upload ' + file.name + '.');
      return;
    }
    statusEl.textContent = file.name + ': submitted -- pending Business review.';
  } catch (err) {
    statusEl.textContent = 'Unable to upload ' + file.name + ' right now.';
  }
}

loadSnapshot();
`
