// Bridge-only Client Portal Worker (Client_Portal_Site_Publishing_Task_Spec_20261112.md, D5-D7, D14, D16),
// against a real running local Worker started by test/run-local-e2e.mjs on a scratch local D1/R2. Not run
// directly; invoked as a child process by run-local-e2e.mjs with WAVE2A_* env vars set (the signing secret was
// bootstrapped and read back by that file). The state path, wrangler path and database name are passed so this file
// can run `wrangler d1 execute --local --persist-to` for stored-state assertions and to age rows. Nothing remote.

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const baseUrl = (process.env.WAVE2A_BASE_URL || '').replace(/\/+$/, '')
const businessId = process.env.WAVE2A_BUSINESS_ID || ''
const signingSecretB64 = process.env.WAVE2A_SIGNING_SECRET_B64 || ''
const statePath = process.env.WAVE2A_STATE_PATH || ''
const wrangler = process.env.WAVE2A_WRANGLER || ''
const databaseName = process.env.WAVE2A_DATABASE_NAME || ''

assert.ok(
  baseUrl && businessId && signingSecretB64 && statePath && wrangler && databaseName,
  'WAVE2A_BASE_URL/BUSINESS_ID/SIGNING_SECRET_B64/STATE_PATH/WRANGLER/DATABASE_NAME must be set by run-local-e2e.mjs',
)

const signingSecretBytes = Buffer.from(signingSecretB64, 'base64')
const businessIdOther = `${businessId}-other`
const registeredOrigin = 'https://site.example.com'
const otherOrigin = 'https://evil.example.org'
const bucketName = 'businesssuite-client-portal-files-dev'
const longAgo = '2000-01-01T00:00:00.000Z'
const onePixelPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
)

const newToken = () => randomBytes(32).toString('hex')
const sqlString = value => `'${String(value).replaceAll("'", "''")}'`
const futureIso = days => new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString()

// ---------- wrangler (local state only) ----------

function runWrangler(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [wrangler, ...args],
      { cwd: process.cwd(), env: { ...process.env, NO_COLOR: '1', WRANGLER_SEND_METRICS: 'false' }, windowsHide: true })
    let output = ''
    child.stdout.on('data', chunk => { output += String(chunk) })
    child.stderr.on('data', chunk => { output += String(chunk) })
    child.on('error', error => resolve({ code: -1, output: String(error) }))
    child.on('exit', code => resolve({ code, output }))
  })
}

async function sqlRows(command) {
  const { code, output } = await runWrangler(['d1', 'execute', databaseName, '--local', '--persist-to', statePath, '--command', command, '--json'])
  assert.equal(code, 0, `wrangler d1 execute failed: ${output.slice(-1500)}`)
  const parsed = JSON.parse(output.slice(output.indexOf('[')))
  return parsed[0]?.results ?? []
}

