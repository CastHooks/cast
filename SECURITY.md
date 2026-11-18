# Security

CAST never holds keys or funds. It reads Solana, and it hands back unsigned transactions that the user's own wallet signs. The parts that matter most are the transaction builder (`server/tx.js`), the launchpad (`server/launch.js`) and the decoder (`lib/ext.js`).

## Reporting a vulnerability

Use GitHub's private vulnerability reporting on this repository: [report a vulnerability](https://github.com/CastHooks/cast/security/advisories/new). Include the steps to reproduce and what you observed. Please do not open a public issue for anything in the list below.

You will get an acknowledgement within 72 hours and a fix or a written assessment within 14 days.

## In scope

- A launch transaction that does something other than what the build response and its risk label say
- A way to make `/v1/launch/send` relay a transaction that was not built here, or one with a signature that does not verify
- A decoder result that hides a power a token really holds (a missed transfer hook, delegate, fee, freeze or pause authority)
- A fee-claim transaction that pays anyone other than the token's own withdraw authority
- Anything that lets a caller read or change another launch's stored metadata

## Supported versions

The `main` branch and the latest release.
