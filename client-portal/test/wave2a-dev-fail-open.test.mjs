// Cloudflare_Self_Hosting_Implementation_Task_Spec_20260928.md Wave 2A: exercises the
// dev-sandbox-with-no-license-key-configured path on a real running Worker (started by
// test/run-local-e2e.mjs against a scratch local D1 -- see that file for how the publish signing
// secret was bootstrapped and read back). Not run directly; invoked as a child process by
// run-local-e2e.mjs with WAVE2A_* env vars set.
//
// Confirms this task's new publish-time licensing gate (checkPublishEntitlement,
// clientPortalLicensingClient.ts) does not break this Worker's actual current deployed-dev
// configuration, which has no CLIENT_PORTAL_LICENSE_KEY set yet -- publish must keep succeeding
// exactly as it did before this task, until a real key is wired in (Wave 4's setup screen).

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

test('readiness reports the bootstrapped publish secret and the new licensing fields', async () => {
  const readiness = await fetch(`${baseUrl}/readiness`).then(r => r.json())
  assert.equal(readiness.ok, true)
  assert.equal(readiness.publishSigningConfigured, true, 'the bootstrap trigger request should have persisted a secret row')
  assert.equal(readiness.licensingServiceConfigured, true)
  assert.equal(readiness.clientPortalLicenseKeyConfigured, false, 'this phase deliberately configures no license key')
})

test('publish succeeds with no CLIENT_PORTAL_LICENSE_KEY configured, in development', async () => {
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
