// Cloudflare_Self_Hosting_Implementation_Task_Spec_20260928.md Wave 2A: exercises the real publish-
// time licensing gate (checkPublishEntitlement -> checkClientPortalAccessRemote,
// clientPortalLicensingClient.ts) against a real running Worker with CLIENT_PORTAL_LICENSE_KEY
// configured, over real HTTP to a local stub standing in for the centrally hosted licensing Worker's
// POST /check-client-portal-access (Wave 1A). Not run directly; invoked as a child process by
// test/run-local-e2e.mjs with WAVE2A_* env vars set, including WAVE2A_STUB_CONTROL_URL to
// reconfigure what the stub returns between test cases.

import test from 'node:test'
import assert from 'node:assert/strict'
import { createHmac, randomUUID } from 'node:crypto'

const baseUrl = (process.env.WAVE2A_BASE_URL || '').replace(/\/+$/, '')
const businessId = process.env.WAVE2A_BUSINESS_ID || ''
const signingSecretB64 = process.env.WAVE2A_SIGNING_SECRET_B64 || ''
const stubControlUrl = process.env.WAVE2A_STUB_CONTROL_URL || ''

assert.ok(
  baseUrl && businessId && signingSecretB64 && stubControlUrl,
  'WAVE2A_BASE_URL/BUSINESS_ID/SIGNING_SECRET_B64/STUB_CONTROL_URL must be set by run-local-e2e.mjs',
)

const signingSecretBytes = Buffer.from(signingSecretB64, 'base64')

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('')
}

async function setStubResponse(status, body) {
  const response = await fetch(stubControlUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status, body }),
  })
  assert.equal(response.status, 200, 'stub control endpoint should accept the new response')
}

async function signedPublishRequest(snapshotTitle) {
  const bodyObject = {
    businessId,
    clientId: 'license-gate-client',
    portalContextId: 'license-gate-context',
    snapshot: { title: snapshotTitle },
  }
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

test('readiness reports a configured license key', async () => {
  const readiness = await fetch(`${baseUrl}/readiness`).then(r => r.json())
  assert.equal(readiness.ok, true)
  assert.equal(readiness.clientPortalLicenseKeyConfigured, true)
  assert.equal(readiness.licensingServiceConfigured, true)
})

test('publish is blocked (403) when the licensing service reports not entitled', async () => {
  await setStubResponse(200, {
    ok: true,
    message: 'stub: checked',
    clientPortalAccess: {
      entitlementCode: 'client_portal',
      status: 'not_entitled',
      entitled: false,
      message: 'stub: this license does not include Client Portal.',
    },
  })

  const response = await signedPublishRequest('Should be blocked')
  const json = await response.json()
  assert.equal(response.status, 403, `expected 403, got ${response.status}: ${JSON.stringify(json)}`)
  assert.equal(json.ok, false)
  assert.match(json.message, /does not include client portal/i)
})

test('publish is blocked (403) when the licensing service call itself fails', async () => {
  await setStubResponse(401, { ok: false, message: 'stub: license key was not found.' })

  const response = await signedPublishRequest('Should also be blocked')
  const json = await response.json()
  assert.equal(response.status, 403, `expected 403, got ${response.status}: ${JSON.stringify(json)}`)
  assert.equal(json.ok, false)
})

test('publish succeeds once the licensing service reports entitled', async () => {
  await setStubResponse(200, {
    ok: true,
    message: 'stub: checked',
    clientPortalAccess: {
      entitlementCode: 'client_portal',
      status: 'active',
      entitled: true,
      message: 'stub: entitled.',
    },
  })

  const response = await signedPublishRequest('Should succeed')
  const json = await response.json()
  assert.equal(response.status, 200, `expected 200, got ${response.status}: ${JSON.stringify(json)}`)
  assert.equal(json.ok, true)
  assert.ok(json.inviteToken)
})
