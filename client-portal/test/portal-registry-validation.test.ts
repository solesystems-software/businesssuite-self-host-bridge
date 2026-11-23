// Pure coverage for the live-token registry validation (src/portalRegistryValidation.ts): token shape,
// origin normalisation, allowed-refs parsing and expiry bounds. No network, no credentials.
//
// Run with: node --experimental-strip-types --test test/portal-registry-validation.test.ts

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  isValidInviteToken,
  normalizeAllowedOrigin,
  parseAllowedRefs,
  parseRegisterPortalBody,
  parseRegistrationExpiry,
} from '../src/portalRegistryValidation.ts'

const now = Date.parse('2026-11-12T12:00:00.000Z')
const day = 24 * 60 * 60 * 1000
const token = 'a'.repeat(64)

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    businessId: 'business-0001',
    inviteToken: token,
    clientId: 'client-1',
    expiresAt: new Date(now + 30 * day).toISOString(),
    allowedOrigin: 'https://www.example.com',
    allowedRefs: { documentIds: ['doc-1'], estimateRefs: ['est-1'], invoiceRefs: ['inv-1'] },
    ...overrides,
  }
}

test('isValidInviteToken accepts exactly 64 lowercase hex characters', () => {
  assert.equal(isValidInviteToken(token), true)
  assert.equal(isValidInviteToken('A'.repeat(64)), false)
  assert.equal(isValidInviteToken('a'.repeat(63)), false)
  assert.equal(isValidInviteToken('a'.repeat(65)), false)
  assert.equal(isValidInviteToken('g'.repeat(64)), false)
  assert.equal(isValidInviteToken(undefined), false)
  assert.equal(isValidInviteToken(12), false)
})

test('normalizeAllowedOrigin accepts an https origin and tolerates one trailing slash', () => {
  assert.equal(normalizeAllowedOrigin('https://www.example.com'), 'https://www.example.com')
  assert.equal(normalizeAllowedOrigin('https://www.example.com/'), 'https://www.example.com')
  assert.equal(normalizeAllowedOrigin('https://example.com:8443'), 'https://example.com:8443')
})

test('normalizeAllowedOrigin accepts http only for localhost, 127.0.0.1 and [::1]', () => {
  assert.equal(normalizeAllowedOrigin('http://localhost:3000'), 'http://localhost:3000')
  assert.equal(normalizeAllowedOrigin('http://127.0.0.1:8123'), 'http://127.0.0.1:8123')
  assert.equal(normalizeAllowedOrigin('http://[::1]:8123'), 'http://[::1]:8123')
  assert.equal(normalizeAllowedOrigin('http://example.com'), null)
  assert.equal(normalizeAllowedOrigin('http://192.168.1.5'), null)
})

test('normalizeAllowedOrigin rejects a path, query, fragment, credentials, wildcard or other scheme', () => {
  for (const value of [
    'https://example.com/path',
    'https://example.com/?a=1',
    'https://example.com?a=1',
    'https://example.com#frag',
    'https://example.com//',
    'https://user:pass@example.com',
    '*',
    'null',
    'ftp://example.com',
    'javascript:alert(1)',
    'example.com',
    '',
  ]) {
    assert.equal(normalizeAllowedOrigin(value), null, `expected ${JSON.stringify(value)} to be rejected`)
  }
  assert.equal(normalizeAllowedOrigin(undefined), null)
  assert.equal(normalizeAllowedOrigin(5), null)
})

test('parseAllowedRefs treats missing as empty and accepts the three id lists', () => {
  assert.deepEqual(parseAllowedRefs(undefined), { ok: true, refs: { documentIds: [], estimateRefs: [], invoiceRefs: [] } })
  assert.deepEqual(parseAllowedRefs({}), { ok: true, refs: { documentIds: [], estimateRefs: [], invoiceRefs: [] } })
  const result = parseAllowedRefs({ documentIds: ['d1', ' d2 '], estimateRefs: ['e1'], invoiceRefs: [] })
  assert.deepEqual(result, { ok: true, refs: { documentIds: ['d1', 'd2'], estimateRefs: ['e1'], invoiceRefs: [] } })
})

