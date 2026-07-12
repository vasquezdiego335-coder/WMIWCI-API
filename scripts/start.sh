#!/bin/sh
# Railway combined start: Next.js admin (port 3000) + worker-host (port 8080).
# Next.js binds to $PORT (Railway injects it); the worker-host uses 8080
# internally (health only — Railway routes external traffic to $PORT).

# Run Next.js in the background
PORT=${PORT:-3000} node_modules/.bin/next start -p ${PORT:-3000} &
NEXT_PID=$!

# Run workers in the foreground (so Railway sees its logs + exit code)
PORT=8080 node --import tsx src/worker-host.ts &
WORKER_PID=$!

# If either process dies, kill the other and exit
trap "kill $NEXT_PID $WORKER_PID 2>/dev/null; exit 1" INT TERM

wait -n 2>/dev/null || true
kill $NEXT_PID $WORKER_PID 2>/dev/null
exit 1
