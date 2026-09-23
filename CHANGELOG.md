# Changelog

## [1.0.2](https://github.com/chrischall/freshbooks-mcp/compare/v1.0.1...v1.0.2) (2026-09-23)


### Bug Fixes

* close auth, business-selection and email-recipient gaps from the Sept 2026 audit ([#79](https://github.com/chrischall/freshbooks-mcp/issues/79)) ([f4e380c](https://github.com/chrischall/freshbooks-mcp/commit/f4e380c6f21499aa6b4c04087733f36715daeab2))


### Refactor

* **client:** drop stale duplicate writeRefusal doc comment ([#82](https://github.com/chrischall/freshbooks-mcp/issues/82)) ([dc80091](https://github.com/chrischall/freshbooks-mcp/commit/dc80091707aca855a20f7c4eed89efe0a68f54a9))

## [1.0.1](https://github.com/chrischall/freshbooks-mcp/compare/v1.0.0...v1.0.1) (2026-09-23)


### Bug Fixes

* **deps:** bump dotenv from 17.4.2 to 18.0.1 ([#77](https://github.com/chrischall/freshbooks-mcp/issues/77)) ([2d8b7f6](https://github.com/chrischall/freshbooks-mcp/commit/2d8b7f69e3a955876343808589cd3a4de6646aa8))
* **deps:** require zod ^4.6.5 to match @chrischall/mcp-utils 2.4.0 ([#78](https://github.com/chrischall/freshbooks-mcp/issues/78)) ([c31e46a](https://github.com/chrischall/freshbooks-mcp/commit/c31e46a53a5185d80d0f0cd1a25e6d436857f5fd))
* **deps:** upgrade @chrischall/mcp-utils to 2.4.0 and @fetchproxy/* to 3.2.0 ([#73](https://github.com/chrischall/freshbooks-mcp/issues/73)) ([3f4ea43](https://github.com/chrischall/freshbooks-mcp/commit/3f4ea43c5fb51fc7c52372ff2b92e708eca23f6d))

## [1.0.0](https://github.com/chrischall/freshbooks-mcp/compare/v0.7.0...v1.0.0) (2026-09-20)


### Features

* **deps:** take mcp-utils 1.0.0, fixing server/discover ([#69](https://github.com/chrischall/freshbooks-mcp/issues/69)) ([7e42cce](https://github.com/chrischall/freshbooks-mcp/commit/7e42cceb9198aebd1090ea42ce5ad12cf45c472a))


### Bug Fixes

* **release:** cut the major a breaking change earns ([#71](https://github.com/chrischall/freshbooks-mcp/issues/71)) ([7481a23](https://github.com/chrischall/freshbooks-mcp/commit/7481a233469fb9cc103d68871e30f83434724e99))
* **release:** restate the Release-As footer the squash dropped ([#72](https://github.com/chrischall/freshbooks-mcp/issues/72)) ([14bb513](https://github.com/chrischall/freshbooks-mcp/commit/14bb513a3039fa7fa09b38354beface727fc990a))

## [0.7.0](https://github.com/chrischall/freshbooks-mcp/compare/v0.6.1...v0.7.0) (2026-09-17)


### ⚠ BREAKING CHANGES

* **mcp:** migrate server to SDK v2 ([#65](https://github.com/chrischall/freshbooks-mcp/issues/65))

### Features

* **mcp:** migrate server to SDK v2 ([#65](https://github.com/chrischall/freshbooks-mcp/issues/65)) ([ee7b845](https://github.com/chrischall/freshbooks-mcp/commit/ee7b84594b32069779552877f5168bdab41d0209))


### Bug Fixes

* **mcp:** cover OAuth tool registration ([#68](https://github.com/chrischall/freshbooks-mcp/issues/68)) ([b57357b](https://github.com/chrischall/freshbooks-mcp/commit/b57357bced47077dcd698d2985fca57e12148852)), closes [#66](https://github.com/chrischall/freshbooks-mcp/issues/66)

## [0.6.1](https://github.com/chrischall/freshbooks-mcp/compare/v0.6.0...v0.6.1) (2026-09-10)


### Bug Fixes

* **deps:** @chrischall/mcp-utils 0.26.1 ([#60](https://github.com/chrischall/freshbooks-mcp/issues/60)) ([4004501](https://github.com/chrischall/freshbooks-mcp/commit/400450151316ae7a1641d93e4df35ac144bed8a2))
* **deps:** bump hono from 4.13.1 to 4.13.7 ([#58](https://github.com/chrischall/freshbooks-mcp/issues/58)) ([0e0d5c1](https://github.com/chrischall/freshbooks-mcp/commit/0e0d5c1da69d9b7cc9619bd825a4f7ecf5ed72da))
* **deps:** declare the peer floors mcp-utils 0.26.1 requires ([#61](https://github.com/chrischall/freshbooks-mcp/issues/61)) ([1836bb8](https://github.com/chrischall/freshbooks-mcp/commit/1836bb898f42f122e69697d70c2b569b25ba2f1e))

## [0.6.0](https://github.com/chrischall/freshbooks-mcp/compare/v0.5.2...v0.6.0) (2026-09-04)


### Features

* **tools:** minify every response — no formatting whitespace on any payload ([#47](https://github.com/chrischall/freshbooks-mcp/issues/47)) ([fe09ce3](https://github.com/chrischall/freshbooks-mcp/commit/fe09ce3a1ac29b1ffe5341de562a3ec7f9a4c5ff))


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
