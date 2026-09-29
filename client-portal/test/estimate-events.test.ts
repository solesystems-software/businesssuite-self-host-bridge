// Notifications_..._7Phase_Plan Part C-2 / C-5 (Orchestration BS-2): worker-side coverage for the
// Client-facing estimate-event beacon (POST /portal/{inviteToken}/estimate-event).
//
// Two layers, matching this project's "real, not stubbed" discipline while honouring the batch
// constraint "Do NOT wrangler deploy / isolated local worker tests only":
//   1. Pure validation contract (parseEstimateEventBody / estimateRefMatchesSnapshot) -- always
//      runs, no credentials, no network. These are the substantive branching decisions the route
//      makes; clientPortalRoutes.ts's handleSubmitEstimateEvent is thin glue over them plus the
//      same grant-lookup / D1-insert pattern the already-covered handleSubmitPortalPacket uses.
//   2. Live route integration (gated on SOLESYSTEMS_CLIENT_PORTAL_* creds AND the route being
//      deployed) -- the end-to-end check, matching test/hardening.test.mjs's own live pattern.
//      Skips cleanly until the estimate-event route reaches the dev Worker.
//
// Run with: node --experimental-strip-types --test test/estimate-events.test.ts

import test from 'node:test'
import assert from 'node:assert/strict'
import { parseEstimateEventBody, estimateRefMatchesSnapshot, ESTIMATE_EVENTS } from '../src/estimateEventValidation.ts'

test('parseEstimateEventBody accepts each valid event with a non-empty estimateRef', () => {
  for (const event of ESTIMATE_EVENTS) {
    const result = parseEstimateEventBody({ estimateRef: 'est-123', event })
    assert.equal(result.ok, true)
    if (result.ok) {
      assert.equal(result.estimateRef, 'est-123')
      assert.equal(result.event, event)
    }
  }
})

test('parseEstimateEventBody trims whitespace around estimateRef and event', () => {
  const result = parseEstimateEventBody({ estimateRef: '  est-9  ', event: ' accepted ' })
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.estimateRef, 'est-9')
    assert.equal(result.event, 'accepted')
  }
})

test('parseEstimateEventBody rejects an unknown event', () => {
  const result = parseEstimateEventBody({ estimateRef: 'est-1', event: 'sent' })
  assert.equal(result.ok, false)
})

test('parseEstimateEventBody rejects a missing / empty estimateRef', () => {
  assert.equal(parseEstimateEventBody({ event: 'viewed' }).ok, false)
  assert.equal(parseEstimateEventBody({ estimateRef: '   ', event: 'viewed' }).ok, false)
})

test('parseEstimateEventBody rejects non-object bodies', () => {
  assert.equal(parseEstimateEventBody(null).ok, false)
  assert.equal(parseEstimateEventBody('viewed').ok, false)
  assert.equal(parseEstimateEventBody(['viewed']).ok, false)
})

test('estimateRefMatchesSnapshot matches only the published estimate ref', () => {
  const snapshot = JSON.stringify({ title: 'Job', estimate: { estimateRef: 'est-777', bodyHtml: '<div></div>' } })
  assert.equal(estimateRefMatchesSnapshot(snapshot, 'est-777'), true)
  assert.equal(estimateRefMatchesSnapshot(snapshot, 'est-778'), false)
})

test('estimateRefMatchesSnapshot rejects a snapshot with no published estimate', () => {
  assert.equal(estimateRefMatchesSnapshot(JSON.stringify({ title: 'Job', estimate: null }), 'est-1'), false)
  assert.equal(estimateRefMatchesSnapshot(JSON.stringify({ title: 'Job' }), 'est-1'), false)
})

test('estimateRefMatchesSnapshot tolerates a corrupt payload', () => {
  assert.equal(estimateRefMatchesSnapshot('{not json', 'est-1'), false)
})

// --- Layer 2: live route integration (skips until deployed + credentialed) ---

const relayUrl = (process.env.SOLESYSTEMS_CLIENT_PORTAL_RELAY_URL || '').replace(/\/+$/, '')
const liveInviteToken = process.env.SOLESYSTEMS_CLIENT_PORTAL_TEST_INVITE_TOKEN || ''
const liveEstimateRef = process.env.SOLESYSTEMS_CLIENT_PORTAL_TEST_ESTIMATE_REF || ''
const hasLive = Boolean(relayUrl && liveInviteToken && liveEstimateRef)

test('live: POST /portal/{token}/estimate-event records a viewed event', { skip: !hasLive }, async () => {
  const response = await fetch(`${relayUrl}/portal/${liveInviteToken}/estimate-event`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ estimateRef: liveEstimateRef, event: 'viewed' }),
  })
  const json = await response.json() as { ok?: boolean }
  assert.equal(response.status, 200)
  assert.equal(json.ok, true)
})

test('live: a mismatched estimateRef is rejected', { skip: !hasLive }, async () => {
  const response = await fetch(`${relayUrl}/portal/${liveInviteToken}/estimate-event`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ estimateRef: 'not-the-published-ref', event: 'accepted' }),
  })
  assert.equal(response.status, 400)
})