async function sqlCount(table, where) {
  const rows = await sqlRows(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`)
  return Number(rows[0]?.n)
}

async function sqlExec(statements) {
  const directory = await mkdtemp(join(tmpdir(), 'bridge-only-sql-'))
  try {
    const file = join(directory, 'statements.sql')
    await writeFile(file, statements.join(';\n') + ';\n')
    const { code, output } = await runWrangler(['d1', 'execute', databaseName, '--local', '--persist-to', statePath, '--file', file])
    assert.equal(code, 0, `wrangler d1 execute (file) failed: ${output.slice(-1500)}`)
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
}

async function r2ObjectExists(key) {
  const directory = await mkdtemp(join(tmpdir(), 'bridge-only-r2-'))
  try {
    const { code } = await runWrangler(['r2', 'object', 'get', `${bucketName}/${key}`, '--local', '--persist-to', statePath, '--file', join(directory, 'out.bin')])
    return code === 0
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
}

// ---------- signed requests ----------

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('')
}

async function signedHeaders(method, pathname, bodyBytes, signerBusinessId) {
  const timestamp = Math.floor(Date.now() / 1000).toString()
  const nonce = randomUUID().replace(/-/g, '')
  const bodyHash = await sha256Hex(bodyBytes)
  const canonicalRequest = [method, pathname, timestamp, nonce, signerBusinessId, bodyHash].join('\n')
  const signature = createHmac('sha256', signingSecretBytes).update(canonicalRequest, 'utf8').digest('base64url')
  return {
    'X-SoleSystems-Business-Id': signerBusinessId,
    'X-SoleSystems-Timestamp': timestamp,
    'X-SoleSystems-Nonce': nonce,
    'X-SoleSystems-Signature': signature,
  }
}

async function signedPost(pathname, body, signerBusinessId = businessId) {
  const bodyText = JSON.stringify({ ...body, businessId: signerBusinessId })
  const headers = await signedHeaders('POST', pathname, new TextEncoder().encode(bodyText), signerBusinessId)
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: bodyText,
  })
  const text = await response.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* non-JSON body */ }
  return { status: response.status, json, response }
}

async function wronglySignedPost(pathname, body, signerBusinessId = businessId) {
  const bodyText = JSON.stringify({ ...body, businessId: signerBusinessId })
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-SoleSystems-Business-Id': signerBusinessId,
      'X-SoleSystems-Timestamp': Math.floor(Date.now() / 1000).toString(),
      'X-SoleSystems-Nonce': randomUUID().replace(/-/g, ''),
      'X-SoleSystems-Signature': randomBytes(32).toString('base64url'),
    },
    body: bodyText,
  })
  return response.status
}

async function signedGet(pathname, signerBusinessId = businessId) {
  const headers = await signedHeaders('GET', pathname, new Uint8Array(0), signerBusinessId)
  return fetch(`${baseUrl}${pathname}`, { method: 'GET', headers })
}

function registerBody(overrides = {}) {
  return {
    inviteToken: newToken(),
    clientId: 'client-one',
    expiresAt: futureIso(30),
    allowedOrigin: registeredOrigin,
    allowedRefs: {},
    ...overrides,
  }
}

async function register(overrides, signerBusinessId = businessId) {
  return signedPost('/business/register-portal', registerBody(overrides), signerBusinessId)
}

function clientPost(token, route, body, origin) {
  return fetch(`${baseUrl}/portal/${token}/${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) },
    body: JSON.stringify(body),
  })
}

const submitBody = documentId => ({
  packetType: 'document_signing_response',
  payload: { documentId, fieldValues: { f1: 'x' }, marks: [] },
})

const header = (response, name) => response.headers.get(name)

// Shared state across the sequential tests below.
const tokenA = newToken() // business, client-a
const tokenB = newToken() // other business, client-b
const documentA = `doc-a-${randomUUID()}`
const documentB = `doc-b-${randomUUID()}`
const estimateA = `est-a-${randomUUID()}`
const estimateB = `est-b-${randomUUID()}`
const invoiceA = `inv-a-${randomUUID()}`
const invoiceB = `inv-b-${randomUUID()}`
const refsA = { documentIds: [documentA], estimateRefs: [estimateA], invoiceRefs: [invoiceA] }
const refsB = { documentIds: [documentB], estimateRefs: [estimateB], invoiceRefs: [invoiceB] }

// ---------- readiness and removed routes ----------

test('readiness reports schema version 7 and carries no licensing fields', async () => {
  const readiness = await fetch(`${baseUrl}/readiness`).then(response => response.json())
  assert.equal(readiness.ok, true)
  assert.equal(readiness.schemaVersion, 7)
  assert.equal(readiness.publishSigningConfigured, true, 'the bootstrap trigger request should have persisted a secret row')
  assert.equal('licensingServiceConfigured' in readiness, false)
  assert.equal('clientPortalLicenseKeyConfigured' in readiness, false)
})

