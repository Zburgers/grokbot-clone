#!/usr/bin/env node
// Usage: node scripts/hash-password.mjs < password-file   (or: printf %s 'pw' | node scripts/hash-password.mjs)
// Prints an OWNER_PASSWORD_HASH value: scrypt$<salt hex>$<key hex>
import { randomBytes, scryptSync } from 'node:crypto';

let pw = '';
for await (const chunk of process.stdin) pw += chunk;
pw = pw.replace(/\r?\n$/, '');
if (pw.length < 8) { console.error('password must be at least 8 characters'); process.exit(1); }
const salt = randomBytes(16);
console.log(`scrypt$${salt.toString('hex')}$${scryptSync(pw, salt, 32).toString('hex')}`);
