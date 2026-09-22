# route-probe

Loads every page route of a built Next.js project in a real Chromium, three times each, and fails when a
route logs a console error. It never builds anything: build the app first.

## Why a browser, and why three modes

A browser writes a console error for every HTTP response of 400 or more, before any application code
can catch it. A public endpoint that rate-limits a visitor is therefore enough to turn a clean page red,
and no amount of `try`/`catch` in the app prevents it. So each route is loaded once per mode, each time
in a fresh browser context (no storage, no cache, no wallet session):

| mode       | every request that leaves the app's own host                     |
| ---------- | ---------------------------------------------------------------- |
| `up`       | goes through untouched                                           |
| `abort`    | fails at the network level                                       |
| `throttle` | is answered 429 the first time its host is asked, 400 afterwards |

A load fails on any of:

- a console error, or an uncaught exception
- a document status of 400 or more, or a navigation that never reaches network idle
- fewer than 20 characters of body text
- **any request to a third-party host, in any mode.** A request that succeeds today is the console error
  of the day its host is slow. Pages get outside data through the app's own route handlers
  (`packages/nextjs/app/api/hedera/`), which answer 200 with a typed error body when their upstream fails.

After network idle the page is watched for 12 more seconds, long enough to see the first 10-second RPC poll.
The report ends with every third-party host contacted, per route and mode; it must read `none`.

## Run it

From the repository root, after the production build of the app (`yarn build`), the root script
`yarn probe:routes` runs these three commands:

```bash
npm ci --omit=dev --prefix tools/route-probe
npm run browsers --prefix tools/route-probe
node tools/route-probe/src/cli.mjs --serve
```

`--serve` starts `next start` of `packages/nextjs` on the port of `--base-url` (default
`http://localhost:3000`), without any `NEXT_PUBLIC_*` or `HEDERA_*` variable of the calling shell, and stops
it at the end, checking that the port no longer accepts connections. It lists the `.env*` files the server
loads; for a run that matches a fresh clone that list reads `none`. Without `--serve`, the probe targets a
server you started yourself. `--help` lists every option.

Exit code 0 means every load passed, 1 means at least one failed, 2 means the probe could not run (no build,
port taken, no browser, bad configuration).

On a bare Linux image, `npm run browsers:ci --prefix tools/route-probe` also installs the system libraries
Chromium needs (it calls the system package manager, so it needs root).

The tool is a standalone package with its own lockfile, outside the workspaces: installing the app never
downloads a browser driver, and `npm ci` checks every file of the driver against the lockfile's hashes.

## Routes come from the file system

The route list is read from the app directory on every run: a new `page.tsx` is probed without touching
this tool. Route groups are folded away; route handlers, private folders, parallel-route slots and
intercepting routes are ignored because none of them has a URL of its own.

A dynamic route such as `app/token/[id]/page.tsx` has no URL until somebody names one. Declare at least
one sample in `probe.config.json`:

```json
{
  "dynamicRouteSamples": {
    "/token/[id]": ["/token/0.0.1234"]
  }
}
```

A dynamic route without a sample **fails the run**: an unprobed route would make a green table
meaningless. Samples that match no route of the app are rejected too, so stale entries cannot pile up.

## The probe proves it can fail

Six loads that must fail run on every invocation, before the report: one per detector (a planted
`console.error`, a planted third-party request answered locally, a route that does not exist, a document
with almost no text), and one per blocking mode, where a planted third-party request must come back as a
console error that names the planted host. If any of them passes, the run fails with "The probe is blind
to …", whatever the routes did. The planted host ends in `.invalid`, so nothing leaves the machine.

## What it cannot see

- Interception happens in the browser. What a route handler does on the server when its upstream is down
  is not exercised by the `abort` and `throttle` modes. To see that case, start the server yourself with
  `HEDERA_RPC_TESTNET_URL` and `HEDERA_MIRROR_TESTNET_URL` pointing at a closed port, and run the probe
  without `--serve`.
- Only first paint and the settle window are watched. Errors that need a click, a connected browser wallet
  or a transaction are out of reach.

## Develop

```bash
npm ci --prefix tools/route-probe
npm run test --prefix tools/route-probe
npm run check-types --prefix tools/route-probe
```

Tests run on `node:test`; the sources are plain ES modules type-checked through JSDoc under `strict`.
The root script `yarn probe:routes:check` runs these three commands.

<!-- checks:allow
paths: app/token/[id]/page.tsx .invalid
-->
