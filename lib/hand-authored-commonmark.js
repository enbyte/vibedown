"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ENTITY_DATA = JSON.parse(
    fs.readFileSync(path.join(__dirname, "html-entities.json"), "utf8")
);

const NAMED_ENTITIES = new Map();
for (const [name, value] of Object.entries(ENTITY_DATA)) {
    if (name.startsWith("&") && name.endsWith(";")) {
        NAMED_ENTITIES.set(name.slice(1, -1), value.characters);
    }
}

const BLOCK_TAGS = new Set(
    [
        "address",
        "article",
        "aside",
        "base",
        "basefont",
        "blockquote",
        "body",
        "caption",
        "center",
        "col",
        "colgroup",
        "dd",
        "details",
        "dialog",
        "dir",
        "div",
        "dl",
        "dt",
        "fieldset",
        "figcaption",
        "figure",
        "footer",
        "form",
        "frame",
        "frameset",
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "head",
        "header",
        "hr",
        "html",
        "iframe",
        "legend",
        "li",
        "link",
        "main",
        "menu",
        "menuitem",
        "nav",
        "noframes",
        "ol",
        "optgroup",
        "option",
        "p",
        "param",
        "search",
        "section",
        "summary",
        "table",
        "tbody",
        "td",
        "tfoot",
        "th",
        "thead",
        "title",
        "tr",
        "track",
        "ul",
    ].map((tag) => tag.toLowerCase())
);

const ESCAPABLE = new Set(
    "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~".split("")
);

const LAZY_PREFIX = "\u0007";

function escapeHtml(text) {
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/\"/g, "&quot;");
}

function normalizeInput(markdown) {
    return markdown.replace(/\r\n?/g, "\n").replace(/\u0000/g, "\uFFFD");
}

function isBlank(line) {
    return /^[ \t]*$/.test(line);
}

function isWhitespace(ch) {
    if (ch === "" || ch === undefined || ch === null) {
        return true;
    }
    return /[\p{White_Space}]/u.test(ch);
}

function isPunctuation(ch) {
    if (ch === "" || ch === undefined || ch === null) {
        return false;
    }
    return /[\p{P}\p{S}]/u.test(ch);
}

function countIndentColumns(line) {
    let col = 0;
    let i = 0;
    while (i < line.length) {
        const ch = line[i];
        if (ch === " ") {
            col += 1;
        } else if (ch === "\t") {
            col += 4 - (col % 4);
        } else {
            break;
        }
        i += 1;
    }
    return { columns: col, index: i };
}

function removeIndentColumns(line, columnsToRemove) {
    let col = 0;
    let i = 0;

    while (i < line.length) {
        const ch = line[i];
        if (ch === " ") {
            col += 1;
            i += 1;
            continue;
        }
        if (ch === "\t") {
            col += 4 - (col % 4);
            i += 1;
            continue;
        }
        break;
    }

    if (col < columnsToRemove) {
        return null;
    }

    const remainingColumns = col - columnsToRemove;
    return `${" ".repeat(remainingColumns)}${line.slice(i)}`;
}

function removeUpToIndentColumns(line, maxColumnsToRemove) {
    const strict = removeIndentColumns(line, maxColumnsToRemove);
    if (strict !== null) {
        return strict;
    }
    const indent = countIndentColumns(line);
    return line.slice(indent.index);
}

function stripUpToThreeSpaces(line) {
    let i = 0;
    while (i < line.length && i < 3 && line[i] === " ") {
        i += 1;
    }
    return line.slice(i);
}

function parseThematicBreak(line) {
    const indent = countIndentColumns(line);
    if (indent.columns > 3) {
        return false;
    }

    const stripped = stripUpToThreeSpaces(line);
    if (!/^[ \t*_\-]+$/.test(stripped)) {
        return false;
    }

    const chars = stripped.replace(/[ \t]/g, "");
    if (chars.length < 3) {
        return false;
    }

    if (/^\*+$/.test(chars) || /^-+$/.test(chars) || /^_+$/.test(chars)) {
        return true;
    }

    return false;
}