test('the publishing paths are gone and fall through to 404', async () => {
  const someToken = newToken()
  const someUuid = randomUUID()

  assert.equal((await fetch(`${baseUrl}/embed/${someToken}`)).status, 404)
  assert.equal((await fetch(`${baseUrl}/oembed?url=${encodeURIComponent(`${baseUrl}/embed/${someToken}`)}`)).status, 404)
  assert.equal((await fetch(`${baseUrl}/portal/${someToken}`)).status, 404)
  assert.equal((await fetch(`${baseUrl}/portal/${someToken}/objects/${someUuid}`)).status, 404)

  const publish = await signedPost('/business/publish-snapshot', { clientId: 'c', portalContextId: 'p', snapshot: { title: 't' } })
  assert.equal(publish.status, 404, 'publish-snapshot even when correctly signed')

  const uploadPath = '/business/upload-object'
  const uploadHeaders = await signedHeaders('POST', uploadPath, onePixelPng, businessId)
  const upload = await fetch(`${baseUrl}${uploadPath}`, {
    method: 'POST',
    headers: { ...uploadHeaders, 'X-SoleSystems-Client-Id': 'c', 'X-SoleSystems-Content-Type': 'image/png' },
    body: onePixelPng,
  })
  assert.equal(upload.status, 404, 'upload-object even when correctly signed')

  for (const path of ['/health', '/readiness', '/business/pending-packets', `/portal/${someToken}`, `/portal/${someToken}/submit`]) {
    const options = await fetch(`${baseUrl}${path}`, { method: 'OPTIONS', headers: { Origin: registeredOrigin } })
    assert.equal(options.status, 404, `OPTIONS ${path} is 404 (unknown token or not a Client route)`)
    assert.equal(header(options, 'access-control-allow-origin'), null)
  }
})

// ---------- register / unregister ----------

test('register and unregister reject unsigned and wrongly-signed requests', async () => {
  for (const path of ['/business/register-portal', '/business/unregister-portal']) {
    const unsigned = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ businessId, ...registerBody() }),
    })
    assert.equal(unsigned.status, 401, `${path} unsigned`)
    assert.equal(await wronglySignedPost(path, registerBody()), 401, `${path} wrongly signed`)
  }
})

test('register rejects invalid input with 400', async () => {
  assert.equal((await register({ inviteToken: 'not-a-token' })).status, 400, 'bad token')
  assert.equal((await register({ inviteToken: 'A'.repeat(64) })).status, 400, 'uppercase token')
  assert.equal((await register({ allowedOrigin: 'http://example.com' })).status, 400, 'http origin')
  assert.equal((await register({ allowedOrigin: 'https://example.com/some/path' })).status, 400, 'origin with a path')
  assert.equal((await register({ allowedOrigin: '*' })).status, 400, 'wildcard origin')
  assert.equal((await register({ expiresAt: new Date(Date.now() - 60000).toISOString() })).status, 400, 'past expiry')
  assert.equal((await register({ expiresAt: futureIso(401) })).status, 400, 'expiry beyond 400 days')
  assert.equal((await register({ clientId: '' })).status, 400, 'empty client id')
  assert.equal((await register({ allowedRefs: { documentIds: [''] } })).status, 400, 'empty ref')
  const unregister = await signedPost('/business/unregister-portal', { inviteToken: 'short' })
  assert.equal(unregister.status, 400, 'unregister with a bad token')
})

test('register is idempotent: the same input twice gives one grant row and one companion row', async () => {
  const body = registerBody({ inviteToken: tokenA, clientId: 'client-a', allowedRefs: refsA })
  const first = await signedPost('/business/register-portal', body)
  const second = await signedPost('/business/register-portal', body)
  assert.equal(first.status, 200, JSON.stringify(first.json))
  assert.equal(second.status, 200, JSON.stringify(second.json))
  assert.equal(first.json.ok, true)
  assert.equal(second.json.inviteToken, tokenA)
  assert.equal(second.json.expiresAt, new Date(body.expiresAt).toISOString())

  assert.equal(await sqlCount('portal_access_grants', `invite_token = ${sqlString(tokenA)}`), 1)
  assert.equal(
    await sqlCount('portal_live_registrations', `access_grant_id IN (SELECT id FROM portal_access_grants WHERE invite_token = ${sqlString(tokenA)})`),
    1,
  )
  const [stored] = await sqlRows(`SELECT allowed_origin, allowed_refs_json FROM portal_live_registrations WHERE access_grant_id IN (SELECT id FROM portal_access_grants WHERE invite_token = ${sqlString(tokenA)})`)
  assert.equal(stored.allowed_origin, registeredOrigin)
  assert.deepEqual(JSON.parse(stored.allowed_refs_json), refsA)
})

