// Client_Portal_Mode_CR_Task_Spec_20260822.md Part B Phase 7: a real, live smoke test confirming
// POST /business/run-cleanup actually executes against the deployed dev Worker and returns real
// counts (not that anything is necessarily expired right now -- this dev database has nothing old
// enough yet -- just that the routine runs end to end without error and the response shape is real).
// Run with: node --test test/cleanup-smoke.test.mjs

import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, createHmac, randomUUID } from 'node:crypto'

const relayUrl = (process.env.SOLESYSTEMS_CLIENT_PORTAL_RELAY_URL || '').replace(/\/+$/, '')
const signingSecretBase64 = process.env.SOLESYSTEMS_CLIENT_PORTAL_SIGNING_SECRET || ''
const businessId = process.env.SOLESYSTEMS_CLIENT_PORTAL_BUSINESS_ID || ''
const hasCredentials = Boolean(relayUrl && signingSecretBase64 && businessId)

test('Client Portal Phase 7: POST /business/run-cleanup runs and returns real counts', { skip: !hasCredentials }, async () => {
  const signingSecretBytes = Buffer.from(signingSecretBase64, 'base64')
  const pathname = '/business/run-cleanup'
  const bodyText = JSON.stringify({ businessId })
  const bodyHash = createHash('sha256').update(bodyText, 'utf8').digest('hex')
  const timestamp = Math.floor(Date.now() / 1000).toString()
  const nonce = randomUUID().replace(/-/g, '')
  const canonicalRequest = ['POST', pathname, timestamp, nonce, businessId, bodyHash].join('\n')
  const signature = createHmac('sha256', signingSecretBytes).update(canonicalRequest, 'utf8').digest('base64url')

  const response = await fetch(`${relayUrl}${pathname}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-SoleSystems-Business-Id': businessId,
      'X-SoleSystems-Timestamp': timestamp,
      'X-SoleSystems-Nonce': nonce,
      'X-SoleSystems-Signature': signature,
    },
    body: bodyText,
  })

  const json = await response.json()
  assert.equal(response.status, 200, `run-cleanup failed: ${JSON.stringify(json)}`)
  assert.equal(json.ok, true)
  assert.equal(typeof json.deletedSnapshots, 'number')
  assert.equal(typeof json.deletedAcknowledgedPackets, 'number')
  assert.equal(typeof json.deletedExpiredPendingPackets, 'number')
  assert.equal(typeof json.deletedFileObjects, 'number')
})
