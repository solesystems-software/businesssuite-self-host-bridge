// Publishing works on a Worker with no licensing configured at all (Client Portal has no licensing role since
// 2026-09-30), against a real running local Worker started by test/run-local-e2e.mjs on a scratch D1. Not run
// directly; invoked as a child process by run-local-e2e.mjs with WAVE2A_* env vars set (the publish signing secret
// was bootstrapped and read back by that file).

import test from 'node:test'
import assert from 'node:assert/strict'
import { createHmac, randomBytes, randomUUID } from 'node:crypto'

const baseUrl = (process.env.WAVE2A_BASE_URL || '').replace(/\/+$/, '')
const businessId = process.env.WAVE2A_BUSINESS_ID || ''
const signingSecretB64 = process.env.WAVE2A_SIGNING_SECRET_B64 || ''

assert.ok(baseUrl && businessId && signingSecretB64, 'WAVE2A_BASE_URL/BUSINESS_ID/SIGNING_SECRET_B64 must be set by run-local-e2e.mjs')

const signingSecretBytes = Buffer.from(signingSecretB64, 'base64')

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('')
}

async function signedPublishRequest(bodyObject) {
  const bodyText = JSON.stringify(bodyObject)
  const timestamp = Math.floor(Date.now() / 1000).toString()
  const nonce = randomUUID().replace(/-/g, '')
  const bodyHash = await sha256Hex(bodyText)
  const canonicalRequest = ['POST', '/business/publish-snapshot', timestamp, nonce, businessId, bodyHash].join('\n')
  const signature = createHmac('sha256', signingSecretBytes).update(canonicalRequest, 'utf8').digest('base64url')

  return fetch(`${baseUrl}/business/publish-snapshot`, {
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
}

test('readiness reports the bootstrapped publish secret and carries no licensing fields', async () => {
  const readiness = await fetch(`${baseUrl}/readiness`).then(r => r.json())
  assert.equal(readiness.ok, true)
  assert.equal(readiness.publishSigningConfigured, true, 'the bootstrap trigger request should have persisted a secret row')
  assert.equal('licensingServiceConfigured' in readiness, false)
  assert.equal('clientPortalLicenseKeyConfigured' in readiness, false)
})

test('publish succeeds with no licensing configured', async () => {
  const response = await signedPublishRequest({
    businessId,
    clientId: 'fail-open-client',
    portalContextId: 'fail-open-context',
    snapshot: { title: 'Fail-open regression check' },
  })
  const json = await response.json()
  assert.equal(response.status, 200, `expected 200, got ${response.status}: ${JSON.stringify(json)}`)
  assert.equal(json.ok, true)
  assert.ok(json.inviteToken)
})

test('a publish request with a wrong signature is still rejected', async () => {
  const bodyText = JSON.stringify({
    businessId,
    clientId: 'fail-open-client',
    portalContextId: 'fail-open-context',
    snapshot: { title: 'Wrong signature check' },
  })
  const response = await fetch(`${baseUrl}/business/publish-snapshot`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-SoleSystems-Business-Id': businessId,
      'X-SoleSystems-Timestamp': Math.floor(Date.now() / 1000).toString(),
      'X-SoleSystems-Nonce': randomUUID().replace(/-/g, ''),
      'X-SoleSystems-Signature': randomBytes(32).toString('base64url'),
    },
    body: bodyText,
  })
  assert.equal(response.status, 401)
  const json = await response.json()
  assert.equal(json.ok, false)
})
