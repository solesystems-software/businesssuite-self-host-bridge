import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'

const temporary = await mkdtemp(join(tmpdir(), 'businesssuite-mobile-sync-'))
const statePath = join(temporary, 'state')
const envPath = join(temporary, 'worker.env')
const bootstrapSecret = randomBytes(32).toString('base64url')
const safeEnvironment = { ...process.env, NO_COLOR: '1' }
let worker
let workerOutput = ''

const run = (command, args, options = {}) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { cwd: process.cwd(), env: safeEnvironment, windowsHide: true, ...options })
  let output = ''
  child.stdout?.on('data', chunk => { output += String(chunk) })
  child.stderr?.on('data', chunk => { output += String(chunk) })
  child.on('error', reject)
  child.on('exit', code => code === 0 ? resolve(output) : reject(new Error(`${command} exited ${code}: ${output.slice(-2000)}`)))
})

try {
  // The credential encryption key is no longer injected here: it is self-bootstrapped into D1 by
  // the Worker on first use (see getOrCreateWorkerEncryptionKeyB64 in mobileSyncSecurity.ts). Each
  // local test run still gets its own fresh, isolated key, since each run applies migrations into
  // its own fresh temporary --persist-to D1 state directory and nothing has bootstrapped a row yet.
  await writeFile(envPath, [
    `MOBILE_SYNC_DEVELOPMENT_BOOTSTRAP_SECRET=${bootstrapSecret}`,
  ].join('\n'), { encoding: 'utf8', mode: 0o600 })

  const wrangler = join(process.cwd(), 'node_modules', 'wrangler', 'bin', 'wrangler.js')
  await run(process.execPath, [wrangler, 'd1', 'migrations', 'apply', 'businesssuite-mobile-sync-dev',
    '--local', '--persist-to', statePath])

  worker = spawn(process.execPath, [wrangler, 'dev', '--port', '8791', '--persist-to', statePath,
    '--env-file', envPath], { cwd: process.cwd(), env: safeEnvironment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  worker.stdout.on('data', chunk => { workerOutput = (workerOutput + String(chunk)).slice(-6000) })
  worker.stderr.on('data', chunk => { workerOutput = (workerOutput + String(chunk)).slice(-6000) })

  let ready = false
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const health = await fetch('http://127.0.0.1:8791/health')
      if (health.ok) { ready = true; break }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  if (!ready) {
    const safeOutput = workerOutput.replaceAll(bootstrapSecret, '[redacted]')
    throw new Error(`Local Worker did not become ready. ${safeOutput}`)
  }

  // Worker-generated desktop bootstrap secret (migration 0005): a request without it is rejected but makes
  // the Worker create it; reading it out of D1 (what Deploy Now does remotely) then lets the desktop in.
  // The wrong-secret request also proves the development-only test secret is not the only way in.
  const bootstrapUrl = 'http://127.0.0.1:8791/v1/desktop/bootstrap'
  const bootstrapBody = JSON.stringify({ account_sync_id: 'acct-bootstrap-check', desktop_client_id: 'desktop-bootstrap-check' })
  const rejected = await fetch(bootstrapUrl, { method: 'POST', body: bootstrapBody })
  if (rejected.status !== 401) throw new Error(`Bootstrap without a secret should be 401, got ${rejected.status}.`)
  const secretRows = JSON.parse(await run(process.execPath, [wrangler, 'd1', 'execute', 'businesssuite-mobile-sync-dev',
    '--local', '--persist-to', statePath, '--json', '--command',
    'SELECT desktop_bootstrap_secret_b64 AS secret FROM mobile_sync_worker_settings WHERE singleton_id = 1']))
  const workerSecret = secretRows?.[0]?.results?.[0]?.secret
  if (!workerSecret || Buffer.from(workerSecret, 'base64').byteLength !== 32) throw new Error('Worker did not generate its own bootstrap secret.')
  const wrong = await fetch(bootstrapUrl, { method: 'POST', body: bootstrapBody, headers: { 'x-solesystems-bootstrap-secret': 'not-the-secret' } })
  if (wrong.status !== 401) throw new Error(`Bootstrap with a wrong secret should be 401, got ${wrong.status}.`)
  const accepted = await fetch(bootstrapUrl, { method: 'POST', body: bootstrapBody, headers: { 'x-solesystems-bootstrap-secret': workerSecret } })
  if (accepted.status !== 201) throw new Error(`Bootstrap with the Worker's own secret should be 201, got ${accepted.status}.`)
  console.log('Worker-generated bootstrap secret: rejected without, rejected when wrong, accepted with.')

  await run(process.execPath, ['tests/deployed-e2e.mjs'], { env: {
    ...safeEnvironment,
    MOBILE_SYNC_TEST_BASE_URL: 'http://127.0.0.1:8791',
    MOBILE_SYNC_TEST_BOOTSTRAP_SECRET: bootstrapSecret,
  }, stdio: 'inherit' })
} finally {
  if (worker && worker.exitCode === null) {
    const exited = new Promise(resolve => worker.once('exit', resolve))
    worker.kill('SIGINT')
    await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 3000))])
    if (worker.exitCode === null) worker.kill('SIGTERM')
  }
  await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 })
}
