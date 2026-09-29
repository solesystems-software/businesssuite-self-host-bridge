// Client_Portal_Mode_CR_Task_Spec_20260822.md Part B Phase 8: real, live tenant-isolation and
// replay-protection tests against the actual deployed dev Worker -- this project's established
// "real, not stubbed" testing discipline (Part E's own acceptance bar), the Node/test-runner
// counterpart to the desktop repo's Playwright suite for the piece that has no Electron/browser
// surface to drive.
//
// Requires live relay credentials, sourced from the same SOLESYSTEMS_CLIENT_PORTAL_* environment
// variables the desktop app itself uses (see .env.client-portal.development.local, gitignored, never
// committed). Skips entirely if they are not present.
//
// Run with: node --test test/hardening.test.mjs

import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, createHmac, randomUUID } from 'node:crypto'

const relayUrl = (process.env.SOLESYSTEMS_CLIENT_PORTAL_RELAY_URL || '').replace(/\/+$/, '')
const signingSecretBase64 = process.env.SOLESYSTEMS_CLIENT_PORTAL_SIGNING_SECRET || ''
// Business A reuses the desktop app's own configured business id (so it also exercises the exact
// same account real Playwright runs already left data under); Business B is a synthetic id that
// exists only for this test run, signed with the same Worker-level shared secret (Part D: this
// relay implements only the single "development_shared_secret" mode -- there is no per-business
// secret to isolate on, so the real security property under test is that D1 queries scope strictly
// by the *signed* businessId, never trusting anything client-supplied).
const businessIdA = process.env.SOLESYSTEMS_CLIENT_PORTAL_BUSINESS_ID || ''
const businessIdB = `hardening-test-business-b-${Date.now()}`
const hasCredentials = Boolean(relayUrl && signingSecretBase64 && businessIdA)

const signingSecretBytes = signingSecretBase64 ? Buffer.from(signingSecretBase64, 'base64') : Buffer.alloc(0)

function buildSignedHeaders(businessId, method, pathname, bodyHash, overrideTimestamp, overrideNonce) {
  const timestamp = overrideTimestamp || Math.floor(Date.now() / 1000).toString()
  const nonce = overrideNonce || randomUUID().replace(/-/g, '')
  const canonicalRequest = [method, pathname, timestamp, nonce, businessId, bodyHash].join('\n')
  const signature = createHmac('sha256', signingSecretBytes).update(canonicalRequest, 'utf8').digest('base64url')
  return {
    headers: {
      'X-SoleSystems-Business-Id': businessId,
      'X-SoleSystems-Timestamp': timestamp,
      'X-SoleSystems-Nonce': nonce,
      'X-SoleSystems-Signature': signature,
    },
    timestamp,
    nonce,
  }
}

