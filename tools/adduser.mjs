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

function ask(question, hidden = false) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      const onData = (char) => {
        if (['\n', '\r', '\u0004'].includes(String(char))) process.stdin.removeListener('data', onData);
        else process.stdout.write('\u001b[2K\u001b[200D' + question + '*'.repeat(rl.line.length));
      };
      process.stdin.on('data', onData);
    }
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write('\n');
      resolve(answer);
    });
  });
}

const username = (process.argv[2] || await ask('Username: ')).trim().toLowerCase();
if (!/^[a-z0-9._-]{2,40}$/.test(username)) {
  console.error('Username: 2 to 40 characters, letters, digits, dot, dash or underscore.');
  process.exit(1);
}

const password = await ask(`Password for ${username}: `, true);
if (password.length < 10) {
  console.error('Use at least 10 characters. This is the only thing between the internet and the account.');
  process.exit(1);
}
const again = await ask('Again: ', true);
if (password !== again) {
  console.error('Those did not match.');
  process.exit(1);
}

const pw = await hashPassword(password);
const sql = `INSERT INTO users (username, pw, created)
VALUES ('${username}', '${pw}', ${Date.now()})
ON CONFLICT(username) DO UPDATE SET pw = excluded.pw;
`;
writeFileSync(OUT, sql);

console.log(`
Written to ${OUT} — it holds the hash, not the password.

Run it against the live database:

  npx wrangler d1 execute geodrive-inbox --remote --file=${OUT}

Then delete it:

  rm ${OUT}

Changing an existing password this way also leaves old sessions valid. To sign
everyone out as well:

  npx wrangler d1 execute geodrive-inbox --remote --command "DELETE FROM sessions"
`);
