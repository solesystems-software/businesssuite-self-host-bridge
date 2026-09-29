import type { Env } from './clientPortalWorkerTypes'

// Cloudflare_Self_Hosting_Implementation_Task_Spec_20260928.md Wave 2A: replaces the same-account
// LICENSE_SERVICE [[services]] binding (which cannot resolve to a Worker in a customer's own
// Cloudflare account -- self-hosting-design.md's "Client Portal -- one coupling to remove" section)
// with a plain HTTPS call to the centrally hosted licensing Worker's public,
// license-key-authenticated POST /check-client-portal-access route (Wave 1A,
// cloudflare/src/licenseRoutes.ts's handleCheckClientPortalAccess). No shared secret ships in this
// (cloneable) repo at all -- the Business's own license key is the trust boundary, mirroring how the
// desktop app itself authenticates to licensing.
//
// Request/response handling mirrors src/main/services/system/licenseProviders/httpLicenseProvider.ts:
// POST JSON, parse the response defensively, treat `!response.ok || parsed.ok !== true` as failure.

export type ClientPortalAccessResponse = {
  entitlementCode: 'client_portal'
  status: 'active' | 'not_entitled' | 'unavailable'
  entitled: boolean
  message: string
}

export type ClientPortalLicensingCheckResult = {
  ok: boolean
  message: string
  clientPortalAccess?: ClientPortalAccessResponse
}

function joinUrl(baseUrl: string, path: string) {
  return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`
}

// Low-level HTTP call to the licensing Worker's /check-client-portal-access route. Exported
// separately from checkPublishEntitlement so tests can exercise the HTTP/parsing behavior directly.
export async function checkClientPortalAccessRemote(
  licensingServiceUrl: string,
  licenseKey: string,
): Promise<ClientPortalLicensingCheckResult> {
  const url = joinUrl(licensingServiceUrl, '/check-client-portal-access')

  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ licenseKey }),
    })
  } catch (error) {
    return {
      ok: false,
      message: `Could not reach the licensing service: ${error instanceof Error ? error.message : 'network error'}.`,
    }
  }

  const responseText = await response.text()
  let parsed: ClientPortalLicensingCheckResult

  try {
    parsed = responseText ? (JSON.parse(responseText) as ClientPortalLicensingCheckResult) : {
      ok: false,
      message: `Licensing service returned HTTP ${response.status} without a response body.`,
    }
  } catch {
    parsed = {
      ok: false,
      message: `Licensing service returned HTTP ${response.status} without a valid JSON response.`,
    }
  }

  if (!response.ok || parsed.ok !== true) {
    return {
      ok: false,
      message: parsed.message || `Licensing service returned HTTP ${response.status}.`,
    }
  }

  return parsed
}

// Publish-time entitlement gate for businessRoutes.ts's handlePublishSnapshot -- the design doc's
// resolution for the removed LICENSE_SERVICE binding: check access before a publish is allowed, using
// the Business's own license key (entered once during setup), never a same-account service binding
// or a shared secret shipped inside the cloned repo. Kept minimal and scoped to exactly this one
// enforcement point, per the task spec -- not a broader gate on every route.
export async function checkPublishEntitlement(env: Env): Promise<{ entitled: boolean; message: string }> {
  const licenseKey = (env.CLIENT_PORTAL_LICENSE_KEY || '').trim()

  if (!licenseKey) {
    if (env.SERVICE_ENVIRONMENT === 'development') {
      // No license key has been entered yet in this development sandbox -- the setup screen that
      // lets a customer paste one in is Wave 4, not built yet. Fail open only here, mirroring this
      // Worker's existing "not enforced yet" precedent for the old LICENSE_SERVICE binding, so this
      // task's real enforcement does not break existing dev/test publish flows that have never had a
      // license key to supply. Any environment other than development, or any development deployment
      // that does have a key configured, is checked for real below.
      return { entitled: true, message: 'No Client Portal license key is configured (development sandbox).' }
    }
    return {
      entitled: false,
      message: 'Client Portal is not licensed: no license key is configured for this Worker.',
    }
  }

  const licensingServiceUrl = (env.LICENSING_SERVICE_URL || '').trim()
  if (!licensingServiceUrl) {
    return {
      entitled: false,
      message: 'Client Portal licensing check is unavailable: LICENSING_SERVICE_URL is not configured.',
    }
  }

  const result = await checkClientPortalAccessRemote(licensingServiceUrl, licenseKey)
  if (!result.ok || !result.clientPortalAccess?.entitled) {
    return {
      entitled: false,
      message: result.clientPortalAccess?.message || result.message || 'Client Portal access could not be verified.',
    }
  }

  return { entitled: true, message: result.clientPortalAccess.message }
}
