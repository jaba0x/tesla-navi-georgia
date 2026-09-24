#!/usr/bin/env node
/**
 * Creates an account, or changes the password on one.
 *
 *   node tools/adduser.mjs jaba
 *
 * The password is typed here and never stored. What the script writes is one
 * SQL statement containing only the PBKDF2 hash, which you then run against D1
 * and delete. Nothing sensitive ends up in a file that gets committed.
 */
import { writeFileSync } from 'node:fs';
import readline from 'node:readline';
import { hashPassword } from '../src/accounts.js';

const OUT = '.adduser.sql';

// Short, because there is no public sign-up and eight wrong tries on a username
// buys a ten minute lock-out, which makes guessing one over the network hopeless.
// What it leaves exposed is offline cracking if the database itself ever leaks.
const MIN_LENGTH = 6;

const interactive = Boolean(process.stdin.isTTY);
let rl = null;
let lines = null;

// Piped input arrives in one go and readline hands out its lines faster than a
// sequence of awaits can claim them, so the answers get read up front instead.
async function pipedLines() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString().split(/\r?\n/);
}

async function ask(question, hidden = false) {
  if (!interactive) {
    if (!lines) lines = await pipedLines();
    const answer = lines.shift() ?? '';
    process.stdout.write(question + (hidden ? '' : answer) + '\n');
    return answer;
  }
  if (!rl) rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  return new Promise((resolve) => {
    const redraw = () => process.stdout.write(
      '\u001b[2K\u001b[200D' + question + '*'.repeat(rl.line.length),
    );
    if (hidden) process.stdin.on('data', redraw);
    rl.question(question, (answer) => {
      if (hidden) {
        process.stdin.removeListener('data', redraw);
        process.stdout.write('\n');
      }
      resolve(answer);
    });
  });
}

function fail(message) {
  console.error(message);
  if (rl) rl.close();
  process.exit(1);
}

const username = (process.argv[2] || await ask('Username: ')).trim().toLowerCase();
if (!/^[a-z0-9._-]{2,40}$/.test(username)) {
  fail('Username: 2 to 40 characters, letters, digits, dot, dash or underscore.');
}

const password = await ask(`Password for ${username}: `, true);
if (password.length < MIN_LENGTH) fail(`Use at least ${MIN_LENGTH} characters.`);
if (password !== await ask('Again: ', true)) fail('Those did not match.');
if (rl) rl.close();

const pw = await hashPassword(password);
writeFileSync(OUT, `INSERT INTO users (username, pw, created)
VALUES ('${username}', '${pw}', ${Date.now()})
ON CONFLICT(username) DO UPDATE SET pw = excluded.pw;
`);

console.log(`
Written to ${OUT} — it holds the hash, not the password.

  npx wrangler d1 execute geodrive-inbox --remote --file=${OUT} && rm ${OUT}

Changing a password this way leaves old sessions valid. To sign everyone out:

  npx wrangler d1 execute geodrive-inbox --remote --command "DELETE FROM sessions"
`);
