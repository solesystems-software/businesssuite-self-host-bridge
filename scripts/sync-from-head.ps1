<#
.SYNOPSIS
  Syncs all four Worker targets (client-portal, bank-feed, payments, mobile-sync) from the Head
  repos into this repo via git subtree, preserving file history. It does NOT push; push by hand. Run this
  after merging iteration work into Head -- wired up as a SourceTree Custom Action (Repository
  menu > Custom Actions... in this repo, or Tools > Options > Custom Actions for all repos):
  Script to run `powershell.exe`, Parameters
  `-ExecutionPolicy Bypass -File "$REPO_DIR$\scripts\sync-from-head.ps1"`.

.NOTES
  Requires the one-time setup first: setup-head-remotes.ps1 for a fresh clone of this repo, or
  (if you already have client-portal/ and mobile-sync/ set up from before bank-feed and payments
  existed) add-bank-feed-and-payments.ps1 once to bring those two targets in.
#>

param([switch]$Full)   # -Full: stock git-subtree, whole Head history, no cache (fallback only; see SyncTargets.ps1)

$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\SyncTargets.ps1"

# Check everything that could fail late BEFORE any history is walked (a dirty tree here used to be found only after
# minutes of splitting).
Test-SyncPreflight -Targets (Get-SyncTargets)

foreach ($target in Get-SyncTargets) {
  Sync-TargetSplit -Target $target -Full:$Full
  Assert-CleanWorkingTree
  git subtree pull --prefix=$($target.Prefix) $target.RemoteName $target.ExportBranch --squash -m "Sync $($target.Prefix) from Head"
}

$ahead = git rev-list --count '@{u}..HEAD' 2>$null
if ($LASTEXITCODE -eq 0 -and [int]$ahead -gt 0) {
  Write-Host "--- $ahead commit(s) ready to push. Not pushed automatically: review, then run 'git push' yourself. ---"
} else {
  Write-Host "--- Nothing new to push (all four targets already up to date) ---"
}

Write-Host "--- Done. ---"
