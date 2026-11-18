# Changelog

All notable changes to CAST are listed here. Versions follow [Semantic Versioning](https://semver.org).

## [Unreleased]

## [0.1.0] - 2026-11-18

First public release.

### Added

- **Decoder.** Fifteen token powers read from a mint account: transfer hook, transfer fee, permanent delegate, non-transferable, frozen by default, pausable, freeze and mint authorities, and the informational extensions, each with a plain-English note and a risk level.
- **Token index.** Thousands of traded Solana tokens with their extensions decoded from the chain, filterable by power, hook program or text.
- **Hook programs.** Every transfer-hook program in the index, whether it is deployed, who can upgrade it, and the tokens that run it.
- **Token check.** One call that combines a token's powers, its hook program and a live quote into a risk level with reasons.
- **Quote and swap.** Jupiter-routed quotes with the extension warnings attached, and unsigned swap transactions.
- **Launchpad.** One transaction that creates a Token-2022 mint with a transfer fee, an optional transfer hook, on-chain metadata and its whole supply, checked against the chain before signing and labelled with the risk level it will decode to. Signed launches are relayed only after both signatures verify.
- **Fee claims.** Read the transfer fees withheld for a token and build the withdrawal for its authority.
- **Agent tools.** Thirteen MCP tools over streamable HTTP.
- **Site.** Landing page, token explorer, launch page and docs.

[Unreleased]: https://github.com/CastHooks/cast/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/CastHooks/cast/releases/tag/v0.1.0
