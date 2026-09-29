// Cloudflare_Self_Hosting_Implementation_Task_Spec_20260928.md Wave 2A: local integration coverage
// for the three Worker-side changes (licensing HTTPS call + publish gate, payments mock-mode fail-
// closed gate, publish-signing-secret self-bootstrap). Mirrors cloudflare/test/run-local-e2e.mjs's
// own precedent (that Worker's Wave 1A test, added for exactly the same reason: no live-deployed-
// Worker test can exercise code that has not been deployed yet) -- apply the real schema to a scratch
// local D1 (via `wrangler d1 execute --local`), boot real `wrangler dev` instances against that state,
// and drive the routes over actual HTTP with node:test. The existing test/*.test.mjs files in this
// directory are unaffected: they still hit the live *deployed* dev Worker and skip when
// .env.client-portal.development.local is absent (unchanged by this task) -- but they cannot exercise
// this task's own changes, since this task does not deploy them; that gap is what this file closes.
//
// Three short-lived local `wrangler dev` instances are run in sequence, each against its own fresh
// --persist-to scratch D1 state (never the dev D1 this Worker's `wrangler dev` normally binds to):
//   1. dev-fail-open   -- no CLIENT_PORTAL_LICENSE_KEY configured, SERVICE_ENVIRONMENT=development
//                         (this Worker's current real deployed state) -- publish must still succeed.
//   2. license-gate     -- CLIENT_PORTAL_LICENSE_KEY configured, LICENSING_SERVICE_URL pointed at a
//                         local stub standing in for the licensing Worker's own
//                         POST /check-client-portal-access (real HTTP, only the *remote service* is
//                         stubbed -- same trust boundary any HTTP client test stubs) -- publish is
//                         blocked when the stub reports not-entitled and allowed once it reports
//                         entitled.
//   3. payments-fail-closed -- SERVICE_ENVIRONMENT overridden away from "development", no Stripe
//                         secrets -- a Client-facing payment-intent request must return "payments
//                         unavailable", never a mock success.
// `--compatibility-date 2026-07-06` is passed to each local `wrangler dev` invocation only -- this
// pins the *local dev runtime* to a date the wrangler 4.107.0 devDependency's bundled workerd binary
// actually supports (it does not yet support this Worker's real wrangler.toml compatibility_date,
// 2026-08-22); wrangler.toml itself is untouched, so this has no effect on real deploys.
//
// Run with: npm run test:local (from cloudflare-client-portal/), or: node test/run-local-e2e.mjs

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import http from 'node:http'

const safeEnvironment = { ...process.env, NO_COLOR: '1' }
const wrangler = join(process.cwd(), 'node_modules', 'wrangler', 'bin', 'wrangler.js')
const databaseName = 'businesssuite-client-portal-dev'
const localCompatibilityDate = '2026-07-06'

const run = (command, args, options = {}) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { cwd: process.cwd(), env: safeEnvironment, windowsHide: true, ...options })
  let output = ''
  child.stdout?.on('data', chunk => { output += String(chunk) })
  child.stderr?.on('data', chunk => { output += String(chunk) })
  child.on('error', reject)
  child.on('exit', code => code === 0 ? resolve(output) : reject(new Error(`${command} exited ${code}: ${output.slice(-4000)}`)))
})

async function applySchema(statePath) {
  await run(process.execPath, [wrangler, 'd1', 'execute', databaseName,
    '--local', '--persist-to', statePath, '--file', 'schema.sql'])
}

async function execSql(statePath, sql) {
  await run(process.execPath, [wrangler, 'd1', 'execute', databaseName,
    '--local', '--persist-to', statePath, '--command', sql])
}

async function querySqlFirst(statePath, sql) {
  const out = await run(process.execPath, [wrangler, 'd1', 'execute', databaseName,
    '--local', '--persist-to', statePath, '--command', sql, '--json'])
  const parsed = JSON.parse(out)
  return parsed[0]?.results?.[0] ?? null
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`
}

async function startWorker({ port, statePath, vars }) {
  const args = [wrangler, 'dev', '--port', String(port), '--persist-to', statePath,
    '--compatibility-date', localCompatibilityDate]
  for (const [key, value] of Object.entries(vars || {})) {
    args.push('--var', `${key}:${value}`)
  }
  const worker = spawn(process.execPath, args,
    { cwd: process.cwd(), env: safeEnvironment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  worker.stdout.on('data', chunk => { output = (output + String(chunk)).slice(-6000) })
  worker.stderr.on('data', chunk => { output = (output + String(chunk)).slice(-6000) })

  let ready = false
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const health = await fetch(`http://127.0.0.1:${port}/health`)
      if (health.ok) { ready = true; break }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  if (!ready) throw new Error(`Local Worker (port ${port}) did not become ready.\n${output}`)
  return worker
}

