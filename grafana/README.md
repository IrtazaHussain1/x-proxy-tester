# Grafana Configuration for XProxy Tester

This directory contains pre-configured Grafana dashboards, data sources, and alerting rules for the XProxy Tester application.

## Structure

```
grafana/
├── provisioning/
│   ├── datasources/
│   │   └── mysql.yml          # MySQL data source configuration
│   ├── dashboards/
│   │   └── dashboards.yml     # Dashboard provisioning configuration
│   └── alerting/
│       ├── alerting.yml       # Alerting engine configuration
│       └── rules.yml          # Alert rules
└── dashboards/
    ├── overview-dashboard.json
    ├── stability-dashboard.json
    ├── performance-dashboard.json
    ├── rotation-dashboard.json
    └── error-analysis-dashboard.json
```

## Pre-configured Dashboards

### 1. Overview Dashboard
- **Purpose**: High-level system health and metrics
- **Key Metrics**:
  - Total Active Proxies
  - Stable/Unstable Proxy Counts
  - Success Rate
  - Request Volume
  - Response Time Trends
  - Stability Status Distribution

### 2. Stability Dashboard
- **Purpose**: Detailed stability analysis
- **Key Metrics**:
  - Stability status breakdown
  - Stability trends over time
  - Top unstable proxies
  - Stability by location

### 3. Performance Dashboard
- **Purpose**: Performance metrics and response times
- **Key Metrics**:
  - P50, P95, P99 response times
  - Response time distribution
  - Requests per minute
  - Top slow proxies

### 4. Rotation Dashboard
- **Purpose**: IP rotation analysis
- **Key Metrics**:
  - Rotation status distribution
  - Rotation events over time
  - Proxies with rotation issues
  - Same IP count analysis

### 5. Error Analysis Dashboard
- **Purpose**: Error tracking and analysis
- **Key Metrics**:
  - Error rate trends
  - Error type distribution
  - Top failing proxies
  - Error recovery patterns

## Pre-configured Alerts

The following alerts are automatically configured:

1. **Low Success Rate** - Triggers when success rate drops below 90%
2. **High Error Rate** - Triggers when error rate exceeds 10%
3. **No Active Proxies** - Triggers when no active proxies are detected
4. **High Unstable Count** - Triggers when too many proxies are unstable
5. **Slow Response Time** - Triggers when average response time exceeds 3000ms

## Accessing Grafana

1. **Start the services**:
   ```bash
   docker-compose up -d
   ```

2. **Access Grafana**:
   - URL: http://localhost:3312
   - Default username: `admin`
   - Default password: `admin` (change in production!)

3. **Change default password** when first logging in.

## Data Source

The MySQL data source is automatically configured to connect to:
- Host: `mysql:3306` (internal Docker network)
- Database: `xproxy_tester`
- User: `xproxy` (or as configured in your `.env`)

## Customization

### Adding New Dashboards

1. Create a new JSON file in `grafana/dashboards/`
2. Use Grafana's UI to create the dashboard
3. Export the dashboard JSON
4. Save it to `grafana/dashboards/`
5. Restart the Grafana container to load the new dashboard

### Modifying Alert Rules

Edit `grafana/provisioning/alerting/rules.yml` to add or modify alert rules. The file uses Grafana's alerting rule format.

### Notification Channels

Configure notification channels in Grafana UI:
1. Go to **Alerting** → **Notification channels**
2. Add channels (Email, Slack, Webhook, etc.)
3. Assign channels to alert rules

## SQL Views

The application includes optimized SQL views for better query performance. These are automatically created when the MySQL container starts:

- `v_proxy_summary` - Current proxy status with metrics
- `v_hourly_aggregates` - Hourly aggregated data
- `v_system_hourly_stats` - System-wide hourly statistics
- `v_stability_summary` - Stability status breakdown

These views are defined in `grafana-views.sql` at the project root.

## Troubleshooting

### Dashboards Not Appearing

1. Check Grafana logs: `docker-compose logs grafana`
2. Verify dashboard files are in `grafana/dashboards/`
3. Check provisioning configuration in `grafana/provisioning/dashboards/dashboards.yml`
4. Restart Grafana: `docker-compose restart grafana`

### Data Source Connection Issues

1. Verify MySQL is running: `docker-compose ps mysql`
2. Check MySQL logs: `docker-compose logs mysql`
3. Verify data source configuration in `grafana/provisioning/datasources/mysql.yml`
4. Test connection in Grafana UI: **Configuration** → **Data Sources** → **Test**

### Alerts Not Firing

1. Check alert rules in Grafana UI: **Alerting** → **Alert rules**
2. Verify data source is accessible
3. Check alert evaluation logs in Grafana
4. Ensure notification channels are configured

## Production Recommendations

1. **Change default credentials**: Update `GRAFANA_ADMIN_USER` and `GRAFANA_ADMIN_PASSWORD` in `.env`
2. **Enable authentication**: Configure LDAP, OAuth, or SAML for production
3. **Set up backups**: Regularly backup Grafana data volume
4. **Configure SSL/TLS**: Use reverse proxy with SSL for production access
5. **Resource limits**: Set appropriate CPU/memory limits in docker-compose.yml
6. **Monitoring**: Monitor Grafana itself using its own metrics endpoint

## Ports

- **MySQL**: 3310
- **Application**: 3311
- **Grafana**: 3312

## Additional Resources

- [Grafana Documentation](https://grafana.com/docs/)
- [Grafana Dashboard Best Practices](https://grafana.com/docs/grafana/latest/best-practices/)
- [Grafana Alerting Guide](https://grafana.com/docs/grafana/latest/alerting/)

