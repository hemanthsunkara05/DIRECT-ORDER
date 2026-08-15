#!/usr/bin/env node
// docs/09-security.md §15.8: "Only NEXT_PUBLIC_* variables reach the
// browser; a startup assertion fails the build if any other secret
// name appears in the client bundle." Next.js's browser-side
// `process.env` shim only substitutes NEXT_PUBLIC_* keys — a
// server-only var referenced from client code (e.g. a `'use client'`
// component that mistakenly reads `process.env.RAZORPAY_KEY_SECRET`)
// is never assigned a real value in the browser bundle, but its NAME
// survives as literal, unresolved source text in the compiled output.
// That's real evidence of the mistake even though the actual secret
// VALUE never leaks — this scan catches it at build time, not in a
// security review months later.
//
// Runs as apps/web's `postbuild` script, after `next build` has
// written `.next/static/` (the files actually shipped to browsers —
// `.next/server/` runs only on the server and legitimately contains
// these names).

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const STATIC_DIR = join(ROOT, 'apps', 'web', '.next', 'static');

// Every server-only credential this codebase's env schema defines
// (apps/api/src/platform/config/env.schema.ts) — deliberately an
// explicit list, not a pattern match against `.env.example`: a
// derived pattern (e.g. "_URL$") would also flag legitimately public
// config like API_BASE_URL/CDN_BASE_URL, defeating the point.
const SECRET_NAMES = [
  'JWT_SECRET',
  'DATABASE_URL',
  'APP_DATABASE_URL',
  'REDIS_URL',
  'STORAGE_ACCESS_KEY',
  'STORAGE_SECRET_KEY',
  'RAZORPAY_KEY_SECRET',
  'RAZORPAY_WEBHOOK_SECRET',
  'UBER_DIRECT_CLIENT_SECRET',
  'UBER_DIRECT_WEBHOOK_SECRET',
  'MSG91_AUTH_KEY',
  'GUPSHUP_API_KEY',
  'RESEND_API_KEY',
  'SENTRY_DSN',
];

function listJsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) out.push(...listJsFiles(full));
    else if (entry.endsWith('.js')) out.push(full);
  }
  return out;
}

function main() {
  let files;
  try {
    files = listJsFiles(STATIC_DIR);
  } catch (error) {
    console.error(`check-web-bundle-secrets: could not read ${STATIC_DIR} — did \`next build\` run first?`, error);
    process.exit(1);
  }

  const findings = [];
  for (const file of files) {
    const content = readFileSync(file, 'utf8');
    for (const name of SECRET_NAMES) {
      if (content.includes(name)) {
        findings.push({ file, name });
      }
    }
  }

  if (findings.length > 0) {
    console.error('check-web-bundle-secrets: FAILED — secret-looking env var names found in the client bundle:');
    for (const { file, name } of findings) {
      console.error(`  ${name} in ${file}`);
    }
    console.error('\nThese names should never appear in code reachable from a client component.');
    process.exit(1);
  }

  console.log(`check-web-bundle-secrets: OK — scanned ${files.length} client bundle file(s), no secret names found.`);
}

main();
