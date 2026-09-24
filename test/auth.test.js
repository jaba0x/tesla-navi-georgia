/* Password hashing, the part that must not be wrong.
 * node test/auth.test.js
 */
const path = require('path');

let failures = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`);
}

(async () => {
  const { hashPassword, verifyPassword } =
    await import(path.join(__dirname, '..', 'src', 'accounts.js'));

  const stored = await hashPassword('correct horse battery staple');
  const [scheme, iterations, salt, digest] = stored.split('$');

  check('stored as pbkdf2', scheme, 'pbkdf2');
  check('iteration count is not quietly low', Number(iterations) >= 210000, true);
  check('salt is 16 bytes', Buffer.from(salt, 'base64').length, 16);
  check('digest is 32 bytes', Buffer.from(digest, 'base64').length, 32);

  check('the right password verifies', await verifyPassword('correct horse battery staple', stored), true);
  check('a wrong password does not', await verifyPassword('correct horse battery stapl', stored), false);
  check('an empty password does not', await verifyPassword('', stored), false);

  // The same password must not produce the same stored value twice
  const again = await hashPassword('correct horse battery staple');
  check('salted per account', again === stored, false);
  check('and the second one still verifies', await verifyPassword('correct horse battery staple', again), true);

  // A tampered digest must fail rather than throw
  const bent = `${scheme}$${iterations}$${salt}$${'A'.repeat(digest.length)}`;
  check('a tampered digest fails closed', await verifyPassword('correct horse battery staple', bent), false);
  check('junk in the column fails closed', await verifyPassword('anything', 'not-a-hash'), false);
  check('an unknown scheme fails closed', await verifyPassword('anything', 'md5$1$a$b'), false);

  console.log(failures ? `\n${failures} failing` : '\nall green');
  process.exit(failures ? 1 : 0);
})();
