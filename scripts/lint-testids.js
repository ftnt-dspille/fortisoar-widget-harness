#!/usr/bin/env node
'use strict';
// Fails if any element in widgets-src/**/*.html has ng-click / ng-submit
// without a data-testid (or ng-attr-data-testid) on the same element.
//
// Pass a widget name as the first arg to scope the scan, e.g.
//   node scripts/lint-testids.js fsrPlaybookBuilder
// otherwise all widgets under widgets-src/ are scanned.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', 'widgets-src');
const scope = process.argv[2] || null;

function walk(dir, out) {
    if (!fs.existsSync(dir)) return out;
    let st;
    try { st = fs.statSync(dir); } catch (e) { return out; }
    if (!st.isDirectory()) return out;
    for (const name of fs.readdirSync(dir)) {
        const p = path.join(dir, name);
        let cst;
        try { cst = fs.statSync(p); } catch (e) { continue; }
        if (cst.isDirectory()) walk(p, out);
        else if (p.endsWith('.html')) out.push(p);
    }
    return out;
}

const roots = scope ? [path.join(ROOT, scope)] : (fs.existsSync(ROOT) ? fs.readdirSync(ROOT).map(d => path.join(ROOT, d)) : []);
const files = roots.flatMap(r => walk(r, []));

const TAG_RE = /<([a-zA-Z][a-zA-Z0-9-]*)\b([^>]*)>/g;
const violations = [];

for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    let m;
    while ((m = TAG_RE.exec(text)) !== null) {
        const attrs = m[2];
        const hasHandler = /\bng-(click|submit)\s*=/.test(attrs);
        if (!hasHandler) continue;
        const hasTestId = /\b(data-testid|ng-attr-data-testid)\s*=/.test(attrs);
        if (hasTestId) continue;
        const line = text.slice(0, m.index).split('\n').length;
        violations.push({ file: path.relative(process.cwd(), file), line, tag: m[1] });
    }
}

if (violations.length) {
    console.error('lint-testids: elements with ng-click/ng-submit missing data-testid:');
    for (const v of violations) console.error(`  ${v.file}:${v.line}  <${v.tag}>`);
    process.exit(1);
}

console.log(`lint-testids: ok (${files.length} html files scanned)`);
