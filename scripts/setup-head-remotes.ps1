<#
.SYNOPSIS
  One-time setup for a FRESH clone of this repo: adds the two Head repos as local (fetch-only,
  restricted-branch) remotes and does the first git subtree add for all four targets
  (client-portal, bank-feed, payments, mobile-sync). Run this once, from the root of this repo,
  before ever running sync-from-head.ps1. Safe to re-run if a step fails partway -- 'remote add'
  will just error on an already-existing remote, which you can ignore.

.NOTES
  If you already ran an earlier version of this script (client-portal + mobile-sync only, before
  bank-feed and payments existed), do NOT re-run this one -- use add-bank-feed-and-payments.ps1
  instead, which adds only the two new targets without re-touching what's already there.
#>

$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\SyncTargets.ps1"

$targets = Get-SyncTargets
$remotes = $targets | Select-Object -ExpandProperty RemoteName -Unique
foreach ($remoteName in $remotes) {
  $repoPath = ($targets | Where-Object { $_.RemoteName -eq $remoteName } | Select-Object -First 1).HeadRepoPath
  git remote add $remoteName $repoPath

  # Restrict each remote's fetch refspec to ONLY its targets' export branches -- without this,
  # git's default fetch refspec pulls every branch (including main), so a plain 'Fetch' in
  # SourceTree (or 'git fetch <remote>' with no branch arg) silently drags in Head's entire
  # history alongside the filtered one. That history would sit in the local repo (never pushed,
  # since main's own ancestry is untouched) but is a landmine for an accidental future push of the
  # wrong branch.
  foreach ($target in ($targets | Where-Object { $_.RemoteName -eq $remoteName })) {
    git remote set-branches --add $remoteName $target.ExportBranch
  }
}

foreach ($target in $targets) {
  Sync-TargetSplit -Target $target
}

# Remove the placeholder directories entirely (not just a README.md inside them) -- git subtree
# add refuses to target a prefix that already exists on disk, even an empty one.
$prefixes = $targets | Select-Object -ExpandProperty Prefix
Remove-Item -Recurse -Force $prefixes -ErrorAction SilentlyContinue
git add -A
git commit -m "Remove placeholder READMEs before first Head sync" --allow-empty

foreach ($target in $targets) {
  Assert-CleanWorkingTree
  git subtree add --prefix=$($target.Prefix) $target.RemoteName $target.ExportBranch --squash
}

Write-Host "--- Setup done. Review the new commits, then: git push ---"
Write-Host "--- From now on, use sync-from-head.ps1 instead of this script. ---"
