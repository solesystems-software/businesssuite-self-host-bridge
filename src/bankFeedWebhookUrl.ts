export function getBankFeedPlaidWebhookUrl(request: Request) {
  const requestUrl = new URL(request.url)
  return new URL('/plaid/webhooks', requestUrl.origin).toString()
}