test('parseAllowedRefs rejects non-objects, non-arrays, empty/long/non-string entries and oversized lists', () => {
  assert.equal(parseAllowedRefs('x').ok, false)
  assert.equal(parseAllowedRefs([]).ok, false)
  assert.equal(parseAllowedRefs({ documentIds: 'd1' }).ok, false)
  assert.equal(parseAllowedRefs({ documentIds: [''] }).ok, false)
  assert.equal(parseAllowedRefs({ documentIds: ['   '] }).ok, false)
  assert.equal(parseAllowedRefs({ estimateRefs: [7] }).ok, false)
  assert.equal(parseAllowedRefs({ invoiceRefs: ['x'.repeat(201)] }).ok, false)
  assert.equal(parseAllowedRefs({ invoiceRefs: ['x'.repeat(200)] }).ok, true)
  assert.equal(parseAllowedRefs({ documentIds: Array.from({ length: 100 }, (_, index) => `d${index}`) }).ok, true)
  assert.equal(parseAllowedRefs({ documentIds: Array.from({ length: 101 }, (_, index) => `d${index}`) }).ok, false)
})

test('parseRegistrationExpiry enforces future and the 400-day ceiling', () => {
  const ok = parseRegistrationExpiry(new Date(now + day).toISOString(), now)
  assert.equal(ok.ok, true)
  assert.equal(parseRegistrationExpiry(new Date(now - day).toISOString(), now).ok, false)
  assert.equal(parseRegistrationExpiry(new Date(now).toISOString(), now).ok, false)
  assert.equal(parseRegistrationExpiry(new Date(now + 400 * day).toISOString(), now).ok, true)
  assert.equal(parseRegistrationExpiry(new Date(now + 400 * day + 1000).toISOString(), now).ok, false)
})

test('parseRegistrationExpiry rejects non-ISO and unparseable values', () => {
  assert.equal(parseRegistrationExpiry('tomorrow', now).ok, false)
  assert.equal(parseRegistrationExpiry('2026-13-45T00:00:00Z', now).ok, false)
  assert.equal(parseRegistrationExpiry(12345, now).ok, false)
  assert.equal(parseRegistrationExpiry(undefined, now).ok, false)
})

test('parseRegisterPortalBody accepts a complete body and normalises the origin and expiry', () => {
  const result = parseRegisterPortalBody(validBody({ allowedOrigin: 'https://www.example.com/' }), now)
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.inviteToken, token)
    assert.equal(result.clientId, 'client-1')
    assert.equal(result.allowedOrigin, 'https://www.example.com')
    assert.equal(result.expiresAtIso, new Date(now + 30 * day).toISOString())
    assert.deepEqual(result.allowedRefs, { documentIds: ['doc-1'], estimateRefs: ['est-1'], invoiceRefs: ['inv-1'] })
  }
})

test('parseRegisterPortalBody rejects each invalid field', () => {
  assert.equal(parseRegisterPortalBody(validBody({ inviteToken: 'short' }), now).ok, false)
  assert.equal(parseRegisterPortalBody(validBody({ clientId: '' }), now).ok, false)
  assert.equal(parseRegisterPortalBody(validBody({ clientId: 'c'.repeat(201) }), now).ok, false)
  assert.equal(parseRegisterPortalBody(validBody({ clientId: 'c'.repeat(200) }), now).ok, true)
  assert.equal(parseRegisterPortalBody(validBody({ expiresAt: new Date(now - day).toISOString() }), now).ok, false)
  assert.equal(parseRegisterPortalBody(validBody({ allowedOrigin: 'http://example.com' }), now).ok, false)
  assert.equal(parseRegisterPortalBody(validBody({ allowedOrigin: 'https://example.com/path' }), now).ok, false)
  assert.equal(parseRegisterPortalBody(validBody({ allowedRefs: 'nope' }), now).ok, false)
})

test('parseRegisterPortalBody treats missing allowedRefs as three empty lists', () => {
  const body = validBody()
  delete (body as Record<string, unknown>).allowedRefs
  const result = parseRegisterPortalBody(body, now)
  assert.equal(result.ok, true)
  if (result.ok) assert.deepEqual(result.allowedRefs, { documentIds: [], estimateRefs: [], invoiceRefs: [] })
})
