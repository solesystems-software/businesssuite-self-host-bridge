#!/bin/sh
# Runs the persistent-cache variant of git-subtree (git-subtree-persistent, in this folder) as if it were `git subtree`.
# It needs GIT_EXEC_PATH and PATH set the way git itself would set them; under Git for Windows they must be in
# POSIX form (cygpath -u), because a "C:" drive prefix breaks PATH splitting inside sh.
GIT_EXEC_PATH="$(cygpath -u "$(git --exec-path)")"
export GIT_EXEC_PATH
PATH="$GIT_EXEC_PATH:$PATH"
export PATH
exec sh "$(dirname "$0")/git-subtree-persistent" "$@"
