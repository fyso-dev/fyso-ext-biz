// Prints a fresh `framework_access` access token for the framework's distribution commands
// (FYSO_DIST_BIZ_TOKEN_CMD). Nothing but the token goes to stdout; failures print a code only.
const auth = require('./auth.cjs');

if (require.main === module) {
  auth.store().profileAccessToken().then(token => process.stdout.write(`${token}\n`)).catch(error => {
    console.error(`Fyso Biz: ${error.message === 'not_connected' ? 'not_connected' : 'connection_failed'}`);
    process.exitCode = 1;
  });
}
