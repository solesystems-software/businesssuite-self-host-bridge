<#
.SYNOPSIS
  One-time migration: adds bank-feed/ and payments/ to a repo that already has client-portal/ and
  mobile-sync/ set up (from the original setup-head-remotes.ps1 run). Does not touch
  client-portal/ or mobile-sync/ -- only adds the two new targets. Run once, from the root of this
  repo, then use sync-from-head.ps1 for every sync after that (it now covers all four).
#>

$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\SyncTargets.ps1"

$newTargets = Get-SyncTargets | Where-Object { $_.Label -in @('bank-feed', 'payments') }

# head-client-portal already exists (from the original setup) and is already restricted to just
# export-client-portal -- add the two new branches to that same restriction rather than opening it
# back up to the whole businesssuite repo.
foreach ($target in $newTargets) {
  git remote set-branches --add $target.RemoteName $target.ExportBranch
}

foreach ($target in $newTargets) {
  Sync-TargetSplit -Target $target
}

# No placeholder files to remove here (bank-feed/ and payments/ don't exist yet in this repo at
# all) -- unlike the original setup, which had to clear out README.md placeholders first.
foreach ($target in $newTargets) {
  git subtree add --prefix=$($target.Prefix) $target.RemoteName $target.ExportBranch --squash
}

Write-Host "--- Done. Review the new commits, then: git push ---"
Write-Host "--- From now on, use sync-from-head.ps1 for all four targets. ---"