async function stopWorker(worker) {
  if (!worker || worker.exitCode !== null) return
  const exited = new Promise(resolve => worker.once('exit', resolve))
  worker.kill('SIGINT')
  await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 3000))])
  if (worker.exitCode === null) worker.kill('SIGTERM')
}

// Bootstraps the self-generated publish signing secret by sending one throwaway, deliberately
// wrongly-signed publish request (still header/body-shape-valid, so it reaches the point in
// authenticateBusinessJsonRequest that calls getOrCreatePublishSigningSecretBase64 before the
// signature comparison even happens), then reads the now-persisted secret straight out of local D1.
// This is the only way a test client can ever learn a self-bootstrapped secret's value -- exactly the
// "there is nothing to generate, copy, or paste" property self-hosting-design.md's "Secret handoff"
// section describes; a real desktop app would need its own retrieval mechanism (Wave 4, not built
// here) to learn it instead of reading D1 directly.
async function bootstrapAndReadPublishSigningSecret(baseUrl, statePath, businessId) {
  const dummySignature = randomBytes(32).toString('base64url')
  await fetch(`${baseUrl}/business/publish-snapshot`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-SoleSystems-Business-Id': businessId,
      'X-SoleSystems-Timestamp': Math.floor(Date.now() / 1000).toString(),
      'X-SoleSystems-Nonce': randomUUID().replace(/-/g, ''),
      'X-SoleSystems-Signature': dummySignature,
    },
    body: JSON.stringify({ businessId, clientId: 'bootstrap-trigger-client', portalContextId: 'bootstrap-trigger', snapshot: { title: 'bootstrap trigger' } }),
  })

  const row = await querySqlFirst(statePath,
    'SELECT publish_signing_secret FROM client_portal_worker_settings WHERE singleton_id = 1')
  if (!row?.publish_signing_secret) {
    throw new Error('Publish signing secret did not bootstrap into D1 as expected.')
  }
  return row.publish_signing_secret
}

// --- Stub licensing server: stands in for the centrally hosted licensing Worker's real
// POST /check-client-portal-access (Wave 1A, cloudflare/src/licenseRoutes.ts). Only the remote
// service is stubbed -- the Client Portal Worker under test calls it over real HTTP, exactly as it
// would call the real licensing Worker, so clientPortalLicensingClient.ts's actual request/response
// handling is exercised, not bypassed. Controllable mid-test via a same-process control endpoint.
let stubResponse = {
  status: 200,
  body: {
    ok: true,
    message: 'stub: entitled',
    clientPortalAccess: { entitlementCode: 'client_portal', status: 'active', entitled: true, message: 'stub: entitled' },
  },
}

function startStubLicensingServer() {
  const server = http.createServer((request, response) => {
    const chunks = []
    request.on('data', chunk => chunks.push(chunk))
    request.on('end', () => {
      if (request.method === 'POST' && request.url === '/__control/set-response') {
        try {
          stubResponse = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        } catch (error) {
          response.writeHead(400, { 'Content-Type': 'application/json' })
          response.end(JSON.stringify({ ok: false, message: String(error) }))
          return
        }
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ ok: true }))
        return
      }
      if (request.method === 'POST' && request.url === '/check-client-portal-access') {
        response.writeHead(stubResponse.status, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify(stubResponse.body))
        return
      }
      response.writeHead(404, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ ok: false, message: 'stub: not found' }))
    })
  })
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve(server))
    server.on('error', reject)
  })
}

const temporary = await mkdtemp(join(tmpdir(), 'businesssuite-client-portal-'))
let stubServer
let worker

