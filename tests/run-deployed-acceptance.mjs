import { join } from 'node:path'
import { spawn } from 'node:child_process'

// Deploys the current Worker source to a target Worker and runs the deployed acceptance suite
// against it.
//
// This script does NOT touch the target Worker's secrets. It used to `wrangler secret put` a
// freshly-randomised MOBILE_SYNC_CREDENTIAL_ENCRYPTION_KEY_B64 and MOBILE_SYNC_DEVELOPMENT_BOOTSTRAP_SECRET
// on every run — which, run against the shared `businesssuite-mobile-sync-dev` Worker, silently
// invalidated every credential that Worker had already issued (a rotated encryption key can no
// longer decrypt existing stored credential secrets) and locked out unauthenticated dev bootstrap.
// That is exactly what broke desktop pairing + mobile sync on 2026-09-03. Secrets are now the
// operator's responsibility and are expected to already be set on the target Worker.
//
// Required env:
//   MOBILE_SYNC_TEST_BASE_URL          - the deployed Worker's base URL to test against.
// Optional env:
//   MOBILE_SYNC_TEST_WORKER_NAME       - `wrangler deploy` target name (default: from wrangler.toml).
//   MOBILE_SYNC_TEST_BOOTSTRAP_SECRET  - only needed if the target Worker has a
//                                        MOBILE_SYNC_DEVELOPMENT_BOOTSTRAP_SECRET set. Leave unset
//                                        for a Worker with open dev bootstrap (e.g. shared dev).

const wrangler = join(process.cwd(), 'node_modules', 'wrangler', 'bin', 'wrangler.js')
const environment = { ...process.env, NO_COLOR: '1' }

const baseUrl = process.env.MOBILE_SYNC_TEST_BASE_URL
if (!baseUrl) throw new Error('MOBILE_SYNC_TEST_BASE_URL is required.')
// The Worker ignores an x-solesystems-bootstrap-secret header when it has no bootstrap secret set,
// so a placeholder is safe for an open-bootstrap Worker; deployed-e2e.mjs only requires the var
// to be present.
const bootstrapSecret = process.env.MOBILE_SYNC_TEST_BOOTSTRAP_SECRET || 'open-dev-bootstrap-no-secret'

const run = (args, { input, env = environment, inherit = false } = {}) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [wrangler, ...args], {
    cwd: process.cwd(), env, windowsHide: true,
    stdio: inherit ? 'inherit' : ['pipe', 'pipe', 'pipe'],
  })
  let output = ''
  if (!inherit) {
    child.stdout.on('data', chunk => { output += String(chunk) })
    child.stderr.on('data', chunk => { output += String(chunk) })
    if (input !== undefined) child.stdin.end(`${input}\n`)
    else child.stdin.end()
  }
  child.on('error', reject)
  child.on('exit', code => {
    if (code === 0) { if (output.trim()) process.stdout.write(output); resolve(output) }
    else reject(new Error(`Wrangler exited ${code}: ${output.slice(-3000)}`))
  })
})

await run(['d1', 'migrations', 'apply', 'businesssuite-mobile-sync-dev', '--remote'])
const deployArgs = ['deploy']
if (process.env.MOBILE_SYNC_TEST_WORKER_NAME) deployArgs.push('--name', process.env.MOBILE_SYNC_TEST_WORKER_NAME)
await run(deployArgs)

let deployedReady = false
for (let attempt = 0; attempt < 60; attempt += 1) {
  try {
    const health = await fetch(`${baseUrl}/health`)
    const body = await health.json()
    if (health.ok && body.protocol_version === 1) { deployedReady = true; break }
  } catch {}
  await new Promise(resolve => setTimeout(resolve, 1000))
}
if (!deployedReady) throw new Error('Deployed Worker version did not become ready.')

const acceptanceEnvironment = {
  ...environment,
  MOBILE_SYNC_TEST_BASE_URL: baseUrl,
  MOBILE_SYNC_TEST_BOOTSTRAP_SECRET: bootstrapSecret,
}
const test = spawn(process.execPath, ['tests/deployed-e2e.mjs'], {
  cwd: process.cwd(), env: acceptanceEnvironment, windowsHide: true, stdio: 'inherit',
})
await new Promise((resolve, reject) => {
  test.on('error', reject)
  test.on('exit', code => code === 0 ? resolve() : reject(new Error(`Deployed acceptance exited ${code}.`)))
})

const liveFixturePath = process.env.MOBILE_SYNC_LIVE_FIXTURE_PATH?.trim()
if (liveFixturePath) {
  const fixture = spawn(process.execPath, ['tests/create-live-roundtrip-fixture.mjs'], {
    cwd: process.cwd(),
    env: {...acceptanceEnvironment,MOBILE_SYNC_LIVE_FIXTURE_PATH:liveFixturePath},
    windowsHide:true,
    stdio:'inherit',
  })
  await new Promise((resolve,reject)=>{
    fixture.on('error',reject)
    fixture.on('exit',code=>code===0?resolve():reject(new Error(`Live fixture creation exited ${code}.`)))
  })
}
