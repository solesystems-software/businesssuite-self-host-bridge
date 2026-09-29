// Notifications_..._7Phase_Plan Part D / D-4 (Orchestration BS-3): worker-side coverage for the
// Client-facing invoice-event beacon (POST /portal/{inviteToken}/invoice-event). Mirrors
// test/estimate-events.test.ts.
//
//   1. Pure validation contract (parseInvoiceEventBody / invoiceRefMatchesSnapshot) -- always runs,
//      no credentials, no network. clientPortalRoutes.ts's handleSubmitInvoiceEvent is thin glue
//      over these plus the same grant-lookup / D1-insert pattern the covered estimate route uses.
//   2. Live route integration (gated on SOLESYSTEMS_CLIENT_PORTAL_* creds AND the route being
//      deployed) -- skips cleanly until the invoice-event route reaches the dev Worker.
//
// Run with: node --experimental-strip-types --test test/invoice-events.test.ts

import test from 'node:test'
import assert from 'node:assert/strict'
import { parseInvoiceEventBody, invoiceRefMatchesSnapshot, INVOICE_EVENTS } from '../src/invoiceEventValidation.ts'

test('parseInvoiceEventBody accepts a viewed event with a non-empty invoiceRef', () => {
  for (const event of INVOICE_EVENTS) {
    const result = parseInvoiceEventBody({ invoiceRef: 'inv-123', event })
    assert.equal(result.ok, true)
    if (result.ok) {
      assert.equal(result.invoiceRef, 'inv-123')
      assert.equal(result.event, event)
    }
  }
})

test('parseInvoiceEventBody trims whitespace around invoiceRef and event', () => {
  const result = parseInvoiceEventBody({ invoiceRef: '  inv-9  ', event: ' viewed ' })
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.invoiceRef, 'inv-9')
    assert.equal(result.event, 'viewed')
  }
})

test('parseInvoiceEventBody rejects an unknown event', () => {
  assert.equal(parseInvoiceEventBody({ invoiceRef: 'inv-1', event: 'accepted' }).ok, false)
  assert.equal(parseInvoiceEventBody({ invoiceRef: 'inv-1', event: 'paid' }).ok, false)
})

test('parseInvoiceEventBody rejects a missing / empty invoiceRef', () => {
  assert.equal(parseInvoiceEventBody({ event: 'viewed' }).ok, false)
  assert.equal(parseInvoiceEventBody({ invoiceRef: '   ', event: 'viewed' }).ok, false)
})

test('parseInvoiceEventBody rejects non-object bodies', () => {
  assert.equal(parseInvoiceEventBody(null).ok, false)
  assert.equal(parseInvoiceEventBody('viewed').ok, false)
  assert.equal(parseInvoiceEventBody(['viewed']).ok, false)
})

test('invoiceRefMatchesSnapshot matches only the published invoice ref', () => {
  const snapshot = JSON.stringify({ title: 'Job', invoice: { invoiceRef: 'inv-777', bodyHtml: '<div></div>' } })
  assert.equal(invoiceRefMatchesSnapshot(snapshot, 'inv-777'), true)
  assert.equal(invoiceRefMatchesSnapshot(snapshot, 'inv-778'), false)
})

test('invoiceRefMatchesSnapshot rejects a snapshot with no published invoice', () => {
  assert.equal(invoiceRefMatchesSnapshot(JSON.stringify({ title: 'Job', invoice: null }), 'inv-1'), false)
  assert.equal(invoiceRefMatchesSnapshot(JSON.stringify({ title: 'Job' }), 'inv-1'), false)
})

test('invoiceRefMatchesSnapshot tolerates a corrupt payload', () => {
  assert.equal(invoiceRefMatchesSnapshot('{not json', 'inv-1'), false)
})

// --- Layer 2: live route integration (skips until deployed + credentialed) ---

const relayUrl = (process.env.SOLESYSTEMS_CLIENT_PORTAL_RELAY_URL || '').replace(/\/+$/, '')
const liveInviteToken = process.env.SOLESYSTEMS_CLIENT_PORTAL_TEST_INVITE_TOKEN || ''
const liveInvoiceRef = process.env.SOLESYSTEMS_CLIENT_PORTAL_TEST_INVOICE_REF || ''
const hasLive = Boolean(relayUrl && liveInviteToken && liveInvoiceRef)

test('live: POST /portal/{token}/invoice-event records a viewed event', { skip: !hasLive }, async () => {
  const response = await fetch(`${relayUrl}/portal/${liveInviteToken}/invoice-event`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ invoiceRef: liveInvoiceRef, event: 'viewed' }),
  })
  const json = await response.json() as { ok?: boolean }
  assert.equal(response.status, 200)
  assert.equal(json.ok, true)
})

test('live: a mismatched invoiceRef is rejected', { skip: !hasLive }, async () => {
  const response = await fetch(`${relayUrl}/portal/${liveInviteToken}/invoice-event`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ invoiceRef: 'not-the-published-ref', event: 'viewed' }),
  })
  assert.equal(response.status, 400)
})
