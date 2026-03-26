# Operational Runbooks for Conductor OSS

This document provides procedures for common operational issues in remote deployments.

## Table of Contents

1. [Session Management](#session-management)
2. [Database Recovery](#database-recovery)
3. [Monitoring & Alerting](#monitoring--alerting)
4. [Troubleshooting](#troubleshooting)

---

## Session Management

### Detecting Stuck Sessions

**Symptoms:**
- Session status in UI remains "Working" for >1 hour
- No new activity in terminal for extended period
- Process no longer responding to input

**Detection via API:**
```bash
# Check session health via API
curl http://localhost:4748/api/health/sessions | jq '.summary'

# Look for sessions with "critical" health
curl http://localhost:4748/api/health/sessions | jq '.metrics[] | select(.health=="critical")'
```

**Prometheus Metric:**
```
conductor_sessions_stuck  # Will be >0 if sessions are stuck
```

### Recovering a Stuck Session

**Option 1: Graceful Termination (Recommended)**
```bash
# Via API
curl -X POST http://localhost:4748/api/sessions/{session-id}/kill

# Via CLI
conductor kill {session-id}
```

**Option 2: Force Kill (Last Resort)**
```bash
# Find process ID
ps aux | grep ttyd | grep {session-id}

# Kill process
kill -9 {pid}

# Mark session as terminated in UI and archive
curl -X POST http://localhost:4748/api/sessions/{session-id}/archive
```

**Option 3: Worktree Cleanup**
```bash
# If session's worktree is orphaned
cd ~/.conductor/worktrees
ls -la {session-id}/  # Verify session directory

# Remove worktree
git worktree remove {session-id} --force

# Restart Conductor to detect cleanup
pkill conductor
conductor start
```

---

## Database Recovery

### Detecting Database Issues

**Symptoms:**
- Server won't start: "database locked" error
- Sessions list shows stale data
- New sessions fail to create

**Check Database Health:**
```bash
# Check if .conductor/conductor.db exists
ls -lh ~/.conductor/conductor.db

# Verify file integrity
sqlite3 ~/.conductor/conductor.db "PRAGMA integrity_check;"
```

### WAL Mode Recovery

Conductor uses Write-Ahead Logging (WAL) for concurrency. If WAL files become corrupted:

```bash
# Stop Conductor
pkill conductor

# Check for WAL files
ls -la ~/.conductor/conductor.db-*

# Disable WAL temporarily
sqlite3 ~/.conductor/conductor.db "PRAGMA journal_mode=DELETE;"

# Run integrity check
sqlite3 ~/.conductor/conductor.db "PRAGMA integrity_check;"

# Re-enable WAL
sqlite3 ~/.conductor/conductor.db "PRAGMA journal_mode=WAL;"

# Restart Conductor
conductor start
```

### Full Database Backup & Recovery

**Backup:**
```bash
# Create backup of current database
mkdir -p ~/.conductor/backups
cp ~/.conductor/conductor.db ~/.conductor/backups/conductor.db.$(date +%s).backup

# Archive backup
tar czf conductor-db-backup-$(date +%Y%m%d).tar.gz ~/.conductor/backups/
```

**Recovery from Backup:**
```bash
# Stop Conductor
pkill conductor

# Restore from backup
cp ~/.conductor/backups/conductor.db.{timestamp}.backup ~/.conductor/conductor.db

# Verify integrity
sqlite3 ~/.conductor/conductor.db "PRAGMA integrity_check;"

# Restart Conductor
conductor start
```

---

## Monitoring & Alerting

### Prometheus Metrics

The `/metrics` endpoint exports metrics in Prometheus format. Add to your Prometheus config:

```yaml
scrape_configs:
  - job_name: 'conductor'
    static_configs:
      - targets: ['localhost:4748']
    metrics_path: '/metrics'
    scrape_interval: 30s
```

### Key Metrics to Monitor

| Metric | Alert When | Action |
|--------|-----------|--------|
| `conductor_sessions_stuck` | > 0 | See Session Recovery section |
| `conductor_sessions_errored` | > 5 | Check error logs, investigate spawn failures |
| `conductor_sessions_queued` | > 20 | Dispatcher may be overloaded or stuck |
| `conductor_uptime_seconds` | Resets | Server restarted unexpectedly, check logs |

### Health Check Endpoint

Simple HTTP 200/5xx health checks:

```bash
# Basic health
curl -s http://localhost:4748/api/health | jq '.status'

# Session health summary
curl -s http://localhost:4748/api/health/sessions | jq '.summary'
```

### Error Tracking

Future: Check `/api/errors/health` for aggregated error information once fully integrated.

---

## Troubleshooting

### Issue: "Session spawn timeout"

**Diagnosis:**
```bash
# Check if agent CLI is available
which claude-code    # For Claude Code agent
which cursor         # For Cursor agent

# Verify agent can run
claude-code --version

# Check system resources
free -h              # Memory available
df -h /tmp           # Temp space for worktrees
```

**Solution:**
- Ensure agent binary is in PATH
- Verify system has >2GB free disk space
- Check if other sessions are consuming resources

### Issue: "Terminal connection lost"

**Diagnosis:**
```bash
# Check if ttyd process is running
ps aux | grep ttyd | grep -v grep

# Check server logs
journalctl -u conductor -f
# or if running in foreground:
# RUST_LOG=debug conductor start
```

**Solution:**
- Restart Conductor: `pkill conductor && conductor start`
- Check firewall rules if accessing remotely
- Verify reverse proxy is configured correctly (if behind Nginx/Caddy)

### Issue: "Webhook sync fails"

**Diagnosis:**
```bash
# Verify webhook secret is set
grep webhook_secret ~/.conductor/conductor.yaml

# Check GitHub webhook delivery logs
# In GitHub repo settings > Webhooks > Recent Deliveries

# Verify signature verification
# Check server logs for "Invalid GitHub webhook signature"
```

**Solution:**
- Ensure `CONDUCTOR_GITHUB_WEBHOOK_SECRET` env var matches GitHub webhook secret
- Verify webhook URL is accessible from GitHub (no firewalls blocking)
- Check that GitHub integration is enabled in conductor.yaml

### Issue: "Board sync fails"

**Diagnosis:**
```bash
# Check if CONDUCTOR.md file exists
ls -la ~/.conductor/CONDUCTOR.md
# or in project directory
ls -la {project-path}/CONDUCTOR.md

# Verify file is valid Markdown with Obsidian kanban format
head -50 CONDUCTOR.md
```

**Solution:**
- Ensure CONDUCTOR.md exists and is readable
- Check that board uses Obsidian kanban plugin format (see CONDUCTOR.md)
- Restart watcher: `pkill conductor && conductor start`

---

## Best Practices for Remote Deployments

1. **Regular Backups**
   ```bash
   # Daily backup of .conductor/ directory
   0 2 * * * cp -r ~/.conductor ~/.conductor.backup.$(date +\%Y\%m\%d)
   ```

2. **Monitor Key Metrics**
   - Set up Prometheus + Grafana for dashboard
   - Alert on stuck/errored session counts
   - Track spawn success rate

3. **Log Aggregation**
   - Forward JSON logs to ELK or Datadog
   - Set up alerts for "critical" severity errors
   - Retain logs for 30+ days for debugging

4. **Session Lifecycle Limits**
   - Set reasonable max session durations (e.g., 24 hours)
   - Configure auto-cleanup for old sessions
   - Review zombie processes daily

5. **Secrets Management**
   - Use environment variables for all secrets (never hardcode)
   - Rotate GitHub webhook secrets quarterly
   - Keep bridge tokens out of version control

---

## Support & Escalation

If these runbooks don't resolve the issue:

1. Check `/api/errors/health` for error aggregation
2. Review server logs with `RUST_LOG=debug`
3. Collect diagnostic bundle:
   ```bash
   tar czf conductor-diagnostics.tar.gz \
     ~/.conductor/conductor.db \
     /tmp/*conductor*.log \
     ~/.conductor/.conductor/workspaces.json
   ```
4. Report issue with diagnostic bundle

---

**Last Updated:** March 26, 2026  
**Version:** 1.0  
**Status:** Ready for Remote Deployments
