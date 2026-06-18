-- proxy_requests_hourly_summary was optional Grafana optimization only; dashboards aggregate from proxy_requests.
DROP PROCEDURE IF EXISTS populate_hourly_summary;
DROP TABLE IF EXISTS proxy_requests_hourly_summary;