async function signedPostJson(businessId, pathname, body) {
  const bodyWithBusinessId = { ...body, businessId }
  const bodyText = JSON.stringify(bodyWithBusinessId)
  const bodyHash = createHash('sha256').update(bodyText, 'utf8').digest('hex')
  const { headers } = buildSignedHeaders(businessId, 'POST', pathname, bodyHash)
  const response = await fetch(`${relayUrl}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: bodyText,
  })
  const json = await response.json()
  return { status: response.status, json }
}

async function signedPostBinary(businessId, pathname, bytes, extraHeaders) {
  const bodyHash = createHash('sha256').update(bytes).digest('hex')
  const { headers } = buildSignedHeaders(businessId, 'POST', pathname, bodyHash)
  const response = await fetch(`${relayUrl}${pathname}`, {
    method: 'POST',
    headers: { ...headers, ...extraHeaders },
    body: bytes,
  })
  const json = await response.json()
  return { status: response.status, json }
}

async function signedGetBinaryRaw(businessId, pathname, overrideTimestamp, overrideNonce) {
  const bodyHash = createHash('sha256').update(Buffer.alloc(0)).digest('hex')
  const { headers } = buildSignedHeaders(businessId, 'GET', pathname, bodyHash, overrideTimestamp, overrideNonce)
  return fetch(`${relayUrl}${pathname}`, { method: 'GET', headers })
}

async function publishMinimalSnapshot(businessId, clientId) {
  const onePixelPng = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  )
  const upload = await signedPostBinary(businessId, '/business/upload-object', onePixelPng, {
    'X-SoleSystems-Client-Id': clientId,
    'X-SoleSystems-Content-Type': 'image/png',
    'X-SoleSystems-Object-Purpose': 'hardening_test',
  })
  assert.equal(upload.status, 200, `upload-object failed: ${JSON.stringify(upload.json)}`)
  const objectId = upload.json.objectId

  const publish = await signedPostJson(businessId, '/business/publish-snapshot', {
    clientId,
    portalContextId: 'hardening-test',
    snapshot: { title: 'Hardening test', jobSummary: null, documents: [], photos: [{ photoId: 'p1', objectId, caption: null }] },
    fileObjectIds: [objectId],
  })
  assert.equal(publish.status, 200, `publish-snapshot failed: ${JSON.stringify(publish.json)}`)

  return { objectId, inviteToken: publish.json.inviteToken }
}

test('Client Portal hardening: tenant isolation and replay protection', { skip: !hasCredentials }, async (t) => {
  const clientIdA = `hardening-client-a-${Date.now()}`
  const clientIdB = `hardening-client-b-${Date.now()}`

  const { objectId: objectIdA, inviteToken: inviteTokenA } = await publishMinimalSnapshot(businessIdA, clientIdA)
  const { inviteToken: inviteTokenB } = await publishMinimalSnapshot(businessIdB, clientIdB)

  await t.test('Business B cannot download an object Business A owns', async () => {
    const response = await signedGetBinaryRaw(businessIdB, `/business/objects/${objectIdA}`)
    assert.equal(response.status, 404, 'Business B should not be able to read Business A\'s object')
  })

  await t.test('Business A can still download its own object', async () => {
    const response = await signedGetBinaryRaw(businessIdA, `/business/objects/${objectIdA}`)
    assert.equal(response.status, 200, 'Business A should be able to read its own object')
  })

  await t.test('Business B\'s pending-packets never includes Business A\'s packets', async () => {
    // Have a Client upload a photo through Business A's own invite token, so there is a real
    // pending packet under Business A to try (and fail) to see from Business B's own list call.
    const onePixelPng = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    )
    const clientUpload = await fetch(`${relayUrl}/portal/${inviteTokenA}/upload`, {
      method: 'POST',
      headers: { 'X-SoleSystems-Content-Type': 'image/png' },
      body: onePixelPng,
    })
    assert.equal(clientUpload.status, 200)
    const clientUploadBody = await clientUpload.json()

    const businessAPackets = await signedPostJson(businessIdA, '/business/pending-packets', {})
    assert.equal(businessAPackets.status, 200)
    assert.ok(
      businessAPackets.json.packets.some(packet => packet.payload?.objectId === clientUploadBody.objectId),
      'Business A should see its own Client\'s pending packet',
    )

    const businessBPackets = await signedPostJson(businessIdB, '/business/pending-packets', {})
    assert.equal(businessBPackets.status, 200)
    assert.ok(
      !businessBPackets.json.packets.some(packet => packet.payload?.objectId === clientUploadBody.objectId),
      'Business B must never see Business A\'s pending packet',
    )
  })

  await t.test('Invite token A cannot read an object published only under invite token B\'s Client', async () => {
    // clientPortalRoutes.ts's handleGetPortalObject scopes strictly by the requesting token's own
    // grant.business_id/client_id -- a syntactically valid object id belonging to a different
    // Client's grant must 404, not leak.
    const { objectId: objectIdB } = await publishMinimalSnapshot(businessIdB, `${clientIdB}-second`)
    const response = await fetch(`${relayUrl}/portal/${inviteTokenA}/objects/${objectIdB}`)
    assert.equal(response.status, 404, 'A Client\'s own invite token must not resolve another Client\'s object id')
  })

  await t.test('Replay protection: reusing an exact signed request (same timestamp/nonce) is rejected', async () => {
    const timestamp = Math.floor(Date.now() / 1000).toString()
    const nonce = randomUUID().replace(/-/g, '')

    const first = await signedGetBinaryRaw(businessIdA, `/business/objects/${objectIdA}`, timestamp, nonce)
    assert.equal(first.status, 200, 'first use of a fresh nonce should succeed')

    const replay = await signedGetBinaryRaw(businessIdA, `/business/objects/${objectIdA}`, timestamp, nonce)
    assert.equal(replay.status, 401, 'reusing the same timestamp/nonce/signature must be rejected as a replay')
  })

  await t.test('A tampered signature is rejected', async () => {
    const bodyHash = createHash('sha256').update(Buffer.alloc(0)).digest('hex')
    const timestamp = Math.floor(Date.now() / 1000).toString()
    const nonce = randomUUID().replace(/-/g, '')
    const canonicalRequest = ['GET', `/business/objects/${objectIdA}`, timestamp, nonce, businessIdA, bodyHash].join('\n')
    const validSignature = createHmac('sha256', signingSecretBytes).update(canonicalRequest, 'utf8').digest('base64url')
    const tamperedSignature = `${validSignature.slice(0, -1)}${validSignature.at(-1) === 'A' ? 'B' : 'A'}`

    const response = await fetch(`${relayUrl}/business/objects/${objectIdA}`, {
      method: 'GET',
      headers: {
        'X-SoleSystems-Business-Id': businessIdA,
        'X-SoleSystems-Timestamp': timestamp,
        'X-SoleSystems-Nonce': nonce,
        'X-SoleSystems-Signature': tamperedSignature,
      },
    })
    assert.equal(response.status, 401, 'a tampered signature must be rejected')
  })
})