function parseAtxHeading(line) {
    const stripped = stripUpToThreeSpaces(line);
    const match = stripped.match(/^(#{1,6})(?:[ \t]+|$)(.*)$/);
    if (!match) {
        return null;
    }

    const level = match[1].length;
    let content = match[2] || "";

    if (/^#+[ \t]*$/.test(content)) {
        content = "";
    } else if (/[ \t]#+[ \t]*$/.test(content)) {
        content = content.replace(/[ \t]#+[ \t]*$/, "");
    }

    content = content.replace(/^[ \t]+|[ \t]+$/g, "");

    return { level, content };
}

function parseSetextUnderline(line) {
    if (line.startsWith(LAZY_PREFIX)) {
        return 0;
    }

    const indent = countIndentColumns(line);
    if (indent.columns > 3) {
        return 0;
    }

    const stripped = stripUpToThreeSpaces(line);
    if (/^=+[ \t]*$/.test(stripped)) {
        return 1;
    }
    if (/^-+[ \t]*$/.test(stripped)) {
        return 2;
    }
    return 0;
}

function parseFenceStart(line) {
    const stripped = stripUpToThreeSpaces(line);
    const indent = line.length - stripped.length;
    const match = stripped.match(/^(`{3,}|~{3,})([ \t]*)(.*)$/);
    if (!match) {
        return null;
    }

    const fence = match[1];
    const marker = fence[0];
    let info = match[3] || "";

    if (marker === "`" && /`/.test(info)) {
        return null;
    }

    info = info.replace(/^[ \t]+|[ \t]+$/g, "");

    return {
        indent,
        marker,
        fenceLength: fence.length,
        info,
    };
}

function isFenceEnd(line, fence) {
    const stripped = stripUpToThreeSpaces(line);
    const regex = new RegExp(`^${fence.marker}{${fence.fenceLength},}[ \\t]*$`);
    return regex.test(stripped);
}

function parseBlockQuoteMarker(line) {
    let i = 0;
    let spaces = 0;

    while (i < line.length && spaces < 3 && line[i] === " ") {
        i += 1;
        spaces += 1;
    }

    if (line[i] !== ">") {
        return null;
    }

    const quoteColumn = spaces + 1;
    i += 1;
    if (line[i] === " ") {
        i += 1;
    } else if (line[i] === "\t") {
        const tabWidth = 4 - (quoteColumn % 4);
        i += 1;

        let prefixColumns = Math.max(0, tabWidth - 1);
        let col = quoteColumn + 1 + prefixColumns;
        while (i < line.length && (line[i] === " " || line[i] === "\t")) {
            if (line[i] === " ") {
                prefixColumns += 1;
                col += 1;
            } else {
                const width = 4 - (col % 4);
                prefixColumns += width;
                col += width;
            }
            i += 1;
        }

        return {
            rest: `${" ".repeat(prefixColumns)}${line.slice(i)}`,
            indent: spaces,
        };
    }

    return {
        rest: line.slice(i),
        indent: spaces,
    };
}

function parseListMarker(line) {
    const indentInfo = countIndentColumns(line);
    if (indentInfo.columns > 3) {
        return null;
    }

    const rest = line.slice(indentInfo.index);

    let markerText = "";
    let listType = "";
    let delimiter = "";
    let start = 1;

    const bulletMatch = rest.match(/^([*+-])(.*)$/);
    if (bulletMatch) {
        markerText = bulletMatch[1];
        listType = "bullet";
        delimiter = markerText;
    } else {
        const orderedMatch = rest.match(/^(\d{1,9})([.)])(.*)$/);
        if (!orderedMatch) {
            return null;
        }
        markerText = orderedMatch[1] + orderedMatch[2];
        listType = "ordered";
        delimiter = orderedMatch[2];
        start = Number(orderedMatch[1]);
    }

    const afterMarker = rest.slice(markerText.length);
    if (afterMarker.length > 0 && afterMarker[0] !== " " && afterMarker[0] !== "\t") {
        return null;
    }

    let paddingChars = 0;
    let paddingColumns = 0;
    while (paddingChars < afterMarker.length && (afterMarker[paddingChars] === " " || afterMarker[paddingChars] === "\t")) {
        if (afterMarker[paddingChars] === " ") {
            paddingColumns += 1;
        } else {
            const markerColumn = indentInfo.columns + markerText.length + paddingColumns;
            paddingColumns += 4 - (markerColumn % 4);
        }
        paddingChars += 1;
    }

    if (afterMarker.length > 0 && paddingChars === 0) {
        return null;
    }

    let contentOffset;
    let contentIndent;
    let effectivePadding;
    let firstContent = "";

    if (afterMarker.length === 0) {
        contentOffset = line.length;
        effectivePadding = 1;
        contentIndent = indentInfo.columns + markerText.length + effectivePadding;
        firstContent = "";
    } else {
        effectivePadding = paddingColumns;
        if (effectivePadding > 4) {
            effectivePadding = 1;
            contentOffset = indentInfo.index + markerText.length + 1;

            if (afterMarker[0] === " ") {
                firstContent = afterMarker.slice(1);
            } else {
                const tabWidth = 4 - ((indentInfo.columns + markerText.length) % 4);
                let prefixColumns = Math.max(0, tabWidth - 1);
                let col = indentInfo.columns + markerText.length + 1 + prefixColumns;
                let k = 1;
                while (k < afterMarker.length && (afterMarker[k] === " " || afterMarker[k] === "\t")) {
                    if (afterMarker[k] === " ") {
                        prefixColumns += 1;
                        col += 1;
                    } else {
                        const width = 4 - (col % 4);
                        prefixColumns += width;
                        col += width;
                    }
                    k += 1;
                }
                firstContent = `${" ".repeat(prefixColumns)}${afterMarker.slice(k)}`;
            }
        } else {
            contentOffset = indentInfo.index + markerText.length + paddingChars;
            firstContent = afterMarker.slice(paddingChars);
        }
        contentIndent = indentInfo.columns + markerText.length + effectivePadding;
    }

    return {
        listType,
        delimiter,
        start,
        markerText,
        markerLength: markerText.length,
        indentColumns: indentInfo.columns,
        spacesAfter: paddingColumns,
        contentOffset,
        contentIndent,
        firstContent,
        rawLine: line,
    };
}

function isSameListType(a, b) {
    if (a.listType !== b.listType) {
        return false;
    }
    if (a.listType === "bullet") {
        return a.delimiter === b.delimiter;
    }
    return a.delimiter === b.delimiter;
}

function parseHtmlBlockStart(line, canInterruptParagraph) {
    const stripped = stripUpToThreeSpaces(line);

    if (/^<(pre|script|style|textarea)(?:[ \t>]|$)/i.test(stripped)) {
        return 1;
    }
    if (/^<!--/.test(stripped)) {
        return 2;
    }
    if (/^<\?/.test(stripped)) {
        return 3;
    }
    if (/^<![A-Za-z]/.test(stripped)) {
        return 4;
    }
    if (/^<!\[CDATA\[/.test(stripped)) {
        return 5;
    }

    const type6Match = stripped.match(/^<\/?([A-Za-z][A-Za-z0-9-]*)(?:[ \t\/>]|$)/);
    if (type6Match && BLOCK_TAGS.has(type6Match[1].toLowerCase())) {
        return 6;
    }

    if (!canInterruptParagraph) {
        return 0;
    }

    const type7OpenRegex = /^<[A-Za-z][A-Za-z0-9-]*(?:[ \t]+[A-Za-z_:][A-Za-z0-9_.:-]*(?:[ \t]*=[ \t]*(?:[^ \t\n\"'=<>`]+|\"[^\"\n]*\"|'[^'\n]*'))?)*[ \t]*\/?>(?:[ \t]*)$/;
    if (type7OpenRegex.test(stripped)) {
        return 7;
    }

    const closeTagRegex = /^<\/[A-Za-z][A-Za-z0-9-]*[ \t]*>(?:[ \t]*)$/;
    if (closeTagRegex.test(stripped)) {
        return 7;
    }

    return 0;
}

function htmlBlockEnded(type, line) {
    if (type === 1) {
        return /<\/(pre|script|style|textarea)>/i.test(line);
    }
    if (type === 2) {
        return /-->/.test(line);
    }
    if (type === 3) {
        return /\?>/.test(line);
    }
    if (type === 4) {
        return />/.test(line);
    }
    if (type === 5) {
        return /\]\]>/.test(line);
    }
    if (type === 6 || type === 7) {
        return isBlank(line);
    }
    return false;
}

function normalizeLabel(label) {
    return label
        .replace(/^[\s\t\n\r\f]+|[\s\t\n\r\f]+$/g, "")
        .replace(/[\s\t\n\r\f]+/g, " ")
        .toLocaleLowerCase();
}

function caseFold(text) {
    return text.replace(/[\u1E9E\u00DF]/g, "ss").toLocaleLowerCase();
}

function decodeReferenceLabel(label) {
    let out = "";
    let i = 0;
    while (i < label.length) {
        if (label[i] === "\\" && i + 1 < label.length && (label[i + 1] === "[" || label[i + 1] === "]" || label[i + 1] === "\\")) {
            out += label[i + 1];
            i += 2;
            continue;
        }
        out += label[i];
        i += 1;
    }
    return out;
}

function normalizeReferenceLabel(label) {
    return caseFold(
        decodeReferenceLabel(label)
            .replace(/^[\s\t\n\r\f]+|[\s\t\n\r\f]+$/g, "")
            .replace(/[\s\t\n\r\f]+/g, " ")
    );
}

function parseCharRef(raw) {
    if (/^&#[0-9]{1,7};$/.test(raw)) {
        let code = Number(raw.slice(2, -1));
        if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
            code = 0xfffd;
        }
        return String.fromCodePoint(code);
    }

    if (/^&#[xX][0-9A-Fa-f]{1,6};$/.test(raw)) {
        let code = parseInt(raw.slice(3, -1), 16);
        if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
            code = 0xfffd;
        }
        return String.fromCodePoint(code);
    }

    const namedMatch = raw.match(/^&([A-Za-z][A-Za-z0-9]{1,31});$/);
    if (namedMatch) {
        const value = NAMED_ENTITIES.get(namedMatch[1]);
        if (value) {
            return value;
        }
    }

    return null;
}

function decodeEscapesAndEntities(text) {
    let out = "";
    let i = 0;

    while (i < text.length) {
        if (text[i] === "\\" && i + 1 < text.length) {
            const next = text[i + 1];
            if (ESCAPABLE.has(next)) {
                out += next;
                i += 2;
                continue;
            }
        }

        if (text[i] === "&") {
            const semi = text.indexOf(";", i + 1);
            if (semi !== -1) {
                const candidate = text.slice(i, semi + 1);
                const decoded = parseCharRef(candidate);
                if (decoded !== null) {
                    out += decoded;
                    i = semi + 1;
                    continue;
                }
            }
        }

        out += text[i];
        i += 1;
    }

    return out;
}

function decodeEntitiesOnly(text) {
    let out = "";
    let i = 0;

    while (i < text.length) {
        if (text[i] === "&") {
            const semi = text.indexOf(";", i + 1);
            if (semi !== -1) {
                const candidate = text.slice(i, semi + 1);
                const decoded = parseCharRef(candidate);
                if (decoded !== null) {
                    out += decoded;
                    i = semi + 1;
                    continue;
                }
            }
        }

        out += text[i];
        i += 1;
    }

    return out;
}

function parseLinkDestination(text, startIndex) {
    if (startIndex >= text.length) {
        return null;
    }

    if (text[startIndex] === "<") {
        let i = startIndex + 1;
        let out = "";
        while (i < text.length) {
            if (text[i] === "\\" && i + 1 < text.length) {
                out += text[i] + text[i + 1];
                i += 2;
                continue;
            }
            if (text[i] === "\n") {
                return null;
            }
            if (text[i] === ">") {
                return {
                    destination: decodeEscapesAndEntities(out),
                    nextIndex: i + 1,
                };
            }
            out += text[i];
            i += 1;
        }
        return null;
    }

    let i = startIndex;
    let level = 0;
    let out = "";

    while (i < text.length) {
        const ch = text[i];
        if (ch === " " || ch === "\t" || ch === "\n") {
            break;
        }
        if (ch === "<") {
            return null;
        }
        if (ch === "(") {
            level += 1;
        }
        if (ch === ")") {
            if (level === 0) {
                break;
            }
            level -= 1;
        }
        if (ch === "\\" && i + 1 < text.length) {
            out += ch + text[i + 1];
            i += 2;
            continue;
        }
        if (/[\u0000-\u001F\u007F]/.test(ch)) {
            return null;
        }
        out += ch;
        i += 1;
    }

    if (out.length === 0) {
        return null;
    }

    return {
        destination: decodeEscapesAndEntities(out),
        nextIndex: i,
    };
}

function parseLinkTitle(text, startIndex) {
    const quote = text[startIndex];
    if (quote !== '"' && quote !== "'" && quote !== "(") {
        return null;
    }

    const close = quote === "(" ? ")" : quote;
    let i = startIndex + 1;
    let out = "";
    let sawLineEnding = false;

    while (i < text.length) {
        const ch = text[i];
        if (ch === "\\" && i + 1 < text.length) {
            out += ch + text[i + 1];
            if (text[i + 1] === "\n") {
                sawLineEnding = false;
            }
            i += 2;
            continue;
        }
        if (ch === "\n") {
            if (sawLineEnding) {
                return null;
            }
            sawLineEnding = true;
        } else {
            sawLineEnding = false;
        }
        if (ch === close) {
            return {
                title: decodeEscapesAndEntities(out),
                nextIndex: i + 1,
            };
        }
        out += ch;
        i += 1;
    }

    return null;
}

function parseReferenceDefinitionsFromParagraph(lines, refMap) {
    const source = lines.join("\n");
    let pos = 0;
    let consumedTo = 0;

    function skipSpacesTabs(index) {
        let i = index;
        while (i < source.length && (source[i] === " " || source[i] === "\t")) {
            i += 1;
        }
        return i;
    }

    function skipSpacesTabsWithOneNewline(index) {
        let i = index;
        let consumed = 0;
        let usedNewline = false;

        while (true) {
            const before = i;
            i = skipSpacesTabs(i);
            if (i !== before) {
                consumed += i - before;
            }

            if (!usedNewline && i < source.length && source[i] === "\n") {
                usedNewline = true;
                consumed += 1;
                i += 1;
                continue;
            }
            break;
        }

        return { index: i, consumed };
    }

    while (pos < source.length) {
        const start = pos;
        let i = pos;

        let leading = 0;
        while (i < source.length && leading < 3 && source[i] === " ") {
            i += 1;
            leading += 1;
        }

        if (i >= source.length || source[i] !== "[") {
            break;
        }

        i += 1;
        let label = "";
        let labelClosed = false;

        while (i < source.length) {
            const ch = source[i];
            if (ch === "\\" && i + 1 < source.length) {
                label += source.slice(i, i + 2);
                i += 2;
                continue;
            }
            if (ch === "[") {
                labelClosed = false;
                break;
            }
            if (ch === "]") {
                labelClosed = true;
                i += 1;
                break;
            }
            label += ch;
            i += 1;
        }

        if (!labelClosed || i >= source.length || source[i] !== ":") {
            break;
        }

        if (label.length === 0 || /^[\s\t\n\r\f]*$/.test(label) || label.length > 999) {
            break;
        }

        i += 1;
        const beforeDestination = skipSpacesTabsWithOneNewline(i);
        i = beforeDestination.index;

        const destinationResult = parseLinkDestination(source, i);
        if (!destinationResult) {
            break;
        }
        i = destinationResult.nextIndex;

        let title = "";
        let titleParsed = false;

        function tryParseTitleAt(titleStart) {
            const titleResult = parseLinkTitle(source, titleStart);
            if (!titleResult) {
                return null;
            }
            let end = skipSpacesTabs(titleResult.nextIndex);
            if (end < source.length && source[end] !== "\n") {
                return null;
            }
            return {
                title: titleResult.title,
                nextIndex: titleResult.nextIndex,
            };
        }

        const sameLine = skipSpacesTabs(i);
        if (sameLine > i && sameLine < source.length && (source[sameLine] === '"' || source[sameLine] === "'" || source[sameLine] === "(")) {
            const parsed = tryParseTitleAt(sameLine);
            if (parsed) {
                title = parsed.title;
                i = parsed.nextIndex;
                titleParsed = true;
            }
        }

        if (!titleParsed && sameLine < source.length && source[sameLine] === "\n") {
            const nextLineStart = skipSpacesTabs(sameLine + 1);
            if (nextLineStart < source.length && (source[nextLineStart] === '"' || source[nextLineStart] === "'" || source[nextLineStart] === "(")) {
                const parsed = tryParseTitleAt(nextLineStart);
                if (parsed) {
                    title = parsed.title;
                    i = parsed.nextIndex;
                    titleParsed = true;
                }
            }
        }

        if (!titleParsed) {
            i = sameLine;
        }

        i = skipSpacesTabs(i);
        if (i < source.length && source[i] !== "\n") {
            break;
        }

        if (i < source.length && source[i] === "\n") {
            i += 1;
        }

        const normalized = normalizeReferenceLabel(label);
        if (!refMap.has(normalized)) {
            refMap.set(normalized, {
                destination: destinationResult.destination,
                title,
            });
        }

        consumedTo = i;
        pos = i;

        if (pos === start) {
            break;
        }
    }

    if (consumedTo === 0) {
        return 0;
    }

    let consumedLines = 0;
    for (let i = 0; i < consumedTo; i += 1) {
        if (source[i] === "\n") {
            consumedLines += 1;
        }
    }
    if (consumedTo > 0 && source[consumedTo - 1] !== "\n") {
        consumedLines += 1;
    }

    return consumedLines;
}

function findMatchingBracket(text, start) {
    let depth = 0;
    let i = start + 1;

    while (i < text.length) {
        const ch = text[i];

        if (ch === "\\") {
            i += 2;
            continue;
        }

        if (ch === "`") {
            let run = 1;
            while (i + run < text.length && text[i + run] === "`") {
                run += 1;
            }
            const marker = "`".repeat(run);
            const next = text.indexOf(marker, i + run);
            if (next === -1) {
                i += run;
            } else {
                i = next + run;
            }
            continue;
        }

        if (ch === "<") {
            const parsed = parseAutolinkOrHtml(text, i);
            if (parsed) {
                i = parsed.nextIndex;
                continue;
            }
        }

        if (ch === "[") {
            depth += 1;
            i += 1;
            continue;
        }

        if (ch === "]") {
            if (depth === 0) {
                return i;
            }
            depth -= 1;
            i += 1;
            continue;
        }

        i += 1;
    }

    return -1;
}

function parseInlineLinkSuffix(text, start) {
    if (text[start] !== "(") {
        return null;
    }

    let pos = start + 1;
    let lineBreaks = 0;

    while (pos < text.length && (text[pos] === " " || text[pos] === "\t" || text[pos] === "\n")) {
        if (text[pos] === "\n") {
            lineBreaks += 1;
            if (lineBreaks > 1) {
                return null;
            }
        }
        pos += 1;
    }

    let destination = "";
    if (text[pos] === ")") {
        destination = "";
    } else {
        const destinationResult = parseLinkDestination(text, pos);
        if (!destinationResult) {
            return null;
        }
        destination = destinationResult.destination;
        pos = destinationResult.nextIndex;
    }

    let title = "";

    let sawSeparator = false;
    lineBreaks = 0;
    let afterDestination = pos;
    while (afterDestination < text.length && (text[afterDestination] === " " || text[afterDestination] === "\t" || text[afterDestination] === "\n")) {
        if (text[afterDestination] === "\n") {
            lineBreaks += 1;
            if (lineBreaks > 1) {
                break;
            }
        }
        sawSeparator = true;
        afterDestination += 1;
    }

    if (sawSeparator) {
        const titleResult = parseLinkTitle(text, afterDestination);
        if (titleResult) {
            title = titleResult.title;
            pos = titleResult.nextIndex;
        }
    }

    while (pos < text.length && (text[pos] === " " || text[pos] === "\t" || text[pos] === "\n")) {
        if (text[pos] === "\n") {
            break;
        }
        pos += 1;
    }

    if (text[pos] !== ")") {
        return null;
    }

    return {
        destination,
        title,
        nextIndex: pos + 1,
    };
}

function parseReferenceLabel(text, start) {
    if (text[start] !== "[") {
        return null;
    }

    let i = start + 1;
    let out = "";

    while (i < text.length) {
        if (text[i] === "\\" && i + 1 < text.length) {
            out += text[i] + text[i + 1];
            i += 2;
            continue;
        }
        if (text[i] === "[") {
            return null;
        }
        if (text[i] === "]") {
            if (/^[\s\t\n\r\f]*$/.test(out) || out.length > 999) {
                return null;
            }
            return {
                label: out,
                nextIndex: i + 1,
            };
        }
        out += text[i];
        i += 1;
    }

    return null;
}

function parseAutolinkOrHtml(text, index) {
    if (text[index] !== "<") {
        return null;
    }

    const close = text.indexOf(">", index + 1);
    if (close !== -1) {
        const insideSimple = text.slice(index + 1, close);
        const uriRegex = /^[A-Za-z][A-Za-z0-9+.-]{1,31}:[^\u0000-\u0020<>]*$/;
        if (uriRegex.test(insideSimple)) {
            return {
                node: {
                    type: "link",
                    destination: insideSimple,
                    title: "",
                    children: [{ type: "literal_text", literal: decodeEntitiesOnly(insideSimple) }],
                },
                nextIndex: close + 1,
            };
        }

        const emailRegex = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
        if (emailRegex.test(insideSimple)) {
            return {
                node: {
                    type: "link",
                    destination: `mailto:${insideSimple}`,
                    title: "",
                    children: [{ type: "text", literal: insideSimple }],
                },
                nextIndex: close + 1,
            };
        }
    }

    if (text.startsWith("<!-->", index)) {
        return {
            node: { type: "html_inline", literal: "<!-->" },
            nextIndex: index + 5,
        };
    }

    if (text.startsWith("<!--->", index)) {
        return {
            node: { type: "html_inline", literal: "<!--->" },
            nextIndex: index + 6,
        };
    }

    let end = -1;

    if (text.startsWith("<!--", index)) {
        const found = text.indexOf("-->", index + 4);
        if (found === -1) {
            return null;
        }
        end = found + 3;
    } else if (text.startsWith("<?", index)) {
        const found = text.indexOf("?>", index + 2);
        if (found === -1) {
            return null;
        }
        end = found + 2;
    } else if (text.startsWith("<![CDATA[", index)) {
        const found = text.indexOf("]]>", index + 9);
        if (found === -1) {
            return null;
        }
        end = found + 3;
    } else if (text.startsWith("<!", index)) {
        const found = text.indexOf(">", index + 2);
        if (found === -1) {
            return null;
        }
        end = found + 1;
    } else {
        let i = index + 1;
        let quote = "";
        while (i < text.length) {
            const ch = text[i];
            if (quote) {
                if (ch === quote) {
                    quote = "";
                }
                i += 1;
                continue;
            }
            if (ch === '"' || ch === "'") {
                quote = ch;
                i += 1;
                continue;
            }
            if (ch === ">") {
                end = i + 1;
                break;
            }
            i += 1;
        }
        if (end === -1) {
            return null;
        }
    }

    const literal = text.slice(index, end);
    const inside = literal.slice(1, -1);

    if (inside.startsWith("!--") || inside.startsWith("?") || inside.startsWith("![CDATA[") || /^![A-Za-z]/.test(inside)) {
        return {
            node: {
                type: "html_inline",
                literal,
            },
            nextIndex: end,
        };
    }

    const tagName = "[A-Za-z][A-Za-z0-9-]*";
    const attrName = "[A-Za-z_:][A-Za-z0-9_.:-]*";
    const ws = "[ \\t\\n]";
    const optWs = `${ws}*`;
    const attrValue = "(?:[^ \\t\\n\"'=<>`]+|\\\"[^\\\"]*\\\"|'[^']*')";
    const attr = `(?:${ws}+${attrName}(?:${optWs}=${optWs}${attrValue})?)`;
    const openTagRegex = new RegExp(`^${tagName}${attr}*${optWs}\\/?$`);
    const closeTagRegex = new RegExp(`^\\/${tagName}${optWs}$`);

    if (!openTagRegex.test(inside) && !closeTagRegex.test(inside)) {
        return null;
    }

    return {
        node: {
            type: "html_inline",
            literal,
        },
        nextIndex: end,
    };
}

function parseCodeSpan(text, index) {
    if (text[index] !== "`") {
        return null;
    }

    if (index > 0 && text[index - 1] === "`") {
        return null;
    }

    let run = 1;
    while (index + run < text.length && text[index + run] === "`") {
        run += 1;
    }

    const marker = "`".repeat(run);
    let search = index + run;
    let matchIndex = -1;
    while (search < text.length) {
        const candidate = text.indexOf(marker, search);
        if (candidate === -1) {
            break;
        }
        const before = text[candidate - 1];
        const after = text[candidate + run];
        if (before !== "`" && after !== "`") {
            matchIndex = candidate;
            break;
        }
        search = candidate + 1;
    }

    if (matchIndex === -1) {
        return null;
    }

    let literal = text.slice(index + run, matchIndex).replace(/\n/g, " ");
    if (/^ .+ $/.test(literal) && /[^ ]/.test(literal)) {
        literal = literal.slice(1, -1);
    }

    return {
        node: {
            type: "code",
            literal,
        },
        nextIndex: matchIndex + run,
    };
}

function createTextNode(literal) {
    return {
        type: "text",
        literal,
    };
}

function createLiteralNode(literal) {
    return {
        type: "literal_text",
        literal,
    };
}

function appendText(nodes, literal) {
    if (!literal) {
        return;
    }
    const last = nodes[nodes.length - 1];
    if (last && last.type === "text") {
        last.literal += literal;
    } else {
        nodes.push(createTextNode(literal));
    }
}

function appendLiteral(nodes, literal) {
    if (!literal) {
        return;
    }
    const last = nodes[nodes.length - 1];
    if (last && last.type === "literal_text") {
        last.literal += literal;
    } else {
        nodes.push(createLiteralNode(literal));
    }
}

function parseInlineTokens(text, references, state) {
    const nodes = [];
    let i = 0;

    while (i < text.length) {
        const ch = text[i];

        if (ch === "\\") {
            if (i + 1 < text.length && text[i + 1] === "\n") {
                nodes.push({ type: "linebreak" });
                i += 2;
                while (i < text.length && (text[i] === " " || text[i] === "\t")) {
                    i += 1;
                }
                continue;
            }
            if (i + 1 < text.length && ESCAPABLE.has(text[i + 1])) {
                appendLiteral(nodes, text[i + 1]);
                i += 2;
                continue;
            }
            appendText(nodes, "\\");
            i += 1;
            continue;
        }

        if (ch === "`") {
            const codeResult = parseCodeSpan(text, i);
            if (codeResult) {
                nodes.push(codeResult.node);
                i = codeResult.nextIndex;
                continue;
            }
        }

        if (ch === "<") {
            const auto = parseAutolinkOrHtml(text, i);
            if (auto) {
                nodes.push(auto.node);
                i = auto.nextIndex;
                continue;
            }
        }

        if (ch === "!" && i + 1 < text.length && text[i + 1] === "[") {
            const linkResult = parseLinkOrImage(text, i, references, state, true);
            if (linkResult) {
                nodes.push(linkResult.node);
                i = linkResult.nextIndex;
                continue;
            }
        }

        if (ch === "[") {
            const linkResult = parseLinkOrImage(text, i, references, state, false);
            if (linkResult) {
                nodes.push(linkResult.node);
                i = linkResult.nextIndex;
                continue;
            }
        }

        if (ch === "&") {
            const semi = text.indexOf(";", i + 1);
            if (semi !== -1) {
                const candidate = text.slice(i, semi + 1);
                const decoded = parseCharRef(candidate);
                if (decoded !== null) {
                    appendLiteral(nodes, decoded);
                    i = semi + 1;
                    continue;
                }
            }
        }

        if (ch === "\n") {
            const last = nodes[nodes.length - 1];
            if (last && (last.type === "text" || last.type === "literal_text")) {
                const trailingSpaces = last.literal.match(/[ ]+$/);
                if (trailingSpaces && trailingSpaces[0].length >= 2) {
                    last.literal = last.literal.slice(0, -trailingSpaces[0].length);
                    nodes.push({ type: "linebreak" });
                } else {
                    if (trailingSpaces && trailingSpaces[0].length > 0) {
                        last.literal = last.literal.slice(0, -trailingSpaces[0].length);
                    }
                    nodes.push({ type: "softbreak" });
                }
            } else {
                nodes.push({ type: "softbreak" });
            }
            i += 1;
            while (i < text.length && (text[i] === " " || text[i] === "\t")) {
                i += 1;
            }
            continue;
        }

        appendText(nodes, ch);
        i += 1;
    }

    return processEmphasisNodes(nodes);
}

function firstCharFromNode(node) {
    if (!node) {
        return null;
    }

    if (node.type === "softbreak" || node.type === "linebreak") {
        return "\n";
    }

    if (typeof node.literal === "string" && node.literal.length > 0) {
        return node.literal[0];
    }

    if (Array.isArray(node.children)) {
        for (const child of node.children) {
            const ch = firstCharFromNode(child);
            if (ch !== null) {
                return ch;
            }
        }
        return "a";
    }

    return "a";
}

function lastCharFromNode(node) {
    if (!node) {
        return null;
    }

    if (node.type === "softbreak" || node.type === "linebreak") {
        return "\n";
    }

    if (typeof node.literal === "string" && node.literal.length > 0) {
        return node.literal[node.literal.length - 1];
    }

    if (Array.isArray(node.children)) {
        for (let i = node.children.length - 1; i >= 0; i -= 1) {
            const ch = lastCharFromNode(node.children[i]);
            if (ch !== null) {
                return ch;
            }
        }
        return "a";
    }

    return "a";
}

function previousCharInTokens(tokens, index) {
    for (let i = index - 1; i >= 0; i -= 1) {
        const token = tokens[i];
        if (token.type === "softbreak" || token.type === "linebreak") {
            return "\n";
        }

        const ch = lastCharFromNode(token);
        if (ch !== null) {
            return ch;
        }
    }
    return "\n";
}

function nextCharInTokens(tokens, index) {
    for (let i = index + 1; i < tokens.length; i += 1) {
        const token = tokens[i];
        if (token.type === "softbreak" || token.type === "linebreak") {
            return "\n";
        }

        const ch = firstCharFromNode(token);
        if (ch !== null) {
            return ch;
        }
    }
    return "\n";
}

function explodeTextNodes(nodes) {
    const tokens = [];

    for (const node of nodes) {
        if (node.type !== "text") {
            tokens.push(node);
            continue;
        }

        let i = 0;
        while (i < node.literal.length) {
            const ch = node.literal[i];
            if (ch !== "*" && ch !== "_") {
                let j = i + 1;
                while (j < node.literal.length && node.literal[j] !== "*" && node.literal[j] !== "_") {
                    j += 1;
                }
                tokens.push({
                    type: "text",
                    literal: node.literal.slice(i, j),
                });
                i = j;
                continue;
            }

            let j = i + 1;
            while (j < node.literal.length && node.literal[j] === ch) {
                j += 1;
            }

            tokens.push({
                type: "delim",
                char: ch,
                runLength: j - i,
                literal: node.literal.slice(i, j),
                canOpen: false,
                canClose: false,
            });
            i = j;
        }
    }

    return tokens;
}

function recalcDelimiterFlags(tokens) {
    for (let i = 0; i < tokens.length; i += 1) {
        const token = tokens[i];
        if (token.type !== "delim") {
            continue;
        }

        const prev = previousCharInTokens(tokens, i);
        const next = nextCharInTokens(tokens, i);

        const leftFlanking = !isWhitespace(next) && (!isPunctuation(next) || isWhitespace(prev) || isPunctuation(prev));
        const rightFlanking = !isWhitespace(prev) && (!isPunctuation(prev) || isWhitespace(next) || isPunctuation(next));

        if (token.char === "*") {
            token.canOpen = leftFlanking;
            token.canClose = rightFlanking;
        } else {
            token.canOpen = leftFlanking && (!rightFlanking || isPunctuation(prev));
            token.canClose = rightFlanking && (!leftFlanking || isPunctuation(next));
        }
    }
}

function tokenToNode(token) {
    if (token.type === "text") {
        return createTextNode(token.literal);
    }
    if (token.type === "literal_text") {
        return createLiteralNode(token.literal);
    }
    if (token.type === "delim") {
        return createTextNode(token.literal);
    }
    return token;
}

function normalizeNodeArray(nodes) {
    const out = [];
    for (const node of nodes) {
        if (!node) {
            continue;
        }
        if ((node.type === "text" || node.type === "literal_text") && node.literal.length === 0) {
            continue;
        }
        const last = out[out.length - 1];
        if (last && (last.type === "text" || last.type === "literal_text") && (node.type === "text" || node.type === "literal_text")) {
            last.literal += node.literal;
            if (last.type !== node.type) {
                last.type = "text";
            }
        } else {
            out.push(node);
        }
    }
    return out;
}

function processEmphasisNodes(nodes) {
    let tokens = explodeTextNodes(nodes);
    recalcDelimiterFlags(tokens);

    let changed = true;
    while (changed) {
        changed = false;

        for (let closerIndex = 0; closerIndex < tokens.length; closerIndex += 1) {
            const closer = tokens[closerIndex];
            if (!closer || closer.type !== "delim" || !closer.canClose) {
                continue;
            }

            for (let openerIndex = closerIndex - 1; openerIndex >= 0; openerIndex -= 1) {
                const opener = tokens[openerIndex];
                if (!opener || opener.type !== "delim") {
                    continue;
                }
                if (opener.char !== closer.char || !opener.canOpen) {
                    continue;
                }

                if ((opener.canClose || closer.canOpen) && ((opener.runLength + closer.runLength) % 3 === 0) && !(opener.runLength % 3 === 0 && closer.runLength % 3 === 0)) {
                    continue;
                }

                const useLength = opener.runLength >= 2 && closer.runLength >= 2 ? 2 : 1;

                opener.runLength -= useLength;
                closer.runLength -= useLength;
                opener.literal = opener.char.repeat(opener.runLength);
                closer.literal = closer.char.repeat(closer.runLength);

                const innerTokens = tokens.slice(openerIndex + 1, closerIndex).map(tokenToNode);
                const emphNode = {
                    type: useLength === 2 ? "strong" : "emph",
                    children: normalizeNodeArray(innerTokens),
                };

                tokens.splice(openerIndex + 1, closerIndex - openerIndex - 1, emphNode);
                const newCloserIndex = openerIndex + 2;

                if (tokens[newCloserIndex] && tokens[newCloserIndex].type === "delim" && tokens[newCloserIndex].runLength === 0) {
                    tokens.splice(newCloserIndex, 1);
                }
                if (tokens[openerIndex] && tokens[openerIndex].type === "delim" && tokens[openerIndex].runLength === 0) {
                    tokens.splice(openerIndex, 1);
                }

                recalcDelimiterFlags(tokens);
                changed = true;
                break;
            }

            if (changed) {
                break;
            }
        }
    }

    return normalizeNodeArray(tokens.map(tokenToNode));
}

function containsLinkNode(nodes) {
    for (const node of nodes) {
        if (node.type === "link") {
            return true;
        }
        if (node.children && containsLinkNode(node.children)) {
            return true;
        }
    }
    return false;
}

function parseLinkOrImage(text, index, references, state, image) {
    const opener = image ? "![" : "[";
    if (!text.startsWith(opener, index)) {
        return null;
    }

    if (!image && state.inLink) {
        return null;
    }

    const labelStart = index + opener.length - 1;
    const close = findMatchingBracket(text, labelStart);
    if (close === -1) {
        return null;
    }

    const labelText = text.slice(labelStart + 1, close);
    const after = close + 1;

    let destination = "";
    let title = "";
    let nextIndex = after;

    const inlineSuffix = parseInlineLinkSuffix(text, after);
    if (inlineSuffix) {
        destination = inlineSuffix.destination;
        title = inlineSuffix.title;
        nextIndex = inlineSuffix.nextIndex;
    } else if (text.startsWith("[]", after)) {
        const normalizedCollapsed = normalizeReferenceLabel(labelText);
        const ref = references.get(normalizedCollapsed);
        if (!ref) {
            return null;
        }
        destination = ref.destination;
        title = ref.title;
        nextIndex = after + 2;
    } else if (text[after] === "[") {
        const refLabel = parseReferenceLabel(text, after);
        if (!refLabel) {
            return null;
        }
        const normalizedFull = normalizeReferenceLabel(refLabel.label);
        const ref = references.get(normalizedFull);
        if (!ref) {
            return null;
        }
        destination = ref.destination;
        title = ref.title;
        nextIndex = refLabel.nextIndex;
    } else {
        const normalizedShortcut = normalizeReferenceLabel(labelText);
        const ref = references.get(normalizedShortcut);
        if (!ref) {
            return null;
        }
        destination = ref.destination;
        title = ref.title;
        nextIndex = after;
    }

    const previewChildren = parseInlineTokens(labelText, references, {
        inLink: false,
    });

    if (!image && containsLinkNode(previewChildren)) {
        return null;
    }

    const children = image
        ? parseInlineTokens(labelText, references, {
            inLink: state.inLink || !image,
        })
        : previewChildren;

    return {
        node: {
            type: image ? "image" : "link",
            destination,
            title,
            children,
        },
        nextIndex,
    };
}

function parseInlines(text, references, state) {
    return parseInlineTokens(text, references, state || { inLink: false });
}

function parseParagraph(lines, start, references) {
    const paragraphLines = [];
    let i = start;

    while (i < lines.length) {
        const rawLine = lines[i];
        let lazyDepth = 0;
        while (lazyDepth < rawLine.length && rawLine[lazyDepth] === LAZY_PREFIX) {
            lazyDepth += 1;
        }
        const isLazy = lazyDepth > 0;
        const line = isLazy ? rawLine.slice(lazyDepth) : rawLine;
        if (isBlank(line)) {
            break;
        }

        if (paragraphLines.length > 0 && !isLazy) {
            if (parseAtxHeading(line)) {
                break;
            }
            if (parseThematicBreak(line)) {
                break;
            }
            if (parseFenceStart(line)) {
                break;
            }
            if (parseBlockQuoteMarker(line)) {
                break;
            }
            const listMarker = parseListMarker(line);
            if (
                listMarker &&
                !isBlank(listMarker.firstContent) &&
                (listMarker.listType === "bullet" || listMarker.start === 1)
            ) {
                break;
            }
            const htmlType = parseHtmlBlockStart(line, true);
            if (htmlType > 0 && htmlType !== 7) {
                break;
            }
        }

        paragraphLines.push(line);
        i += 1;

        if (i < lines.length && parseSetextUnderline(lines[i])) {
            break;
        }
    }

    const setextLevel = i < lines.length ? parseSetextUnderline(lines[i]) : 0;

    const consumedDefs = parseReferenceDefinitionsFromParagraph(paragraphLines, references);
    const remainderLines = paragraphLines.slice(consumedDefs);

    if (remainderLines.length > 0 && setextLevel) {
        const headingText = remainderLines.join("\n").replace(/^[ \t]+|[ \t]+$/g, "");
        return {
            block: {
                type: "heading",
                level: setextLevel,
                inlineSource: headingText,
            },
            nextIndex: i + 1,
        };
    }

    if (remainderLines.length === 0) {
        return {
            block: null,
            nextIndex: start + paragraphLines.length,
        };
    }

    const text = remainderLines.join("\n").replace(/^[ \t]+|[ \t]+$/g, "");
    return {
        block: {
            type: "paragraph",
            inlineSource: text,
        },
        nextIndex: start + paragraphLines.length,
    };
}

function parseIndentedCode(lines, start) {
    const out = [];
    let i = start;

    while (i < lines.length) {
        const line = lines[i];
        if (isBlank(line)) {
            const strippedBlank = removeIndentColumns(line, 4);
            out.push(strippedBlank === null ? "" : strippedBlank);
            i += 1;
            continue;
        }

        const stripped = removeIndentColumns(line, 4);
        if (stripped === null) {
            break;
        }
        out.push(stripped);
        i += 1;
    }

    while (out.length > 0 && out[out.length - 1] === "") {
        out.pop();
    }

    return {
        block: {
            type: "code_block",
            fenced: false,
            info: "",
            literal: out.length > 0 ? `${out.join("\n")}\n` : "",
        },
        nextIndex: i,
    };
}

function parseFencedCode(lines, start) {
    const fence = parseFenceStart(lines[start]);
    if (!fence) {
        return null;
    }

    const content = [];
    let i = start + 1;
    let closed = false;

    while (i < lines.length) {
        if (isFenceEnd(lines[i], fence)) {
            closed = true;
            i += 1;
            break;
        }

        content.push(removeUpToIndentColumns(lines[i], fence.indent));
        i += 1;
    }

    if (!closed && content.length > 0 && content[content.length - 1] === "") {
        content.pop();
    }

    return {
        block: {
            type: "code_block",
            fenced: true,
            info: decodeEscapesAndEntities(fence.info),
            literal: content.length > 0 ? `${content.join("\n")}\n` : "",
        },
        nextIndex: i,
    };
}

function parseHtmlBlock(lines, start, type) {
    const content = [lines[start]];

    if (type >= 1 && type <= 5 && htmlBlockEnded(type, lines[start])) {
        return {
            block: {
                type: "html_block",
                literal: `${content.join("\n")}\n`,
            },
            nextIndex: start + 1,
        };
    }

    let i = start + 1;
    let closed = false;

    while (i < lines.length) {
        if (type === 6 || type === 7) {
            if (isBlank(lines[i])) {
                break;
            }
            content.push(lines[i]);
            i += 1;
            continue;
        }

        content.push(lines[i]);
        if (htmlBlockEnded(type, lines[i])) {
            closed = true;
            i += 1;
            break;
        }
        i += 1;
    }

    if (!closed && type >= 1 && type <= 5 && content.length > 0 && content[content.length - 1] === "") {
        content.pop();
    }

    return {
        block: {
            type: "html_block",
            literal: `${content.join("\n")}\n`,
        },
        nextIndex: i,
    };
}

function parseBlockQuote(lines, start, references) {
    const content = [];
    let i = start;
    let canLazyContinuation = true;

    while (i < lines.length) {
        const marker = parseBlockQuoteMarker(lines[i]);
        if (marker) {
            content.push(marker.rest);

            const stripped = marker.rest;
            const startsParagraphLike =
                !isBlank(stripped) &&
                !parseAtxHeading(stripped) &&
                !parseThematicBreak(stripped) &&
                !parseFenceStart(stripped) &&
                countIndentColumns(stripped).columns < 4 &&
                parseHtmlBlockStart(stripped, true) === 0;
            canLazyContinuation = startsParagraphLike;

            i += 1;
            continue;
        }

        if (isBlank(lines[i])) {
            break;
        }

        if (!canLazyContinuation) {
            break;
        }

        if (
            parseAtxHeading(lines[i]) ||
            parseFenceStart(lines[i]) ||
            parseThematicBreak(lines[i]) ||
            parseListMarker(lines[i]) ||
            parseHtmlBlockStart(lines[i], true) > 0
        ) {
            break;
        }

        content.push(`${LAZY_PREFIX}${lines[i]}`);
        canLazyContinuation = true;
        i += 1;
    }

    return {
        block: {
            type: "block_quote",
            children: parseBlocks(content, references),
        },
        nextIndex: i,
    };
}

function advanceBlockForLooseCheck(lines, start, references) {
    const line = lines[start];

    const htmlType = parseHtmlBlockStart(line, true);
    if (htmlType > 0) {
        return parseHtmlBlock(lines, start, htmlType).nextIndex;
    }

    const fenced = parseFencedCode(lines, start);
    if (fenced) {
        return fenced.nextIndex;
    }

    if (parseAtxHeading(line)) {
        return start + 1;
    }

    const indentInfo = countIndentColumns(line);
    if (indentInfo.columns >= 4) {
        return parseIndentedCode(lines, start).nextIndex;
    }

    if (parseThematicBreak(line)) {
        return start + 1;
    }

    if (parseBlockQuoteMarker(line)) {
        return parseBlockQuote(lines, start, references).nextIndex;
    }

    const list = parseList(lines, start, references);
    if (list) {
        return list.nextIndex;
    }

    return parseParagraph(lines, start, references).nextIndex;
}

function hasTopLevelBlankBetweenBlocks(lines, references) {
    let i = 0;

    while (i < lines.length && isBlank(lines[i])) {
        i += 1;
    }

    while (i < lines.length) {
        const nextIndex = advanceBlockForLooseCheck(lines, i, references);
        if (nextIndex <= i) {
            return false;
        }

        if (nextIndex < lines.length && nextIndex - 1 >= i && isBlank(lines[nextIndex - 1])) {
            return true;
        }

        i = nextIndex;

        let sawBlank = false;
        while (i < lines.length && isBlank(lines[i])) {
            sawBlank = true;
            i += 1;
        }

        if (sawBlank && i < lines.length) {
            return true;
        }
    }

    return false;
}

function parseList(lines, start, references) {
    const firstMarker = parseListMarker(lines[start]);
    if (!firstMarker) {
        return null;
    }

    if (parseThematicBreak(lines[start])) {
        return null;
    }

    const items = [];
    let i = start;
    let loose = false;

    while (i < lines.length) {
        const marker = parseListMarker(lines[i]);
        if (!marker || !isSameListType(marker, firstMarker)) {
            break;
        }

        if (parseThematicBreak(lines[i])) {
            break;
        }

        const itemLines = [];
        const firstContent = marker.firstContent;
        itemLines.push(firstContent);

        let j = i + 1;
        let sawTrailingBlanks = 0;
        let blankBeforeNextItem = false;

        while (j < lines.length) {
            if (isBlank(lines[j])) {
                itemLines.push("");
                sawTrailingBlanks += 1;
                j += 1;
                continue;
            }

            const hadBlankBefore = sawTrailingBlanks > 0;
            sawTrailingBlanks = 0;

            const nextMarker = parseListMarker(lines[j]);
            if (nextMarker && nextMarker.indentColumns < marker.contentIndent) {
                if (hadBlankBefore) {
                    blankBeforeNextItem = true;
                }
                break;
            }

            if (hadBlankBefore && itemLines.length > 0 && itemLines[0] === "") {
                break;
            }

            const stripped = removeIndentColumns(lines[j], marker.contentIndent);
            if (stripped !== null) {
                itemLines.push(stripped);
                j += 1;
                continue;
            }

            if (hadBlankBefore) {
                break;
            }

            if (!parseAtxHeading(lines[j]) && !parseFenceStart(lines[j]) && !parseThematicBreak(lines[j]) && !parseBlockQuoteMarker(lines[j])) {
                itemLines.push(lines[j]);
                j += 1;
                continue;
            }

            break;
        }

        while (itemLines.length > 0 && isBlank(itemLines[itemLines.length - 1])) {
            itemLines.pop();
        }

        const blankBetweenBlocks = hasTopLevelBlankBetweenBlocks(itemLines, references);

        const nextMarkerAfterItem = j < lines.length ? parseListMarker(lines[j]) : null;
        const blankBetweenItems =
            blankBeforeNextItem ||
            (sawTrailingBlanks > 0 && !!nextMarkerAfterItem && isSameListType(nextMarkerAfterItem, firstMarker));

        const itemChildren = parseBlocks(itemLines, references);
        if (blankBetweenBlocks || blankBetweenItems) {
            loose = true;
        }

        items.push({
            type: "item",
            children: itemChildren,
        });

        i = j;
    }

    return {
        block: {
            type: "list",
            listType: firstMarker.listType,
            delimiter: firstMarker.delimiter,
            start: firstMarker.start,
            tight: !loose,
            children: items,
        },
        nextIndex: i,
    };
}

function parseBlocks(lines, references) {
    const blocks = [];
    let i = 0;

    while (i < lines.length) {
        const line = lines[i];

        if (isBlank(line)) {
            i += 1;
            continue;
        }

        const htmlType = parseHtmlBlockStart(line, true);
        if (htmlType > 0) {
            const html = parseHtmlBlock(lines, i, htmlType);
            blocks.push(html.block);
            i = html.nextIndex;
            continue;
        }

        const fenced = parseFencedCode(lines, i);
        if (fenced) {
            blocks.push(fenced.block);
            i = fenced.nextIndex;
            continue;
        }

        const atx = parseAtxHeading(line);
        if (atx) {
            blocks.push({
                type: "heading",
                level: atx.level,
                inlineSource: atx.content,
            });
            i += 1;
            continue;
        }

        const indentInfo = countIndentColumns(line);
        if (indentInfo.columns >= 4) {
            const indentedCode = parseIndentedCode(lines, i);
            blocks.push(indentedCode.block);
            i = indentedCode.nextIndex;
            continue;
        }

        if (parseThematicBreak(line)) {
            blocks.push({ type: "thematic_break" });
            i += 1;
            continue;
        }

        const quote = parseBlockQuoteMarker(line);
        if (quote) {
            const parsedQuote = parseBlockQuote(lines, i, references);
            blocks.push(parsedQuote.block);
            i = parsedQuote.nextIndex;
            continue;
        }

        const list = parseList(lines, i, references);
        if (list) {
            blocks.push(list.block);
            i = list.nextIndex;
            continue;
        }

        const paragraph = parseParagraph(lines, i, references);
        if (paragraph.block) {
            blocks.push(paragraph.block);
        }
        i = paragraph.nextIndex;
    }

    return blocks;
}

function resolveInlineContent(blocks, references) {
    for (const block of blocks) {
        if ((block.type === "paragraph" || block.type === "heading") && typeof block.inlineSource === "string") {
            block.children = parseInlines(block.inlineSource, references, { inLink: false });
            delete block.inlineSource;
            continue;
        }

        if (block.type === "block_quote") {
            resolveInlineContent(block.children, references);
            continue;
        }

        if (block.type === "list") {
            for (const item of block.children) {
                resolveInlineContent(item.children, references);
            }
        }
    }
}

function safeUrl(destination) {
    const lower = destination.trim().toLowerCase();
    if (lower.startsWith("javascript:") || lower.startsWith("vbscript:") || lower.startsWith("file:")) {
        return false;
    }
    if (lower.startsWith("data:") && !/^data:image\/(?:png|gif|jpeg|webp);/i.test(lower)) {
        return false;
    }
    return true;
}

function normalizeUri(uri) {
    try {
        return encodeURI(uri).replace(/%25/g, "%");
    } catch (_error) {
        return uri;
    }
}

function smartText(text) {
    return text
        .replace(/---/g, "\u2014")
        .replace(/--/g, "\u2013")
        .replace(/\.\.\./g, "\u2026");
}

function renderInlineNodes(nodes, rendererOptions) {
    let out = "";

    for (const node of nodes) {
        if (node.type === "text" || node.type === "literal_text") {
            out += escapeHtml(rendererOptions.smart ? smartText(node.literal) : node.literal);
            continue;
        }

        if (node.type === "softbreak") {
            out += rendererOptions.softbreak;
            continue;
        }

        if (node.type === "linebreak") {
            out += "<br />\n";
            continue;
        }

        if (node.type === "code") {
            out += `<code>${escapeHtml(node.literal)}</code>`;
            continue;
        }

        if (node.type === "html_inline") {
            if (rendererOptions.safe) {
                out += "<!-- raw HTML omitted -->";
            } else {
                out += node.literal;
            }
            continue;
        }

        if (node.type === "emph") {
            out += `<em>${renderInlineNodes(node.children, rendererOptions)}</em>`;
            continue;
        }

        if (node.type === "strong") {
            out += `<strong>${renderInlineNodes(node.children, rendererOptions)}</strong>`;
            continue;
        }

        if (node.type === "link") {
            const destination = rendererOptions.safe && !safeUrl(node.destination) ? "" : normalizeUri(node.destination);
            const titlePart = node.title ? ` title="${escapeHtml(node.title)}"` : "";
            out += `<a href="${escapeHtml(destination)}"${titlePart}>${renderInlineNodes(node.children, rendererOptions)}</a>`;
            continue;
        }

        if (node.type === "image") {
            const destination = rendererOptions.safe && !safeUrl(node.destination) ? "" : normalizeUri(node.destination);
            const titlePart = node.title ? ` title="${escapeHtml(node.title)}"` : "";
            const alt = renderPlainText(node.children);
            out += `<img src="${escapeHtml(destination)}" alt="${escapeHtml(alt)}"${titlePart} />`;
            continue;
        }
    }

    return out;
}

function renderPlainText(nodes) {
    let out = "";
    for (const node of nodes) {
        if (node.type === "text" || node.type === "literal_text") {
            out += node.literal;
        } else if (node.children) {
            out += renderPlainText(node.children);
        } else if (node.type === "softbreak" || node.type === "linebreak") {
            out += "\n";
        }
    }
    return out;
}

function renderBlocks(blocks, rendererOptions, inTightList) {
    let out = "";

    for (const block of blocks) {
        if (block.type === "paragraph") {
            const body = renderInlineNodes(block.children, rendererOptions);
            if (inTightList) {
                out += `${body}\n`;
            } else {
                out += `<p>${body}</p>\n`;
            }
            continue;
        }

        if (block.type === "heading") {
            const body = renderInlineNodes(block.children, rendererOptions);
            out += `<h${block.level}>${body}</h${block.level}>\n`;
            continue;
        }

        if (block.type === "thematic_break") {
            out += "<hr />\n";
            continue;
        }

        if (block.type === "code_block") {
            if (block.fenced && block.info) {
                const firstWord = block.info.split(/[ \t]+/, 1)[0];
                if (firstWord.length > 0) {
                    out += `<pre><code class=\"language-${escapeHtml(firstWord)}\">${escapeHtml(block.literal)}</code></pre>\n`;
                    continue;
                }
            }
            out += `<pre><code>${escapeHtml(block.literal)}</code></pre>\n`;
            continue;
        }

        if (block.type === "html_block") {
            if (rendererOptions.safe) {
                out += "<!-- raw HTML omitted -->\n";
            } else {
                out += block.literal;
            }
            continue;
        }

        if (block.type === "block_quote") {
            out += `<blockquote>\n${renderBlocks(block.children, rendererOptions, false)}</blockquote>\n`;
            continue;
        }

        if (block.type === "list") {
            const tag = block.listType === "ordered" ? "ol" : "ul";
            const startAttr = block.listType === "ordered" && block.start !== 1 ? ` start=\"${block.start}\"` : "";
            out += `<${tag}${startAttr}>\n`;
            for (const item of block.children) {
                const lastChild = item.children[item.children.length - 1];
                if (block.tight) {
                    if (item.children.length === 0) {
                        out += "<li></li>\n";
                    } else if (item.children.length === 1 && item.children[0].type === "paragraph") {
                        const body = renderInlineNodes(item.children[0].children, rendererOptions);
                        out += `<li>${body}</li>\n`;
                    } else {
                        if (item.children.length > 1 && item.children[0].type === "paragraph") {
                            const first = renderInlineNodes(item.children[0].children, rendererOptions);
                            let rest = renderBlocks(item.children.slice(1), rendererOptions, true);
                            if (lastChild && lastChild.type === "paragraph" && rest.endsWith("\n")) {
                                rest = rest.slice(0, -1);
                            }
                            out += `<li>${first}\n${rest}</li>\n`;
                        } else {
                            let body = renderBlocks(item.children, rendererOptions, true);
                            if (lastChild && lastChild.type === "paragraph" && body.endsWith("\n")) {
                                body = body.slice(0, -1);
                            }
                            out += `<li>\n${body}</li>\n`;
                        }
                    }
                } else {
                    if (item.children.length === 0) {
                        out += "<li></li>\n";
                    } else {
                        out += "<li>\n";
                        const body = renderBlocks(item.children, rendererOptions, false);
                        out += body;
                        out += "</li>\n";
                    }
                }
            }
            out += `</${tag}>\n`;
            continue;
        }
    }

    return out;
}

class Parser {
    constructor(options) {
        this.options = options || {};
    }

    parse(markdown) {
        const normalized = normalizeInput(markdown);
        const lines = normalized.split("\n");
        const references = new Map();
        const children = parseBlocks(lines, references);
        resolveInlineContent(children, references);

        return {
            type: "document",
            children,
            references,
            parserOptions: this.options,
        };
    }
}

class HtmlRenderer {
    constructor(options) {
        this.options = {
            sourcepos: false,
            safe: false,
            softbreak: "\n",
            smart: false,
            ...(options || {}),
        };
    }

    render(documentNode) {
        const parserSmart = !!(documentNode && documentNode.parserOptions && documentNode.parserOptions.smart);
        const rendererOptions = {
            ...this.options,
            smart: this.options.smart || parserSmart,
        };
        return renderBlocks(documentNode.children || [], rendererOptions, false);
    }
}

module.exports = {
    Parser,
    HtmlRenderer,
};
