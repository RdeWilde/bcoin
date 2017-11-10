# Goji (Bcoin ported to Blackcoin)

__NOTE__: The latest release of goji contains a non-backward compatible change
to the rest API. Please read the [changelog]'s "migrating" section for more
details.

---

**Goji** is an alternative implementation of the blackcoin protocol, written in
node.js.

## Uses

- Full Node
- ~SPV Node~
- Wallet Backend (bip44 derivation)
- Mining Backend (getblocktemplate support)
- Layer 2 Backend (lightning)
- General Purpose Bitcoin Library

Try it in the browser: http://bcoin.io/browser.html

## Install

```
$ git clone -b goji https://github.com/janko33bd/bcoin.git goji
$ cd goji
$ npm install
$ ./bin/goji
```

See the [Beginner's Guide][guide] for more in-depth installation instructions.

## Documentation

- API Docs: http://bcoin.io/docs/
- REST Docs: [docs/REST-RPC-API](docs/REST-RPC-API.md)
- Docs: [docs/](docs/README.md)

## Support

Join us on [gitter][gitter] channel.

## Disclaimer

Goji does not guarantee you against theft or lost funds due to bugs, mishaps,
or your own incompetence. You and you alone are responsible for securing your
money.

## Contribution and License Agreement

If you contribute code to this project, you are implicitly allowing your code
to be distributed under the MIT license. You are also implicitly verifying that
all code is your original work. `</legalese>`

## License

- Copyright (c) 2014-2015, Fedor Indutny (MIT License).
- Copyright (c) 2014-2017, Christopher Jeffrey (MIT License).
- Copyright (c) 2017-3333, Janko33 (MIT License).

See LICENSE for more info.

[purse]: https://purse.io
[guide]: https://github.com/bcoin-org/bcoin/blob/master/docs/Beginner's-Guide.md
[gitter]: https://gitter.im/BlackCoin_Hub
[changelog]: https://github.com/bcoin-org/bcoin/blob/master/CHANGELOG.md
