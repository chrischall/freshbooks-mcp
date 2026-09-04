# Changelog

## [0.6.0](https://github.com/chrischall/freshbooks-mcp/compare/v0.5.2...v0.6.0) (2026-09-04)


### Features

* **tools:** compact by default — strip media URLs, and minify every response ([#47](https://github.com/chrischall/freshbooks-mcp/issues/47)) ([fe09ce3](https://github.com/chrischall/freshbooks-mcp/commit/fe09ce3a1ac29b1ffe5341de562a3ec7f9a4c5ff))


### Bug Fixes

* **build:** restore the literal em dash in the package description ([#51](https://github.com/chrischall/freshbooks-mcp/issues/51)) ([8a25a09](https://github.com/chrischall/freshbooks-mcp/commit/8a25a0976f7651864e503de10672dd039c03b094))


### Refactor

* **tools:** drop the unwired view.ts — compact would be a no-op on FreshBooks records ([#52](https://github.com/chrischall/freshbooks-mcp/issues/52)) ([01bdc83](https://github.com/chrischall/freshbooks-mcp/commit/01bdc83303c77f5e15149ee7edf75fb34bfcc109))

## [0.5.2](https://github.com/chrischall/freshbooks-mcp/compare/v0.5.1...v0.5.2) (2026-08-31)


### Bug Fixes

* **auth:** give an ABSENT credential the same hosted-aware advice as a rejected one ([#35](https://github.com/chrischall/freshbooks-mcp/issues/35)) ([6126871](https://github.com/chrischall/freshbooks-mcp/commit/6126871d1b6a03728e3499784aecbf105d9e9962)), closes [#36](https://github.com/chrischall/freshbooks-mcp/issues/36)

## [0.5.1](https://github.com/chrischall/freshbooks-mcp/compare/v0.5.0...v0.5.1) (2026-08-31)


### Bug Fixes

* **auth:** give hosted users recovery advice they can act on ([#32](https://github.com/chrischall/freshbooks-mcp/issues/32)) ([0a63f58](https://github.com/chrischall/freshbooks-mcp/commit/0a63f58f9b99e24100c886a66c3e1bc2b708fb43)), closes [#33](https://github.com/chrischall/freshbooks-mcp/issues/33)

## [0.5.0](https://github.com/chrischall/freshbooks-mcp/compare/v0.4.0...v0.5.0) (2026-08-31)


### Features

* **auth:** mint the refresh token from tools, not a bootstrap script ([#28](https://github.com/chrischall/freshbooks-mcp/issues/28)) ([9bda31a](https://github.com/chrischall/freshbooks-mcp/commit/9bda31a2dc0851c8e0ce75ebb7256e34799ee912)), closes [#29](https://github.com/chrischall/freshbooks-mcp/issues/29)

## [0.4.0](https://github.com/chrischall/freshbooks-mcp/compare/v0.3.1...v0.4.0) (2026-08-30)


### Features

* add freshbooks_healthcheck ([#20](https://github.com/chrischall/freshbooks-mcp/issues/20)) ([741e631](https://github.com/chrischall/freshbooks-mcp/commit/741e6314972baa285a7c2fa6ebd72798ae86c288))

## [0.3.1](https://github.com/chrischall/freshbooks-mcp/compare/v0.3.0...v0.3.1) (2026-08-26)


### Refactor

* drop the sync narrowing cast on the token store ([#16](https://github.com/chrischall/freshbooks-mcp/issues/16)) ([3036b13](https://github.com/chrischall/freshbooks-mcp/commit/3036b13d35716d3e632d62ac70a2020593578eb0))
* move the token store onto the shared persistence helpers ([#14](https://github.com/chrischall/freshbooks-mcp/issues/14)) ([3ae1950](https://github.com/chrischall/freshbooks-mcp/commit/3ae1950793eb278eeb1cbc90736cecc3fd409bff))

## [0.3.0](https://github.com/chrischall/freshbooks-mcp/compare/v0.2.0...v0.3.0) (2026-08-13)


### Features

* add estimate write tools (accept, update, send) ([#6](https://github.com/chrischall/freshbooks-mcp/issues/6)) ([03fbd27](https://github.com/chrischall/freshbooks-mcp/commit/03fbd275bb835ea3b5a76d59ef374e329a56e0b6))

## [0.2.0](https://github.com/chrischall/freshbooks-mcp/compare/v0.1.0...v0.2.0) (2026-08-12)


### Features

* expand API coverage to expenses, projects, time tracking and the accounting long tail ([#2](https://github.com/chrischall/freshbooks-mcp/issues/2)) ([cab9766](https://github.com/chrischall/freshbooks-mcp/commit/cab9766aa1a2064ce81772100c20e9bad3fc3a86))


### Documentation

* correct the visibility-note condition and get_record's id description ([#5](https://github.com/chrischall/freshbooks-mcp/issues/5)) ([2cbf591](https://github.com/chrischall/freshbooks-mcp/commit/2cbf591e27d7fbf722a730e06a08e8b2be9b72e2))

## 0.1.0 (2026-08-12)


### Features

* FreshBooks MCP server for invoicing and accounts receivable ([8ca5ec2](https://github.com/chrischall/freshbooks-mcp/commit/8ca5ec28e8cd588a6a2a86030c6b381b5ff028b8))
