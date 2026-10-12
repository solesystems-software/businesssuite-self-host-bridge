// The embed / hosted-payment page is one big template literal containing an inline <script>. A stray escape inside
// it (a bare \/ becomes /) turns the script into a syntax error that silently kills ALL of it: no amount, no mock
// buttons, no Stripe card fields. HTTP-level tests never saw that, so this parses the emitted script.
//
// Run: node --experimental-strip-types --test test/pay-embed-page.test.mjs   (npm run test:page)
import assert from 'node:assert/strict'
import test from 'node:test'
import { renderPayEmbedHtml } from '../src/payEmbedPage.ts'

const html = renderPayEmbedHtml()
const inlineScripts = [...html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(match => match[1])

test('the page has exactly one inline script and it parses', () => {
  assert.equal(inlineScripts.length, 1)
  assert.doesNotThrow(() => new Function(inlineScripts[0]), 'the emitted inline script must be valid JavaScript')
})

test('the hosted-link path regex survives the template literal', () => {
  assert.ok(inlineScripts[0].includes(String.raw`location.pathname.match(/^\/pay\/([a-f0-9]{64})$/)`))
})

test('it still loads Stripe.js and has the mock and real sections', () => {
  assert.match(html, /<script src="https:\/\/js\.stripe\.com\/v3\/">/)
  assert.match(html, /id="pay-mock"/)
  assert.match(html, /id="payment-element"/)
})
