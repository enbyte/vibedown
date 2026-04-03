#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const commonmark = require("../lib/hand-authored-commonmark");
const packageJson = require("../package.json");

function printHelp() {
    process.stdout.write(
        [
            "md2html - CommonMark 0.31.2 Markdown to HTML CLI",
            "",
            "Usage:",
            "  md2html [options] [file ...]",
            "",
            "If no files are provided, input is read from stdin.",
            "If multiple files are provided, contents are concatenated with a newline.",
            "",
            "Options:",
            "  -h, --help                 Show this help text",
            "  -v, --version              Show CLI version",
            "  --smart                    Enable smart punctuation transforms",
            "  --safe                     Filter raw HTML and unsafe URLs",
            "  --unsafe                   Allow raw HTML and full URLs (default)",
            "  --sourcepos                Include data-sourcepos attributes",
            "  --softbreak <value>        Softbreak rendering: raw string, 'space', or 'br'",
            "  -o, --output <file>        Write HTML output to a file",
            "",
            "Examples:",
            "  md2html README.md",
            "  cat input.md | md2html --softbreak br > output.html",
            "  md2html intro.md chapter1.md chapter2.md -o book.html",
            "",
        ].join("\n")
    );
}

function fail(message) {
    process.stderr.write(`Error: ${message}\n`);
    process.exit(1);
}

function parseSoftbreak(value) {
    if (value === "space") {
        return " ";
    }
    if (value === "br") {
        return "<br />\n";
    }
    return value;
}

function parseArgs(argv) {
    const options = {
        help: false,
        version: false,
        smart: false,
        safe: false,
        sourcepos: false,
        softbreak: undefined,
        output: undefined,
        inputs: [],
    };

    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];

        if (arg === "--") {
            options.inputs.push(...argv.slice(i + 1));
            break;
        }

        if (arg === "-h" || arg === "--help") {
            options.help = true;
            continue;
        }

        if (arg === "-v" || arg === "--version") {
            options.version = true;
            continue;
        }

        if (arg === "--smart") {
            options.smart = true;
            continue;
        }

        if (arg === "--safe") {
            options.safe = true;
            continue;
        }

        if (arg === "--unsafe") {
            options.safe = false;
            continue;
        }

        if (arg === "--sourcepos") {
            options.sourcepos = true;
            continue;
        }

        if (arg === "--softbreak") {
            if (i + 1 >= argv.length) {
                fail("Missing value for --softbreak");
            }
            options.softbreak = parseSoftbreak(argv[i + 1]);
            i += 1;
            continue;
        }

        if (arg.startsWith("--softbreak=")) {
            options.softbreak = parseSoftbreak(arg.slice("--softbreak=".length));
            continue;
        }

        if (arg === "-o" || arg === "--output") {
            if (i + 1 >= argv.length) {
                fail("Missing value for --output");
            }
            options.output = argv[i + 1];
            i += 1;
            continue;
        }

        if (arg.startsWith("--output=")) {
            options.output = arg.slice("--output=".length);
            continue;
        }

        if (arg.startsWith("-")) {
            fail(`Unknown option: ${arg}`);
        }

        options.inputs.push(arg);
    }

    return options;
}

function readMarkdown(inputFiles) {
    if (inputFiles.length === 0) {
        return fs.readFileSync(0, "utf8");
    }

    const chunks = inputFiles.map((filePath) => fs.readFileSync(filePath, "utf8"));
    return chunks.join("\n");
}

function renderMarkdown(markdown, options) {
    const parser = new commonmark.Parser({ smart: options.smart });

    const rendererOptions = {
        safe: options.safe,
        sourcepos: options.sourcepos,
    };

    if (typeof options.softbreak === "string") {
        rendererOptions.softbreak = options.softbreak;
    }

    const renderer = new commonmark.HtmlRenderer(rendererOptions);
    const parsed = parser.parse(markdown);
    return renderer.render(parsed);
}

function main() {
    const args = parseArgs(process.argv.slice(2));

    if (args.help) {
        printHelp();
        return;
    }

    if (args.version) {
        process.stdout.write(`${packageJson.name} ${packageJson.version}\n`);
        return;
    }

    const markdown = readMarkdown(args.inputs);
    const html = renderMarkdown(markdown, args);

    if (args.output) {
        fs.writeFileSync(args.output, html, "utf8");
        return;
    }

    process.stdout.write(html);
}

try {
    main();
} catch (error) {
    const message = error && error.message ? error.message : String(error);
    fail(message);
}
