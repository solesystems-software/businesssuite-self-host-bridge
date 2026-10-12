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

# Git for Windows' own sh.exe (the persistent-cache git-subtree runs under it).
function Get-GitSh {
  $git = (Get-Command git -ErrorAction Stop).Source          # ...\Git\cmd\git.exe
  Join-Path (Split-Path (Split-Path $git)) 'bin\sh.exe'
}

# Everything that could make a run fail LATE is checked here, before any history is walked, so a run never spends
# minutes splitting and then dies on something that was knowable at the start. Collects every problem, reports
# them together, and throws once.
#
# Working trees: only THIS repo's tree must be clean (git subtree pull refuses otherwise). The Head repos are only
# read by the split, so uncommitted work there is fine, and nothing is committed to them any more.
function Test-SyncPreflight {
  param([object[]]$Targets, [string]$BridgeRepo = (Get-Location).Path)
  $problems = @()

  # 1. This repo's working tree (the CRLF refresh is the same false-positive clearing Assert-CleanWorkingTree does).
  git -C $BridgeRepo update-index -q --refresh | Out-Null
  $dirty = git -C $BridgeRepo status --porcelain
  if ($dirty) {
    $problems += "This repo has uncommitted changes (git subtree pull refuses to run on a dirty tree). Commit or stash them first:`n    " + (($dirty | Select-Object -First 15) -join "`n    ")
  }
  $branch = git -C $BridgeRepo rev-parse --abbrev-ref HEAD
  if ($branch -ne 'main') { $problems += "This repo has '$branch' checked out, not 'main'." }

  # 2. Tools.
  if (-not (Test-Path (Get-GitSh))) { $problems += "Git for Windows sh.exe not found at $(Get-GitSh)." }
  foreach ($f in 'git-subtree-persistent', 'subtree-persistent.sh') {
    if (-not (Test-Path (Join-Path $PSScriptRoot $f))) { $problems += "Missing scripts\$f." }
  }

  # 3. Each Head repo and remote.
  $remotes = git -C $BridgeRepo remote
  foreach ($path in ($Targets | ForEach-Object { $_.HeadRepoPath } | Select-Object -Unique)) {
    if (-not (Test-Path (Join-Path $path '.git'))) { $problems += "Head repo not found: $path"; continue }
    if (-not (git -C $path rev-parse --verify -q refs/heads/main)) { $problems += "$path has no 'main' branch." }
    $headBranch = git -C $path rev-parse --abbrev-ref HEAD
    if ($headBranch -like 'export-*') { $problems += "$path has the export branch '$headBranch' checked out; the sync moves export branches, so switch it to 'main' first." }
  }
  foreach ($t in $Targets) {
    if ($remotes -notcontains $t.RemoteName) { $problems += "Remote '$($t.RemoteName)' is not configured in this repo (run the setup script)." }
  }

  if ($problems) {
    Write-Host '--- Preflight failed. Nothing was walked or changed: ---' -ForegroundColor Red
    $problems | ForEach-Object { Write-Host "  * $_" }
    throw 'Fix the items above, then re-run.'
  }
  Write-Host '--- Preflight OK (this repo clean, Head repos and remotes found) ---'
}

# Re-splits one target's Head subdirectory into its export branch and fetches it into this repo.
# Shared by first-time setup and every later sync -- the split/fetch step is identical in both
# cases, only the subtree command (add vs. pull) differs.
#
# Default: the persistent-cache split (scripts\git-subtree-persistent). Its commit-to-commit cache survives between
# runs (in <Head>\.git\subtree-cache-persistent\<dir>) and each run only processes commits newer than the last
# complete run, so cost tracks the new work and it can't recurse into old uncached history (which is what hung the
# stock incremental split once Head merged new iteration commits). The first run on a machine is a full walk
# (about 10 minutes per Head target); later runs take seconds to a minute. Makes no commit in Head.
#
# -Full: the stock git-subtree, full history walk every time (--ignore-joins), no cache. Slow and stateless; a
# fallback only, e.g. if the persistent cache is ever suspect. (Deleting <Head>\.git\subtree-cache-persistent
# resets the cache instead; also always safe.)
function Sync-TargetSplit {
  param([hashtable]$Target, [switch]$Full)
  Write-Host "--- Splitting $($Target.Label) from $($Target.HeadRepoPath)\$($Target.SubdirInHead)$(if ($Full) { ' (full history walk, no cache)' }) ---"
  Push-Location $Target.HeadRepoPath
  try {
    if ($Full) {
      $out = & git subtree split --prefix=$($Target.SubdirInHead) --ignore-joins main
    } else {
      $wrapper = ($PSScriptRoot -replace '\\', '/') + '/subtree-persistent.sh'
      $out = & (Get-GitSh) $wrapper split --prefix=$($Target.SubdirInHead) --ignore-joins main
    }
    if ($LASTEXITCODE -ne 0) { throw "git subtree split failed for $($Target.Label) (exit $LASTEXITCODE)." }
    $sha = $out | Where-Object { $_ -match '^[0-9a-f]{40}$' } | Select-Object -Last 1
    if (-not $sha) { throw "git subtree split for $($Target.Label) did not print a commit id." }
    git update-ref -m 'subtree split' "refs/heads/$($Target.ExportBranch)" $sha
    if ($LASTEXITCODE -ne 0) { throw "Could not update branch $($Target.ExportBranch)." }
  } finally {
    Pop-Location
  }
  git fetch $Target.RemoteName $Target.ExportBranch
}

# git subtree add/pull both require a genuinely clean working tree and refuse to run otherwise
# ("fatal: working tree has modifications. Cannot add."). On Windows, right after a fetch, the
# index can transiently disagree with the checked-out files purely from CRLF line-ending
# normalization (core.autocrlf) before anything has actually touched them -- 'git status' alone
# doesn't always catch this, but subtree's own clean-check does, and fails the whole operation.
# 'update-index --refresh' re-stats the index against the working tree and clears that false
# positive; if the tree is still dirty after that, it's a real uncommitted change and this reports
# it plainly instead of letting subtree's own less-informative error through.
function Assert-CleanWorkingTree {
  git update-index -q --refresh | Out-Null
  $dirty = git status --porcelain
  if ($dirty) {
    Write-Host "--- Working tree is not clean, cannot run git subtree: ---"
    Write-Host $dirty
    throw "Working tree has real uncommitted changes -- commit or discard them, then re-run this script."
  }
}
