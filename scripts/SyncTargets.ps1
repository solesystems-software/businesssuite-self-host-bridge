<#
.SYNOPSIS
  The single source of truth for which Head subdirectories sync into this repo. Dot-sourced by
  setup-head-remotes.ps1, add-bank-feed-and-payments.ps1, and sync-from-head.ps1, so there's one
  place to add a fifth Worker later instead of four scripts to keep in sync.

.NOTES
  client-portal, bank-feed, and payments all live in the same Head repo (businesssuite), just
  different subdirectories -- they share one remote (head-client-portal) with three restricted
  branches, rather than three separate remotes. mobile-sync lives in the separate
  businesssuite-mobile repo, so it gets its own remote.
#>

function Get-SyncTargets {
  @(
    @{ Label = 'client-portal'; HeadRepoPath = 'D:\Sole\Business Suite\development\businesssuite'; SubdirInHead = 'cloudflare-client-portal'; RemoteName = 'head-client-portal'; ExportBranch = 'export-client-portal'; Prefix = 'client-portal' }
    @{ Label = 'bank-feed';     HeadRepoPath = 'D:\Sole\Business Suite\development\businesssuite'; SubdirInHead = 'cloudflare-bank-feeds';    RemoteName = 'head-client-portal'; ExportBranch = 'export-bank-feed';     Prefix = 'bank-feed' }
    @{ Label = 'payments';      HeadRepoPath = 'D:\Sole\Business Suite\development\businesssuite'; SubdirInHead = 'cloudflare-payments';      RemoteName = 'head-client-portal'; ExportBranch = 'export-payments';      Prefix = 'payments' }
    @{ Label = 'mobile-sync';   HeadRepoPath = 'D:\Sole\Business Suite\development\businesssuite-mobile'; SubdirInHead = 'cloudflare-mobile-sync'; RemoteName = 'head-mobile-sync'; ExportBranch = 'export-mobile-sync'; Prefix = 'mobile-sync' }
  )
}

# Re-splits one target's Head subdirectory into its export branch (safe to re-run; recomputes from
# Head's current HEAD each time) and fetches it into this repo. Shared by first-time setup and
# every later sync -- the split/fetch step is identical in both cases, only the subtree command
# (add vs. pull) differs.
function Sync-TargetSplit {
  param([hashtable]$Target)
  Write-Host "--- Splitting $($Target.Label) from $($Target.HeadRepoPath)\$($Target.SubdirInHead) ---"
  Push-Location $Target.HeadRepoPath
  git subtree split --prefix=$($Target.SubdirInHead) -b "$($Target.ExportBranch)-tmp" | Out-Null
  git branch -f $Target.ExportBranch "$($Target.ExportBranch)-tmp"
  git branch -D "$($Target.ExportBranch)-tmp" | Out-Null
  Pop-Location
  git fetch $Target.RemoteName $Target.ExportBranch
}
