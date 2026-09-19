# Vendored YAML parser

`yaml.mjs` is a Rollup bundle of [`yaml` 2.9.1](https://www.npmjs.com/package/yaml/v/2.9.1). It is committed so Renovate `postUpgradeTasks` can parse Compose files from Renovate's temporary clone without running a package installation command or enabling the shell executor.

Regenerate after installing dependencies:

```bash
npx rollup .github/scripts/vendor/yaml-entry.mjs --format es --file .github/scripts/vendor/yaml.mjs
```

The upstream ISC license is in `YAML-LICENSE`.
