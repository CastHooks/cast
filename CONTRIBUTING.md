# Contributing

Thanks for looking. CAST is one Node.js program with no dependencies.

## Getting set up

```bash
git clone https://github.com/CastHooks/cast
cd cast
npm start            # http://localhost:8298
npm test             # pure checks: the decoder and the transaction builder, no network
BASE=http://localhost:8298 npm test   # adds the live API and launchpad checks against Solana mainnet
```

Node 22.13 or newer.

## Where things live

- `lib/ext.js` is the catalogue of token powers and the decoder for a mint account. The node and the browser import this same file.
- `server/sol.js` talks to the Solana RPC and Jupiter.
- `server/store.js` is the SQLite token index and its sync loop.
- `server/api.js` holds every read operation as a plain function; REST routes and MCP tools both call these.
- `server/tx.js` builds Solana transactions by hand: base58, program addresses, the message format, Token-2022 instructions.
- `server/launch.js` is the launchpad: build, chain check, relay, read back, fee claims.
- `client/` is the site: landing page, token explorer, launch page, docs.

## Making a change

1. Branch from `dev`.
2. Keep the change small and add a test that fails without it.
3. Run the tests.
4. Open a pull request against `dev`. CI runs the syntax check and the test suite.

Security issues go through [private reporting](https://github.com/CastHooks/cast/security/advisories/new), not pull requests.
