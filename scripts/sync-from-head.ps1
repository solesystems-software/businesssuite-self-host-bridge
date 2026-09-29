<#
.SYNOPSIS
  Syncs client-portal/ and mobile-sync/ from the Head repos into this repo via git subtree,
  preserving file history. Run this after merging iteration work into Head, instead of copying
  files by hand.

.NOTES
  One-time setup required first (see setup-head-remotes.ps1 in this same folder) -- this script
  assumes the head-client-portal and head-mobile-sync remotes and their export-* branches already
  exist. Must be run from the root of this repo (businesssuite-self-host-bridge).
#>

$ErrorActionPreference = 'Stop'

function Sync-Subtree {
  param(
    [string]$HeadRepoPath,
    [string]$SubdirInHead,
    [string]$RemoteName,
    [string]$ExportBranch,
    [string]$Prefix
  )

  Write-Host "--- Syncing $Prefix from $HeadRepoPath/$SubdirInHead ---"

  # Re-split in the Head repo: produces/updates a branch whose history is just that subdirectory,
  # rewritten so its files sit at the branch root. Safe to re-run -- it recomputes from the Head
  # repo's current HEAD each time.
  Push-Location $HeadRepoPath
  $splitCommit = git subtree split --prefix=$SubdirInHead -b "$ExportBranch-tmp" 2>&1 | Select-Object -Last 1
  git branch -f $ExportBranch "$ExportBranch-tmp"
  git branch -D "$ExportBranch-tmp"
  Pop-Location

  # Pull that branch into this repo's prefix. --squash keeps this repo's own history from
  # ballooning with every commit ever made to the Head subdirectory; drop --squash if you want
  # full history carried over instead.
  git fetch $RemoteName $ExportBranch
  git subtree pull --prefix=$Prefix $RemoteName $ExportBranch --squash -m "Sync $Prefix from Head"
}

Sync-Subtree -HeadRepoPath "D:\Sole\Business Suite\development\businesssuite" `
  -SubdirInHead "cloudflare-client-portal" -RemoteName "head-client-portal" `
  -ExportBranch "export-client-portal" -Prefix "client-portal"

Sync-Subtree -HeadRepoPath "D:\Sole\Business Suite\development\businesssuite-mobile" `
  -SubdirInHead "cloudflare-mobile-sync" -RemoteName "head-mobile-sync" `
  -ExportBranch "export-mobile-sync" -Prefix "mobile-sync"

Write-Host "--- Done. Review the two new commits, then: git push ---"
