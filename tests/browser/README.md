# Dashboard browser smoke

Run from this directory with Node.js 20+ and Python 3.10+:

```sh
npm ci
npx playwright install --with-deps chromium
npm test
```

The suite uses Chromium to open and click the real dashboard served by its Python
HTTP handler. Each test gets a temporary checkout and an OS-assigned loopback
port. Language persistence and HTTP handling stay real. Host status/action calls
are replaced, so no service, runtime loop or paid CLI starts and no user state is
read or written. The simulated status is stopped on every operating system.
External font requests are blocked.

The five checks cover rendering and refresh controls, saved language after a
reload, current versus next-product language, language/action failure feedback,
and recovery after a failed status request. A write error and one HTTP 503 are
deliberately injected; other requests use the real server.

Python defaults to `python` on Windows and `python3` elsewhere. Set
`AUTO_COMPANY_BROWSER_PYTHON` to an executable path if needed. Tests run serially
without automatic retries. Failures retain screenshots, traces and server logs
under `test-results/`; the HTML report is in `playwright-report/`. CI should upload
both directories on failure.
