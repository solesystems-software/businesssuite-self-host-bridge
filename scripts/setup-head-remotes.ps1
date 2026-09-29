<#
.SYNOPSIS
  One-time setup: adds the two Head repos as local (fetch-only) remotes and does the first
  git subtree add for client-portal/ and mobile-sync/. Run this once, from the root of this repo,
  before ever running sync-from-head.ps1. Safe to re-run if a step fails partway -- 'remote add'
  will just error on an already-existing remote, which you can ignore.
#>

$ErrorActionPreference = 'Stop'

git remote add head-client-portal "D:\Sole\Business Suite\development\businesssuite"
git remote add head-mobile-sync "D:\Sole\Business Suite\development\businesssuite-mobile"

# First split, same as sync-from-head.ps1 does on every subsequent run.
Push-Location "D:\Sole\Business Suite\development\businesssuite"
git subtree split --prefix=cloudflare-client-portal -b export-client-portal
Pop-Location

Push-Location "D:\Sole\Business Suite\development\businesssuite-mobile"
git subtree split --prefix=cloudflare-mobile-sync -b export-mobile-sync
Pop-Location

git fetch head-client-portal export-client-portal
git fetch head-mobile-sync export-mobile-sync

# Remove the placeholder README.md files before the subtree add, or they'll sit alongside the
# real content instead of being replaced by it.
Remove-Item client-portal\README.md, mobile-sync\README.md -ErrorAction SilentlyContinue
git add -A
git commit -m "Remove placeholder READMEs before first Head sync" --allow-empty

git subtree add --prefix=client-portal head-client-portal export-client-portal --squash
git subtree add --prefix=mobile-sync head-mobile-sync export-mobile-sync --squash

Write-Host "--- Setup done. Review the new commits, then: git push ---"
Write-Host "--- From now on, use sync-from-head.ps1 instead of this script. ---"