test('another business registering a token that already exists gets a generic 409', async () => {
  const response = await register({ inviteToken: tokenA, clientId: 'client-a', allowedRefs: refsA }, businessIdOther)
  assert.equal(response.status, 409)
  assert.equal(response.json.ok, false)
  assert.ok(!JSON.stringify(response.json).includes(businessId), 'no detail about the other owner')

  const sameBusinessOtherClient = await register({ inviteToken: tokenA, clientId: 'client-zzz', allowedRefs: refsA })
  assert.equal(sameBusinessOtherClient.status, 409, 'a different client id for an existing token is also refused')
})

test('register token B for the other business', async () => {
  const response = await register({ inviteToken: tokenB, clientId: 'client-b', allowedRefs: refsB }, businessIdOther)
  assert.equal(response.status, 200, JSON.stringify(response.json))
})

// ---------- not-live tokens ----------

async function assertNotLiveEverywhere(token, label) {
  for (const route of ['submit', 'upload', 'estimate-event', 'invoice-event']) {
    const response = await fetch(`${baseUrl}/portal/${token}/${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-SoleSystems-Content-Type': 'image/png', Origin: registeredOrigin },
      body: JSON.stringify(submitBody(documentA)),
    })
    assert.equal(response.status, 404, `${label}: POST ${route}`)
    assert.equal(header(response, 'access-control-allow-origin'), null, `${label}: no CORS header on ${route}`)
    const preflight = await fetch(`${baseUrl}/portal/${token}/${route}`, { method: 'OPTIONS', headers: { Origin: registeredOrigin, 'Access-Control-Request-Method': 'POST' } })
    assert.equal(preflight.status, 404, `${label}: OPTIONS ${route}`)
    assert.equal(header(preflight, 'access-control-allow-origin'), null, `${label}: no CORS header on the ${route} preflight`)
  }
}

test('unregistered, unregistered-later, expired and legacy tokens are all 404 on every client route', async () => {
  await assertNotLiveEverywhere(newToken(), 'unknown token')

  const unregisteredLater = newToken()
  assert.equal((await register({ inviteToken: unregisteredLater, clientId: 'client-gone' })).status, 200)
  const first = await signedPost('/business/unregister-portal', { inviteToken: unregisteredLater })
  const second = await signedPost('/business/unregister-portal', { inviteToken: unregisteredLater })
  assert.deepEqual([first.status, first.json.removed], [200, true])
  assert.deepEqual([second.status, second.json.removed], [200, false], 'unregister twice is idempotent')
  assert.equal(await sqlCount('portal_live_registrations', `access_grant_id IN (SELECT id FROM portal_access_grants WHERE invite_token = ${sqlString(unregisteredLater)})`), 0)
  assert.equal(await sqlCount('portal_access_grants', `invite_token = ${sqlString(unregisteredLater)} AND revoked_at IS NOT NULL`), 1)
  await assertNotLiveEverywhere(unregisteredLater, 'unregistered token')

  const expired = newToken()
  assert.equal((await register({ inviteToken: expired, clientId: 'client-expired' })).status, 200)
  await sqlExec([`UPDATE portal_access_grants SET expires_at = ${sqlString(longAgo)} WHERE invite_token = ${sqlString(expired)}`])
  await assertNotLiveEverywhere(expired, 'expired registration')

  const legacy = newToken()
  await sqlExec([
    `INSERT OR IGNORE INTO portal_businesses (id) VALUES (${sqlString(businessId)})`,
    `INSERT OR IGNORE INTO portal_clients (id, business_id) VALUES ('client-legacy', ${sqlString(businessId)})`,
    `INSERT INTO portal_access_grants (id, business_id, client_id, portal_context_id, invite_token) VALUES (${sqlString(randomUUID())}, ${sqlString(businessId)}, 'client-legacy', 'legacy-context', ${sqlString(legacy)})`,
  ])
  await assertNotLiveEverywhere(legacy, 'legacy grant without a companion row')

  // Another business unregistering token A is a no-op: it is not that business's token.
  const foreign = await signedPost('/business/unregister-portal', { inviteToken: tokenA }, businessIdOther)
  assert.deepEqual([foreign.status, foreign.json.removed], [200, false])
  const stillLive = await clientPost(tokenA, 'submit', submitBody(documentA))
  assert.equal(stillLive.status, 200, 'token A is still live after a foreign unregister attempt')
  await sqlExec([`DELETE FROM portal_packet_inbox WHERE access_grant_id IN (SELECT id FROM portal_access_grants WHERE invite_token = ${sqlString(tokenA)})`])
})

// ---------- CORS ----------

test('CORS: preflight answers the registered origin exactly and nobody else', async () => {
  for (const route of ['submit', 'upload', 'estimate-event', 'invoice-event']) {
    const allowed = await fetch(`${baseUrl}/portal/${tokenA}/${route}`, { method: 'OPTIONS', headers: { Origin: registeredOrigin, 'Access-Control-Request-Method': 'POST' } })
    assert.equal(allowed.status, 204, `preflight ${route}`)
    assert.equal(header(allowed, 'access-control-allow-origin'), registeredOrigin)
    assert.equal(header(allowed, 'access-control-allow-methods'), 'POST, OPTIONS')
    assert.equal(header(allowed, 'access-control-allow-headers'), 'Content-Type, X-SoleSystems-Content-Type')
    assert.equal(header(allowed, 'access-control-max-age'), '600')
    assert.equal(header(allowed, 'vary'), 'Origin')

    const other = await fetch(`${baseUrl}/portal/${tokenA}/${route}`, { method: 'OPTIONS', headers: { Origin: otherOrigin, 'Access-Control-Request-Method': 'POST' } })
    assert.equal(other.status, 403, `preflight ${route} from another origin`)
    assert.equal(header(other, 'access-control-allow-origin'), null)
    assert.equal(header(other, 'access-control-allow-methods'), null)
    assert.equal(header(other, 'vary'), 'Origin')
  }
  const noOrigin = await fetch(`${baseUrl}/portal/${tokenA}/submit`, { method: 'OPTIONS' })
  assert.equal(noOrigin.status, 403, 'preflight with no Origin')
  assert.equal(header(noOrigin, 'access-control-allow-origin'), null)
})

test('CORS: POST responses carry the registered origin only, never * and never a reflected origin', async () => {
  const fromRegistered = await clientPost(tokenA, 'submit', submitBody(documentA), registeredOrigin)
  assert.equal(fromRegistered.status, 200)
  assert.equal(header(fromRegistered, 'access-control-allow-origin'), registeredOrigin)
  assert.match(header(fromRegistered, 'vary') || '', /Origin/)

  const errorFromRegistered = await clientPost(tokenA, 'submit', { packetType: 'document_signing_response', payload: { documentId: 'not-registered' } }, registeredOrigin)
  assert.equal(errorFromRegistered.status, 400)
  assert.equal(header(errorFromRegistered, 'access-control-allow-origin'), registeredOrigin, 'a 400 is readable by the page')

  const fromOther = await clientPost(tokenA, 'submit', submitBody(documentA), otherOrigin)
  assert.equal(header(fromOther, 'access-control-allow-origin'), null)
  assert.match(header(fromOther, 'vary') || '', /Origin/)

  const fromNone = await clientPost(tokenA, 'submit', submitBody(documentA))
  assert.equal(header(fromNone, 'access-control-allow-origin'), null)

  for (const response of [fromRegistered, errorFromRegistered, fromOther, fromNone]) {
    assert.notEqual(header(response, 'access-control-allow-origin'), '*')
  }
  await sqlExec([`DELETE FROM portal_packet_inbox WHERE access_grant_id IN (SELECT id FROM portal_access_grants WHERE invite_token = ${sqlString(tokenA)})`])
})

// ---------- A/B isolation of registered refs ----------

test('token B cannot submit refs registered only for token A; its own refs work and are tied to B', async () => {
  const [grantB] = await sqlRows(`SELECT id FROM portal_access_grants WHERE invite_token = ${sqlString(tokenB)}`)

  const foreignDocument = await clientPost(tokenB, 'submit', submitBody(documentA), registeredOrigin)
  assert.equal(foreignDocument.status, 400)
  assert.equal(await sqlCount('portal_packet_inbox', `access_grant_id = ${sqlString(grantB.id)}`), 0, 'no packet row for the rejected submission')

  const wrongType = await clientPost(tokenB, 'submit', { packetType: 'photo_upload', payload: { documentId: documentB } }, registeredOrigin)
  assert.equal(wrongType.status, 400, 'only document_signing_response is accepted')
  const noPayload = await clientPost(tokenB, 'submit', { packetType: 'document_signing_response' }, registeredOrigin)
  assert.equal(noPayload.status, 400)
  assert.equal(await sqlCount('portal_packet_inbox', `access_grant_id = ${sqlString(grantB.id)}`), 0)

  const own = await clientPost(tokenB, 'submit', { ...submitBody(documentB), businessId, clientId: 'client-a', accessGrantId: 'spoofed' }, registeredOrigin)
  const ownText = await own.text()
  assert.equal(own.status, 200, ownText)
  const [packet] = await sqlRows(`SELECT business_id, client_id, access_grant_id, packet_type FROM portal_packet_inbox WHERE access_grant_id = ${sqlString(grantB.id)}`)
  assert.equal(packet.business_id, businessIdOther)
  assert.equal(packet.client_id, 'client-b')
  assert.equal(packet.access_grant_id, grantB.id)
  assert.equal(packet.packet_type, 'document_signing_response')
  await sqlExec([`DELETE FROM portal_packet_inbox WHERE access_grant_id = ${sqlString(grantB.id)}`])
})

test('estimate and invoice events are checked against the registered refs; viewed is de-duplicated', async () => {
  const foreignEstimate = await clientPost(tokenB, 'estimate-event', { estimateRef: estimateA, event: 'viewed' }, registeredOrigin)
  assert.equal(foreignEstimate.status, 400)
  const foreignInvoice = await clientPost(tokenB, 'invoice-event', { invoiceRef: invoiceA, event: 'viewed' }, registeredOrigin)
  assert.equal(foreignInvoice.status, 400)

  const viewed = await clientPost(tokenB, 'estimate-event', { estimateRef: estimateB, event: 'viewed' }, registeredOrigin)
  assert.equal(viewed.status, 200)
  const viewedAgain = await clientPost(tokenB, 'estimate-event', { estimateRef: estimateB, event: 'viewed' }, registeredOrigin)
  assert.equal(viewedAgain.status, 200)
  assert.equal((await viewedAgain.json()).deduped, true)
  const accepted = await clientPost(tokenB, 'estimate-event', { estimateRef: estimateB, event: 'accepted' }, registeredOrigin)
  assert.equal(accepted.status, 200)

  const invoiceViewed = await clientPost(tokenB, 'invoice-event', { invoiceRef: invoiceB, event: 'viewed' }, registeredOrigin)
  assert.equal(invoiceViewed.status, 200)
  const invoiceViewedAgain = await clientPost(tokenB, 'invoice-event', { invoiceRef: invoiceB, event: 'viewed' }, registeredOrigin)
  assert.equal((await invoiceViewedAgain.json()).deduped, true)

  const [grantB] = await sqlRows(`SELECT id FROM portal_access_grants WHERE invite_token = ${sqlString(tokenB)}`)
  assert.equal(await sqlCount('portal_packet_inbox', `access_grant_id = ${sqlString(grantB.id)} AND packet_type = 'estimate_event'`), 2)
  assert.equal(await sqlCount('portal_packet_inbox', `access_grant_id = ${sqlString(grantB.id)} AND packet_type = 'invoice_event'`), 1)
  await sqlExec([`DELETE FROM portal_packet_inbox WHERE access_grant_id = ${sqlString(grantB.id)}`])
})

// ---------- ack-and-delete ----------

test('acknowledging a packet deletes it, its receipts and (for a photo) the object and the R2 bytes', async () => {
  const upload = await fetch(`${baseUrl}/portal/${tokenB}/upload`, {
    method: 'POST',
    headers: { 'X-SoleSystems-Content-Type': 'image/png', Origin: registeredOrigin },
    body: onePixelPng,
  })
  const uploadJson = await upload.json()
  assert.equal(upload.status, 200, JSON.stringify(uploadJson))
  assert.equal(header(upload, 'access-control-allow-origin'), registeredOrigin)
  const { objectId, packetId } = uploadJson

  const notAnImage = await fetch(`${baseUrl}/portal/${tokenB}/upload`, { method: 'POST', headers: { 'X-SoleSystems-Content-Type': 'text/html' }, body: '<b>x</b>' })
  assert.equal(notAnImage.status, 400)

  const listed = await signedPost('/business/pending-packets', {}, businessIdOther)
  assert.ok(listed.json.packets.some(packet => packet.id === packetId), 'the photo packet is listed')

  const download = await signedGet(`/business/objects/${objectId}`, businessIdOther)
  assert.equal(download.status, 200)
  assert.equal(Buffer.from(await download.arrayBuffer()).length, onePixelPng.length)
  const otherBusinessDownload = await signedGet(`/business/objects/${objectId}`, businessId)
  assert.equal(otherBusinessDownload.status, 404, 'another business cannot download it')

  const objectKey = `business/${businessIdOther}/portal/client-b/objects/${objectId}`
  const r2BeforeAck = await r2ObjectExists(objectKey)
  if (!r2BeforeAck) {
    console.log('NOTE: wrangler r2 object get --local did not work offline here; the R2 byte check is skipped (the D1 rows are asserted).')
  }

  await sqlExec([`INSERT INTO portal_sync_receipts (id, business_id, packet_id) VALUES (${sqlString(randomUUID())}, ${sqlString(businessIdOther)}, ${sqlString(packetId)})`])
  assert.equal(await sqlCount('portal_sync_receipts', `packet_id = ${sqlString(packetId)}`), 1)

  const unknownAck = await signedPost('/business/acknowledge-packet', { packetId: randomUUID() }, businessIdOther)
  assert.equal(unknownAck.status, 404)
  const foreignAck = await signedPost('/business/acknowledge-packet', { packetId }, businessId)
  assert.equal(foreignAck.status, 404, 'another business cannot acknowledge it')

  const ack = await signedPost('/business/acknowledge-packet', { packetId }, businessIdOther)
  assert.equal(ack.status, 200, JSON.stringify(ack.json))
  assert.equal(ack.json.deleted, true)
  assert.equal(ack.json.packetId, packetId)

  const relisted = await signedPost('/business/pending-packets', {}, businessIdOther)
  assert.ok(!relisted.json.packets.some(packet => packet.id === packetId), 'no longer listed')
  assert.equal((await signedGet(`/business/objects/${objectId}`, businessIdOther)).status, 404, 'download is gone')
  assert.equal(await sqlCount('portal_packet_inbox', `id = ${sqlString(packetId)}`), 0)
  assert.equal(await sqlCount('portal_file_objects', `id = ${sqlString(objectId)}`), 0)
  assert.equal(await sqlCount('portal_sync_receipts', `packet_id = ${sqlString(packetId)}`), 0)
  if (r2BeforeAck) assert.equal(await r2ObjectExists(objectKey), false, 'the R2 bytes are gone')

  const ackAgain = await signedPost('/business/acknowledge-packet', { packetId }, businessIdOther)
  assert.equal(ackAgain.status, 404, 'acknowledging a deleted packet stays 404')
})

test('the Business download route serves only client_upload objects', async () => {
  const objectId = randomUUID()
  await sqlExec([
    `INSERT OR IGNORE INTO portal_clients (id, business_id) VALUES ('client-one', ${sqlString(businessId)})`,
    `INSERT INTO portal_file_objects (id, business_id, client_id, r2_object_key, content_type, byte_size, purpose, expires_at) VALUES (${sqlString(objectId)}, ${sqlString(businessId)}, 'client-one', ${sqlString(`k/${objectId}`)}, 'image/png', 1, 'published_document', ${sqlString(futureIso(5))})`,
  ])
  assert.equal((await signedGet(`/business/objects/${objectId}`)).status, 404)
  await sqlExec([`DELETE FROM portal_file_objects WHERE id = ${sqlString(objectId)}`])
})

// ---------- sweep scope ----------

test('the cleanup sweep removes only expired registry rows and expired client uploads', async () => {
  const expiredToken = newToken()
  const liveToken = newToken()
  assert.equal((await register({ inviteToken: expiredToken, clientId: 'client-sweep-expired' })).status, 200)
  assert.equal((await register({ inviteToken: liveToken, clientId: 'client-sweep-live' })).status, 200)
  await sqlExec([`UPDATE portal_access_grants SET expires_at = ${sqlString(longAgo)} WHERE invite_token = ${sqlString(expiredToken)}`])

  const publishedId = randomUUID()
  const uploadId = randomUUID()
  await sqlExec([
    `INSERT OR IGNORE INTO portal_clients (id, business_id) VALUES ('client-one', ${sqlString(businessId)})`,
    `INSERT INTO portal_file_objects (id, business_id, client_id, r2_object_key, content_type, byte_size, purpose, expires_at) VALUES (${sqlString(publishedId)}, ${sqlString(businessId)}, 'client-one', ${sqlString(`k/${publishedId}`)}, 'image/png', 1, 'published_document', ${sqlString(longAgo)})`,
    `INSERT INTO portal_file_objects (id, business_id, client_id, r2_object_key, content_type, byte_size, purpose, expires_at) VALUES (${sqlString(uploadId)}, ${sqlString(businessId)}, 'client-one', ${sqlString(`k/${uploadId}`)}, 'image/png', 1, 'client_upload', ${sqlString(longAgo)})`,
  ])
  const legacyBefore = await sqlCount('portal_access_grants', 'expires_at IS NULL')
  assert.ok(legacyBefore >= 1, 'the legacy grant inserted earlier is present')

  const sweep = await signedPost('/business/run-cleanup', {})
  assert.equal(sweep.status, 200, JSON.stringify(sweep.json))
  for (const key of ['deletedRegistrations', 'deletedGrants', 'deletedAcknowledgedPackets', 'deletedExpiredPendingPackets', 'deletedFileObjects']) {
    assert.equal(typeof sweep.json[key], 'number', key)
  }
  assert.equal('deletedSnapshots' in sweep.json, false)
  assert.ok(sweep.json.deletedRegistrations >= 1)
  assert.ok(sweep.json.deletedGrants >= 1)
  assert.ok(sweep.json.deletedFileObjects >= 1)

  assert.equal(await sqlCount('portal_access_grants', `invite_token = ${sqlString(expiredToken)}`), 0, 'expired registry grant removed')
  assert.equal(await sqlCount('portal_live_registrations', `access_grant_id NOT IN (SELECT id FROM portal_access_grants)`), 0, 'no orphan companion row')
  assert.equal(await sqlCount('portal_access_grants', `invite_token = ${sqlString(liveToken)}`), 1, 'live registration kept')
  assert.equal(await sqlCount('portal_live_registrations', `access_grant_id IN (SELECT id FROM portal_access_grants WHERE invite_token = ${sqlString(liveToken)})`), 1)
  assert.equal(await sqlCount('portal_access_grants', `invite_token = ${sqlString(tokenA)}`), 1, 'token A kept')
  assert.equal(await sqlCount('portal_file_objects', `id = ${sqlString(publishedId)}`), 1, 'legacy published_document row left alone')
  assert.equal(await sqlCount('portal_file_objects', `id = ${sqlString(uploadId)}`), 0, 'expired client_upload row removed')
  assert.equal(await sqlCount('portal_access_grants', 'expires_at IS NULL'), legacyBefore, 'legacy grants (null expires_at) never touched')

  const earlier = await sqlCount('portal_access_grants', `revoked_at IS NOT NULL AND expires_at IS NOT NULL AND business_id = ${sqlString(businessId)}`)
  assert.equal(earlier, 0, 'the earlier unregistered/expired registry grants were swept too')
})
