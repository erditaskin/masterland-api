#!/usr/bin/env bash
# Dedicated Masterland database only. Never runs against or copies a Soruders database.
set -euo pipefail
umask 077
root=/opt/masterland/backups
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$root"
docker exec masterland-postgres pg_dump -U masterland_admin -d masterland_prod -Fc > "$root/masterland-$stamp.dump"
test -s "$root/masterland-$stamp.dump"
docker exec -i masterland-postgres pg_restore --list < "$root/masterland-$stamp.dump" > "$root/masterland-$stamp.list"
sha256sum "$root/masterland-$stamp.dump" > "$root/masterland-$stamp.sha256"
# Retention is deliberately not automatic during the prelaunch transition.
