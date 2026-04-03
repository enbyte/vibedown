#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const https = require("node:https");
const { spawnSync } = require("node:child_process");
const commonmark = require("../lib/hand-authored-commonmark");

const DEFAULT_SPEC_URL = "https://spec.commonmark.org/0.31.2/spec.json";

function fail(message) {
    process.stderr.write(`Error: ${message}\n`);
    process.exit(1);
}

function parseArgs(argv) {
    const options = {
        mode: "both",
        url: DEFAULT_SPEC_URL,
        file: undefined,
    };

    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];

        if (arg === "--mode") {
            if (i + 1 >= argv.length) {
                fail("Missing value for --mode");
            }
            options.mode = argv[i + 1];
            i += 1;
            continue;
        }

        if (arg.startsWith("--mode=")) {
            options.mode = arg.slice("--mode=".length);
            continue;
        }

        if (arg === "--url") {
            if (i + 1 >= argv.length) {
                fail("Missing value for --url");
            }
            options.url = argv[i + 1];
            i += 1;
            continue;
        }

        if (arg.startsWith("--url=")) {
            options.url = arg.slice("--url=".length);
            continue;
        }

        if (arg === "--file") {
            if (i + 1 >= argv.length) {
                fail("Missing value for --file");
            }
            options.file = argv[i + 1];
            i += 1;
            continue;
        }

        if (arg.startsWith("--file=")) {
            options.file = arg.slice("--file=".length);
            continue;
        }

        fail(`Unknown argument: ${arg}`);
    }

    if (!["core", "cli", "both"].includes(options.mode)) {
        fail("--mode must be one of: core, cli, both");
    }

    return options;
}

function fetchText(url, redirectsLeft = 5) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, (res) => {
            const status = res.statusCode || 0;
            const location = res.headers.location;

            if ([301, 302, 303, 307, 308].includes(status) && location && redirectsLeft > 0) {
                res.resume();
                const nextUrl = new URL(location, url).toString();
                fetchText(nextUrl, redirectsLeft - 1).then(resolve, reject);
                return;
            }

            if (status < 200 || status >= 300) {
                reject(new Error(`Request failed with status ${status}`));
                res.resume();
                return;
            }

            const chunks = [];
            res.setEncoding("utf8");
            res.on("data", (chunk) => chunks.push(chunk));
            res.on("end", () => resolve(chunks.join("")));
        });

        req.on("error", reject);
    });
}

function loadExamples(options) {
    if (options.file) {
        const text = fs.readFileSync(options.file, "utf8");
        return { source: options.file, examples: JSON.parse(text) };
    }

    return fetchText(options.url).then((text) => ({
        source: options.url,
        examples: JSON.parse(text),
    }));
}

function runCoreCheck(examples) {
    const parser = new commonmark.Parser();
    const renderer = new commonmark.HtmlRenderer();

    let failed = 0;
    for (const example of examples) {
        const actual = renderer.render(parser.parse(example.markdown));
        if (actual !== example.html) {
            failed += 1;
            if (failed <= 5) {
                process.stderr.write(`core mismatch at example ${example.example}\n`);
            }
        }
    }

    return { total: examples.length, failed };
}

function runCliCheck(examples) {
    const cliPath = path.join(__dirname, "..", "bin", "md2html.js");

    let failed = 0;
    for (const example of examples) {
        const proc = spawnSync(process.execPath, [cliPath], {
            input: example.markdown,
            encoding: "utf8",
        });

        if (proc.status !== 0) {
            failed += 1;
            if (failed <= 5) {
                process.stderr.write(`cli execution failed at example ${example.example}\n`);
            }
            continue;
        }

        if (proc.stdout !== example.html) {
            failed += 1;
            if (failed <= 5) {
                process.stderr.write(`cli mismatch at example ${example.example}\n`);
            }
        }
    }

    return { total: examples.length, failed };
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    const { source, examples } = await loadExamples(options);

    process.stdout.write(`Loaded ${examples.length} examples from ${source}\n`);

    let failed = 0;

    if (options.mode === "core" || options.mode === "both") {
        const result = runCoreCheck(examples);
        process.stdout.write(`Core parser check: ${result.total - result.failed}/${result.total} passed\n`);
        failed += result.failed;
    }

    if (options.mode === "cli" || options.mode === "both") {
        const result = runCliCheck(examples);
        process.stdout.write(`CLI check: ${result.total - result.failed}/${result.total} passed\n`);
        failed += result.failed;
    }

    if (failed > 0) {
        process.exit(1);
    }
}

main().catch((error) => {
    const message = error && error.message ? error.message : String(error);
    fail(message);
});
