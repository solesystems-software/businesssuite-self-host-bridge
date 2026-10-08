// Local integration coverage for the Client Portal Worker: apply the real schema to a scratch local D1 (via
// `wrangler d1 execute --local`), boot a real `wrangler dev` instance against that state, bootstrap the
// self-generated publish signing secret, and drive publish over actual HTTP with node:test. Client Portal has no
// licensing role (Galen, 2026-09-30), so the Worker is started with no licensing configuration at all and publish
// must still work. The other test/*.test.mjs files still hit the live *deployed* dev Worker and skip when the local
// development override file is absent.
// `--compatibility-date 2026-07-06` is passed to the local `wrangler dev` invocation only -- it pins the local dev
// runtime to a date the bundled workerd supports; wrangler.toml itself is untouched, so real deploys are unaffected.
//
// Run with: npm run test:local (from cloudflare-client-portal/), or: node test/run-local-e2e.mjs

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'

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

const temporary = await mkdtemp(join(tmpdir(), 'businesssuite-client-portal-'))
let worker

try {
  {
    const statePath = join(temporary, 'state-fail-open')
    await applySchema(statePath)
    const port = 8799
    worker = await startWorker({ port, statePath })
    const baseUrl = `http://127.0.0.1:${port}`
    const businessId = `publish-without-licensing-${randomUUID()}`
    const secretBase64 = await bootstrapAndReadPublishSigningSecret(baseUrl, statePath, businessId)

    await run(process.execPath, ['test/publish-without-licensing.test.mjs'], {
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

  console.log('\nClient Portal local e2e: passed.')
} finally {
  await stopWorker(worker)
  await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 })
}
