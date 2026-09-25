# Changelog

## [0.3.1](https://github.com/agrawal-rohit/recipebook/compare/core@v0.3.0...core@v0.3.1) (2026-09-25)


### Fixed

* renamed core package name, added NPM token in the workflow ([4377058](https://github.com/agrawal-rohit/recipebook/commit/43770588df5c9644b0182af6a3aa40c44ab969f6))

## [0.3.0](https://github.com/agrawal-rohit/recipebook/compare/core@v0.2.1...core@v0.3.0) (2026-09-25)


### Added

* added 'add' command logic ([64a41c5](https://github.com/agrawal-rohit/recipebook/commit/64a41c55aa4eb64ec53f690c1934578420bca41a))
* added agent instructions ([a3f7c61](https://github.com/agrawal-rohit/recipebook/commit/a3f7c613e2a8ad116bc996e45d881de6b808219b))
* added config-based registry source setup, removed registry items for now ([5490b44](https://github.com/agrawal-rohit/recipebook/commit/5490b441bca96a9a03db723dd3fa3578f3829de8))
* added hook-based install scripts logic ([e2de53a](https://github.com/agrawal-rohit/recipebook/commit/e2de53a2329684c4e468ac62c818534b12f3f346))
* added secure package management configuration ([799ea03](https://github.com/agrawal-rohit/recipebook/commit/799ea03ef280d37f76063b03bbcf6a051fcd4bb2))
* added Socket SFW support, split install commands, updated minReleaseAge in depedanbot ([7e19839](https://github.com/agrawal-rohit/recipebook/commit/7e19839cbcde9b8bd60c4d12b6d5f99e018c1d1b))
* added starter templates ([5ef7f51](https://github.com/agrawal-rohit/recipebook/commit/5ef7f513ab16489850125689396dd3bf73bc2138))
* added ugly ass code for safe script execution ([aecb83b](https://github.com/agrawal-rohit/recipebook/commit/aecb83b3213393b4b43154e6b210555bd1fb2ffc))
* park again after API cleanup and multiple changes ([034a6ac](https://github.com/agrawal-rohit/recipebook/commit/034a6ace4cb622a1cc158f25509011efdd657fde))
* updated package manager logic with manifest reading, added nub support ([be07517](https://github.com/agrawal-rohit/recipebook/commit/be075170b89faa201c76106449e7a4886f8c99e1))


### Fixed

* a little code cleanup ([bc48f44](https://github.com/agrawal-rohit/recipebook/commit/bc48f447f95ef358eca5f3e93c0de2a0c6dd95a4))
* added changes to building logic ([4dd3f6a](https://github.com/agrawal-rohit/recipebook/commit/4dd3f6a4135ebaf129672f2e5488d58000c7c696))
* allowed empty registry ([6cc59db](https://github.com/agrawal-rohit/recipebook/commit/6cc59db99572de7cbec85803a1c2bed9468bd552))
* did some more code cleanup ([94a277a](https://github.com/agrawal-rohit/recipebook/commit/94a277a7617e8c8717df579618381ac82c82130b))
* fixed failing CI jobs ([1be27b8](https://github.com/agrawal-rohit/recipebook/commit/1be27b8a73ef7b8ae3e11bcf0fdf29057c72c5a1))
* fixed some bugs when testing instruction adding examples ([6255844](https://github.com/agrawal-rohit/recipebook/commit/625584490a9ee2885bb22efee0c7844b67146cd3))
* fixed sonarqube flagged issues ([cfc38ff](https://github.com/agrawal-rohit/recipebook/commit/cfc38ff87f12ae76bbadd802bf960949a63e2d1b))
* improved compiled registry output, added a mutation testing convention ([7e094ab](https://github.com/agrawal-rohit/recipebook/commit/7e094ab2526e2474242f6ba80a5adabadd77813f))
* made registry types declarative ([8ecf0d6](https://github.com/agrawal-rohit/recipebook/commit/8ecf0d6b01c194b64e5fbfdc1d5dd983c63199b8))
* made the compilted registry leaner ([5515d48](https://github.com/agrawal-rohit/recipebook/commit/5515d48a92e5e392e6ba3da73be954340ef50677))
* moved around more code ([9e83b9b](https://github.com/agrawal-rohit/recipebook/commit/9e83b9b95f8c5bda3c1029c934c94a807f096534))
* removed registry version and schema version ([b2912db](https://github.com/agrawal-rohit/recipebook/commit/b2912dbaee865731eb3703952a75c1bb97fa6270))
* shifted to embedded content built registry for easier consumption ([2cc14ed](https://github.com/agrawal-rohit/recipebook/commit/2cc14edf9cdf2adfcc81a35cb6fd159dfc625a0f))
* some changes to the package manager logic ([356d4ac](https://github.com/agrawal-rohit/recipebook/commit/356d4ac9e7bf273227f9edad4f14e0a314ec6778))
* split playground as a standalone registry item ([5f81209](https://github.com/agrawal-rohit/recipebook/commit/5f812094fc946b5fba56f84fb39f2dae291da6f1))


### Changed

* add more unit tests ([f410aa7](https://github.com/agrawal-rohit/recipebook/commit/f410aa7df89e0271301c10f53882971c8ee2d0af))
* added missing test cases ([7baac6b](https://github.com/agrawal-rohit/recipebook/commit/7baac6b1e6f560ab7f8862103d2ea41a7e7dcfea))
* added more test cases to core ([57fd5b1](https://github.com/agrawal-rohit/recipebook/commit/57fd5b1935429513d9c4525cd25c0a2ae2542c84))
* added more unit tests to the core functions ([90cc7ea](https://github.com/agrawal-rohit/recipebook/commit/90cc7eaf678f994040542210fc41f590ee4c488b))
* added remaining test cases ([23245ef](https://github.com/agrawal-rohit/recipebook/commit/23245ef21667677f16c20b135ffc43b63b9e3a83))
* added test cases for remaining core paths ([09d059f](https://github.com/agrawal-rohit/recipebook/commit/09d059fca47316cba974e57d0c7de3be0ef15386))
* added test coverage ([ca9760a](https://github.com/agrawal-rohit/recipebook/commit/ca9760a70ba3dfdf6ebfa8f9ffdb54af302e2bf0))
* split oversized test describes via shared helpers ([8f6e80f](https://github.com/agrawal-rohit/recipebook/commit/8f6e80f0559be548b8acbe2541cb90b975feadcc))
* unwrap largest oversized describe blocks to top-level tests ([6f5f9c2](https://github.com/agrawal-rohit/recipebook/commit/6f5f9c21d89a5b74341f4ec2756177f26e763395))
* updated breaking tests, added some missing coverage in a few files ([950344c](https://github.com/agrawal-rohit/recipebook/commit/950344c5b5d347391d133145c9ed821acd992011))
