# businesssuite-self-host-bridge

Public repository a self-hosting customer's Deploy-to-Cloudflare button or installer script
deploys from. Contains only the cloneable subset of Sole Business Suite's Cloudflare
infrastructure: no licensing code, no bank-feed code, no secrets, no Stripe integration.

## Structure

```
client-portal/   Client Portal Worker (synced from businesssuite/cloudflare-client-portal/)
mobile-sync/     Mobile Sync Worker   (synced from businesssuite-mobile/cloudflare-mobile-sync/)
```

Each subdirectory is a fully isolated Worker project with its own `wrangler.toml`, required so
each can work as its own Deploy-to-Cloudflare button target.

## Source of truth

This repo is kept in sync from the Head repos, never from the agentic iteration clones:

- `client-portal/` <- `businesssuite/cloudflare-client-portal/`
- `mobile-sync/`   <- `businesssuite-mobile/cloudflare-mobile-sync/`

A change made in `businesssuite_iteration/cloudflare-client-portal/` or
`businesssuite-mobile_iteration/cloudflare-mobile-sync/` only reaches self-hosting customers once
it has gone through the normal review path into Head, and is then synced into this repo from
there. This repo is never pushed to directly from iteration work, and never pulls from it.

See `docs/cloudflare-self-hosting-design.md` and
`docs/Development Tasks/Cloudflare_Self_Hosting_Implementation_Task_Spec_20260928.md` in
`businesssuite_iteration` for the full design and implementation history.
