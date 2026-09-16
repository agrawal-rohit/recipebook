<div align="center">
  <h2>{{projectName}}</h2>
</div>

<div align="center">
  <p align="center" style="width: 80%; margin: auto">
    <a href="https://github.com/agrawal-rohit/tuckshop"><img alt="Made with tuckshop" src="https://img.shields.io/badge/made_with-tuckshop-635BFF"></a>
    <img alt="Status" src="https://img.shields.io/github/actions/workflow/status/{{githubUsername}}/{{projectName}}/build.yml">
    {{#publishToNpm}}
    <img alt="Downloads" src="https://img.shields.io/npm/dt/{{projectName}}">
    {{/publishToNpm}}
    <img alt="License" src="https://img.shields.io/github/license/{{githubUsername}}/{{projectName}}" />
  </p>

[Installation](#installation) • [Demo](#demo) • [Usage](#usage) • [Contributing](#contributing) • [License](#license)

</div>

<br />

{{#packageDescription}}{{packageDescription}}{{/packageDescription}}

## Installation

`{{projectName}}` can be installed using [npm](https://www.npmjs.com/) (or your favorite package manager):

```bash
$ {{packageManager}} install {{projectName}}
```

## Demo

_[Images, videos, or interactive demo links...]_

## Usage

_[This package can be used as follows...]_


## Contributing

Please read [CONTRIBUTING.md](CONTRIBUTING.md) for details on how to report issues, propose changes, and submit pull requests.

## License

See [LICENSE](LICENSE)[{{authorName}}](https://github.com/{{githubUsername}})
