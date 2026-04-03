#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const commonmark = require("../lib/hand-authored-commonmark");

const examples = JSON.parse(fs.readFileSync("/tmp/commonmark-0.31.2-spec.json", "utf8"));
const parser = new commonmark.Parser();
const renderer = new commonmark.HtmlRenderer();

const bySection = new Map();
const failures = [];

for (const ex of examples) {
    const actual = renderer.render(parser.parse(ex.markdown));
    if (actual !== ex.html) {
        bySection.set(ex.section, (bySection.get(ex.section) || 0) + 1);
        failures.push({ ex, actual });
    }
}

console.log(`total fails ${failures.length}`);
console.log("top sections");
for (const [section, count] of [...bySection.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
    console.log(`${count} ${section}`);
}

console.log("\nfirst 20 failures");
for (const item of failures.slice(0, 20)) {
    console.log("---");
    console.log(`example ${item.ex.example} section ${item.ex.section}`);
    console.log("markdown:");
    console.log(item.ex.markdown.replace(/\t/g, "→"));
    console.log("expected:");
    console.log(item.ex.html.trim());
    console.log("actual:");
    console.log(item.actual.trim());
}