try {
  stubServer = await startStubLicensingServer()
  const stubPort = stubServer.address().port
  const stubBaseUrl = `http://127.0.0.1:${stubPort}`

  // ---------------------------------------------------------------------------
  // Phase 1: dev-fail-open -- no CLIENT_PORTAL_LICENSE_KEY configured. This is this Worker's actual
  // current deployed-dev state; publish must keep working exactly as before this task's changes.
  // ---------------------------------------------------------------------------
  {
    const statePath = join(temporary, 'state-fail-open')
    await applySchema(statePath)
    const port = 8799
    worker = await startWorker({
      port,
      statePath,
      vars: { LICENSING_SERVICE_URL: stubBaseUrl },
    })
    const baseUrl = `http://127.0.0.1:${port}`
    const businessId = `wave2a-fail-open-${randomUUID()}`
    const secretBase64 = await bootstrapAndReadPublishSigningSecret(baseUrl, statePath, businessId)

    await run(process.execPath, ['test/wave2a-dev-fail-open.test.mjs'], {
      env: {
        ...safeEnvironment,
        WAVE2A_BASE_URL: baseUrl,
        WAVE2A_BUSINESS_ID: businessId,
        WAVE2A_SIGNING_SECRET_B64: secretBase64,
      },
      stdio: 'inherit',
    })

    await stopWorker(worker)
    worker = null
  }

  // ---------------------------------------------------------------------------
  // Phase 2: license-gate -- CLIENT_PORTAL_LICENSE_KEY configured, licensing check performed against
  // the stub for real over HTTP. Blocks publish when not entitled, allows it once entitled.
  // ---------------------------------------------------------------------------
  {
    const statePath = join(temporary, 'state-license-gate')
    await applySchema(statePath)
    const port = 8800
    worker = await startWorker({
      port,
      statePath,
      vars: {
        LICENSING_SERVICE_URL: stubBaseUrl,
        CLIENT_PORTAL_LICENSE_KEY: 'wave2a-test-license-key',
      },
    })
    const baseUrl = `http://127.0.0.1:${port}`
    const businessId = `wave2a-license-gate-${randomUUID()}`
    const secretBase64 = await bootstrapAndReadPublishSigningSecret(baseUrl, statePath, businessId)

    await run(process.execPath, ['test/wave2a-license-gate.test.mjs'], {
      env: {
        ...safeEnvironment,
        WAVE2A_BASE_URL: baseUrl,
        WAVE2A_BUSINESS_ID: businessId,
        WAVE2A_SIGNING_SECRET_B64: secretBase64,
        WAVE2A_STUB_CONTROL_URL: `${stubBaseUrl}/__control/set-response`,
      },
      stdio: 'inherit',
    })

    await stopWorker(worker)
    worker = null
  }

  // ---------------------------------------------------------------------------
  // Phase 3: payments-fail-closed -- SERVICE_ENVIRONMENT overridden away from "development", no
  // Stripe secrets configured. Seeded directly in D1 (the business-authenticated publish route is
  // unaffected by this task and stays development-only, so it cannot be used to set this up here) --
  // a real published payment must exist so the Client-facing payment-intent route has something to
  // act on. Confirms the route returns "payments unavailable" rather than a mock success.
  // ---------------------------------------------------------------------------
  {
    const statePath = join(temporary, 'state-payments-fail-closed')
    await applySchema(statePath)

    const businessId = `wave2a-payments-${randomUUID()}`
    const clientId = randomUUID()
    const grantId = randomUUID()
    const inviteToken = randomBytes(32).toString('hex')
    const snapshotId = randomUUID()
    const expiresAt = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString()
    const payload = JSON.stringify({
      title: 'Wave 2A payments-fail-closed fixture',
      documents: [],
      photos: [],
      payment: { invoiceRef: 'wave2a-invoice-1', title: 'Test invoice', amountCents: 5000, currency: 'usd' },
      notesHtml: null,
    })

    await execSql(statePath, `INSERT INTO portal_businesses (id) VALUES (${sqlString(businessId)})`)
    await execSql(statePath, `INSERT INTO portal_clients (id, business_id) VALUES (${sqlString(clientId)}, ${sqlString(businessId)})`)
    await execSql(statePath, `
      INSERT INTO portal_access_grants (id, business_id, client_id, portal_context_id, invite_token)
      VALUES (${sqlString(grantId)}, ${sqlString(businessId)}, ${sqlString(clientId)}, ${sqlString('wave2a-context')}, ${sqlString(inviteToken)})
    `)
    await execSql(statePath, `
      INSERT INTO portal_snapshots_current (id, business_id, client_id, access_grant_id, payload_json, expires_at)
      VALUES (${sqlString(snapshotId)}, ${sqlString(businessId)}, ${sqlString(clientId)}, ${sqlString(grantId)}, ${sqlString(payload)}, ${sqlString(expiresAt)})
    `)

    const port = 8801
    worker = await startWorker({
      port,
      statePath,
      vars: { SERVICE_ENVIRONMENT: 'wave2a-self-hosted-probe' },
    })
    const baseUrl = `http://127.0.0.1:${port}`

    await run(process.execPath, ['test/wave2a-payments-fail-closed.test.mjs'], {
      env: {
        ...safeEnvironment,
        WAVE2A_BASE_URL: baseUrl,
        WAVE2A_INVITE_TOKEN: inviteToken,
        WAVE2A_BUSINESS_ID: businessId,
      },
      stdio: 'inherit',
    })

    await stopWorker(worker)
    worker = null
  }

  console.log('\nWave 2A local e2e: all phases passed.')
} finally {
  await stopWorker(worker)
  if (stubServer) await new Promise(resolve => stubServer.close(resolve))
  await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 })
}
