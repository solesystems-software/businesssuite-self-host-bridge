// BA-055: the Client Portal cleanup must delete a portal_file_objects D1 row only after its R2 object is gone.
// If the R2 delete fails, the row must survive so the next sweep retries the key; a successful delete removes both.
//
// Run: node --experimental-strip-types --test test/ba-055-cleanup-r2-failure-keeps-row.test.mjs
// D1 and R2 are in-process fakes; the real clientPortalCleanup.ts runs. Nothing touches the network.
import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { registerHooks } from 'node:module'

// Only extensionless relative imports need resolving (clientPortalCleanup.ts imports types only).
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context)
    } catch (error) {
      if (specifier.startsWith('.') && !/\.[cm]?[jt]s$/.test(specifier)) return nextResolve(`${specifier}.ts`, context)
      throw error
    }
  },
})

const { runClientPortalCleanup } = await import('../src/clientPortalCleanup.ts')

const longExpired = '2000-01-01T00:00:00.000Z'

// Fake D1: understands only the statements clientPortalCleanup.ts issues against portal_file_objects.
function makeDb(objectRows) {
  const rows = new Map(objectRows.map(row => [row.id, { ...row }]))
  const cleanupLog = []
  return {
    rows,
    cleanupLog,
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async all() {
              if (/^SELECT id, business_id, r2_object_key FROM portal_file_objects WHERE expires_at <= \?/.test(sql)) {
                const results = [...rows.values()]
                  .filter(row => row.expires_at <= args[0])
                  .map(({ id, business_id, r2_object_key }) => ({ id, business_id, r2_object_key }))
                return { results }
              }
              return { results: [] }
            },
            async run() {
              if (/^DELETE FROM portal_file_objects WHERE id = \?/.test(sql)) {
                rows.delete(args[0])
              } else if (/^DELETE FROM portal_file_objects WHERE expires_at <= \?/.test(sql)) {
                // The pre-fix sweep: drops every expired row, including ones whose R2 delete failed.
                for (const [id, row] of rows) if (row.expires_at <= args[0]) rows.delete(id)
              } else if (/^INSERT INTO portal_cleanup_log/.test(sql)) {
                cleanupLog.push({ objectType: args[1], objectId: args[2], businessId: args[3] })
              }
              return { success: true }
            },
          }
        },
        async all() {
          return { results: [] }
        },
        async run() {
          return { success: true }
        },
      }
    },
  }
}

// Fake R2 bucket: delete() throws for keys listed in `failing`, like a transient R2 error.
function makeFiles(keys) {
  const objects = new Set(keys)
  const files = {
    objects,
    failing: new Set(),
    async delete(key) {
      if (files.failing.has(key)) throw new Error(`transient R2 failure deleting ${key}`)
      objects.delete(key)
    },
  }
  return files
}

function makeEnv(db, files) {
  return { DB: db, FILES: files }
}

test('BA-055: a failed R2 delete keeps the D1 row so the next sweep retries it', async () => {
  mock.method(console, 'error', () => {})
  try {
    const db = makeDb([
      { id: 'obj-ok', business_id: 'biz_1', r2_object_key: 'business/biz_1/portal/c/objects/obj-ok', expires_at: longExpired },
      { id: 'obj-fail', business_id: 'biz_1', r2_object_key: 'business/biz_1/portal/c/objects/obj-fail', expires_at: longExpired },
    ])
    const files = makeFiles(['business/biz_1/portal/c/objects/obj-ok', 'business/biz_1/portal/c/objects/obj-fail'])
    files.failing.add('business/biz_1/portal/c/objects/obj-fail')
    const env = makeEnv(db, files)

    const first = await runClientPortalCleanup(env)
    assert.equal(first.deletedFileObjects, 1, 'only the object whose R2 delete succeeded is counted')
    assert.deepEqual([...db.rows.keys()], ['obj-fail'], 'the row for the failed R2 delete must survive')
    assert.ok(files.objects.has('business/biz_1/portal/c/objects/obj-fail'), 'the bytes are still in R2')
    assert.deepEqual(db.cleanupLog.map(entry => entry.objectId), ['obj-ok'])

    // Transient error clears; the next sweep must find the surviving row and finish the job.
    files.failing.clear()
    const second = await runClientPortalCleanup(env)
    assert.equal(second.deletedFileObjects, 1)
    assert.equal(db.rows.size, 0, 'the retried row is removed once R2 confirms the delete')
    assert.equal(files.objects.size, 0, 'no R2 bytes are orphaned')
    assert.deepEqual(db.cleanupLog.map(entry => entry.objectId), ['obj-ok', 'obj-fail'])
  } finally {
    mock.restoreAll()
  }
})

test('BA-055: a successful R2 delete removes both the R2 object and the D1 row', async () => {
  const db = makeDb([
    { id: 'obj-a', business_id: 'biz_1', r2_object_key: 'k/a', expires_at: longExpired },
    { id: 'obj-b', business_id: 'biz_1', r2_object_key: 'k/b', expires_at: longExpired },
  ])
  const files = makeFiles(['k/a', 'k/b'])
  const result = await runClientPortalCleanup(makeEnv(db, files))
  assert.equal(result.deletedFileObjects, 2)
  assert.equal(db.rows.size, 0)
  assert.equal(files.objects.size, 0)
})
