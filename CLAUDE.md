# Harness project

## Starting the dev server

**Always use `Bash` with `run_in_background: true` to start the harness.** Never use TaskCreate — it kills long-running processes.

```
command: npm run dev
cwd: <path-to>/fortisoar-widget-harness
run_in_background: true
```

Before starting, check if it is already running:
```
curl -s http://localhost:4401/ > /dev/null && echo "already running"
```

The harness listens on **port 4401** (set via `.env`). Always use `http://localhost:4401` — never 3000 or 4400.
