## agent-browser Sandbox Compatibility

If you get errors about "sandbox", "Operation not permitted", or Chrome failing to launch (e.g. `mac_util.mm` FATAL, `bootstrap_check_in: Permission denied`, `sandbox initialization failed`), it means Chrome cannot start inside the OS-level sandbox. The fix is to launch Chrome as a separate process with `--no-sandbox` and connect agent-browser to it via CDP:

```bash
# Launch Chrome in the background with remote debugging
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless=new \
  --no-sandbox \
  --disable-gpu \
  --remote-debugging-port=9222 \
  --user-data-dir=/tmp/ab-chrome \
  about:blank >/dev/null 2>&1 &
sleep 2

# Use agent-browser with --cdp 9222 for all commands
agent-browser --cdp 9222 open https://example.com
agent-browser --cdp 9222 wait --load networkidle
agent-browser --cdp 9222 snapshot -i

# Clean up when done
kill $(lsof -ti:9222) 2>/dev/null
```

All agent-browser commands work the same way — just add `--cdp 9222` to each one. Network restrictions from the sandbox are still enforced (blocked domains will still be blocked).
