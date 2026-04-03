# md2html (CommonMark 0.31.2)

A JavaScript CLI program that converts Markdown to HTML using a fully hand-authored parser implementation bundled in this repository.

The parser engine is located in `lib/hand-authored-commonmark.js`, so the CLI does not require a runtime Markdown parser dependency.

## Install

```bash
npm install
```

## Usage

```bash
# from stdin
cat input.md | node ./bin/md2html.js > output.html

# from one or more files
node ./bin/md2html.js README.md > out.html
node ./bin/md2html.js intro.md chapter1.md chapter2.md -o book.html

# with options
node ./bin/md2html.js --sourcepos --smart --softbreak br input.md
```

## Options

- `-h, --help`: show help
- `-v, --version`: show version
- `--smart`: enable smart punctuation
- `--safe`: omit raw HTML and unsafe URLs
- `--unsafe`: allow raw HTML and all URLs (default)
- `--sourcepos`: include `data-sourcepos` attributes
- `--softbreak <value>`: render soft breaks as a raw string, or use `space` / `br`
- `-o, --output <file>`: write output to a file

## Conformance Verification

Run the official CommonMark 0.31.2 examples from `spec.json` against both the parser core and the CLI wrapper:

```bash
node ./scripts/verify-spec.js --mode both
```

Current baseline for this handwritten implementation: `652/652` examples pass for both core and CLI paths.

The verifier fetches:

- `https://spec.commonmark.org/0.31.2/spec.json`

You can also run against a local JSON file:

```bash
node ./scripts/verify-spec.js --mode both --file ./spec.json
```
