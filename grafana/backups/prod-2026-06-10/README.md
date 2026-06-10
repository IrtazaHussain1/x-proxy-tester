# Prod Grafana dashboard backup — 2026-06-10

Raw export of all 41 dashboards from the prod Grafana
(http://65.21.254.9:3312) as the dashboard JSON model, organised by
prod folder. Captured before the prod-sync + server-label-regex changes.

## Rollback (re-import a single dashboard)

    curl -s -H "Authorization: Bearer <token>" \
      -H "Content-Type: application/json" \
      -d "{\"dashboard\": $(cat '<folder>/<file>.json'), \"overwrite\": true}" \
      http://65.21.254.9:3312/api/dashboards/db

`_folders.json` / `_search.json` capture the folder structure and
uid→title→folder mapping at export time.
