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

# Restrict each remote's fetch refspec to ONLY the filtered export branch -- without this, git's
# default refspec pulls every branch (including main), so a plain 'Fetch' in SourceTree (or
# 'git fetch <remote>' with no branch arg) silently drags in Head's entire history alongside the
# filtered one. That history would sit in the local repo (never pushed, since main's own ancestry
# stays untouched) but is a landmine for an accidental future push of the wrong branch.
git remote set-branches head-client-portal export-client-portal
git remote set-branches head-mobile-sync export-mobile-sync

# First split, same as sync-from-head.ps1 does on every subsequent run.
Push-Location "D:\Sole\Business Suite\development\businesssuite"
git subtree split --prefix=cloudflare-client-portal -b export-client-portal
Pop-Location

Push-Location "D:\Sole\Business Suite\development\businesssuite-mobile"
git subtree split --prefix=cloudflare-mobile-sync -b export-mobile-sync
Pop-Location

git fetch head-client-portal export-client-portal
git fetch head-mobile-sync export-mobile-sync

# Remove the placeholder directories entirely (not just the README.md inside them) -- git subtree
# add refuses to target a prefix that already exists on disk, even an empty one.
Remove-Item -Recurse -Force client-portal, mobile-sync -ErrorAction SilentlyContinue
git add -A
git commit -m "Remove placeholder READMEs before first Head sync" --allow-empty

git subtree add --prefix=client-portal head-client-portal export-client-portal --squash
git subtree add --prefix=mobile-sync head-mobile-sync export-mobile-sync --squash

Write-Host "--- Setup done. Review the new commits, then: git push ---"
Write-Host "--- From now on, use sync-from-head.ps1 instead of this script. ---"
