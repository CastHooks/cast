# CAST

[![license](https://img.shields.io/badge/license-MIT-9945ff)](LICENSE) [![node](https://img.shields.io/badge/node-%E2%89%A5%2022.13-9945ff)](.node-version) [![dependencies](https://img.shields.io/badge/dependencies-0-9945ff)](package.json)

**[casthooks.xyz](https://casthooks.xyz)** · [Docs](https://casthooks.xyz/docs) · [X](https://x.com/CastHooksPad) · [Changelog](CHANGELOG.md) · [Security](SECURITY.md)

The custom hooks launchpad on Solana, and the decoder behind it. One Node.js process that launches Token-2022 tokens with a fee and a hook, reads what a token is allowed to do to the people who hold it, and serves it as an API, an explorer and tools for agents.

Solana's Token-2022 program lets a mint carry extensions: a transfer hook that runs a program inside every transfer, a transfer fee, a permanent delegate that can move anyone's balance, accounts frozen by default, a pause switch. CAST decodes them, together with the classic mint and freeze authorities.

- **Decode API.** Any mint in, every power out, read from the mint account, with plain-English notes and a risk level.
- **Token index.** Thousands of traded tokens (Jupiter's verified, most traded, trending and newest lists) with their extensions decoded from the chain, filterable by power.
- **Hook programs.** Every transfer-hook program in the index, whether it can still be upgraded, and the tokens that run it.
- **Token check.** One call before a buy: powers, hook program, and a live quote.
- **Quote and swap.** Jupiter-routed quotes with the extension warnings attached, and unsigned swap transactions the wallet signs. The node never holds keys.
- **Launchpad.** One transaction creates a Token-2022 mint with a transfer fee, an optional transfer hook, on-chain metadata and its whole supply. Every build is run against the chain and returns the risk label the token will decode to, before anyone signs. Creators claim their withheld transfer fees from the same page.
- **Agent tools.** Thirteen MCP tools over streamable HTTP. None of them signs or sends.

## Launching a token

```bash
# 1. build: `mint` is a fresh public key whose secret you hold
curl -X POST http://localhost:8298/v1/launch/build -H "content-type: application/json" \
  -d '{"creator":"<wallet>","mint":"<fresh key>","name":"Cast","symbol":"CAST","feeBps":100}'
# 2. sign the returned transaction with the wallet, then with the mint key
# 3. relay it; both signatures are verified before it reaches Solana
curl -X POST http://localhost:8298/v1/launch/send -H "content-type: application/json" \
  -d '{"mint":"<fresh key>","transaction":"<signed base64>"}'
```

The transaction talks to the System, Token-2022 and Associated Token programs directly. There is no launchpad program to deploy or trust, and no launch fee.

## Run it

```bash
npm start          # http://localhost:8298
npm test           # decoder checks; add BASE=http://localhost:8298 for the live API checks
```

Node 22.13 or newer (the index uses the built-in `node:sqlite`). No dependencies.

## Layout

| Path | What it is |
|---|---|
| `lib/ext.js` | The powers: catalogue, decoding a parsed mint account, notes and risk level. Shared by the node and the browser |
| `server/sol.js` | Solana RPC (mint accounts, hook programs) and Jupiter (token lists, quotes, swaps) |
| `server/store.js` | The SQLite index and its sync loop |
| `server/api.js` | Every read operation as a plain function |
| `server/tx.js` | Solana transactions by hand: base58, program addresses, the message format, Token-2022 instructions |
| `server/launch.js` | The launchpad: build, chain check, relay, read back, fee claims |
| `server/index.js` | HTTP routes, the MCP endpoint and the static site |
| `client/` | Landing page, token explorer, launch page, docs |
| `test/run.js` | The test suite |

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8298` | HTTP port |
| `DATA_PATH` | `./cast.db` | The SQLite index. Put it on a persistent disk |
| `RPC_URL` | `https://api.mainnet-beta.solana.com` | Solana RPC. A private endpoint decodes faster |
| `JUPITER_URL` | `https://lite-api.jup.ag` | Jupiter API base |
| `SITE_URL`, `X_URL`, `GH_URL` | empty | Links shown on the site. `SITE_URL` is also the base of the metadata links written into launched mints, so set it before launching |
| `PRIORITY_MICROLAMPORTS` | `50000` | Priority fee per compute unit on launch and claim transactions |
| `BRAND_NAME`, `BRAND_TICKER` | `CAST`, `$CAST` | Name and ticker shown on the site |
| `TOKEN_MINT` | empty | The token's mint, shown on the site once it exists |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Report vulnerabilities through [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
