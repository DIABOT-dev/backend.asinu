'use strict';

const fs = require('fs');
const tls = require('tls');

function databaseOptions(connectionString, env = process.env) {
  if (env.DB_TLS_REQUIRE && !['true', 'false'].includes(env.DB_TLS_REQUIRE)) throw new Error('DB_TLS_REQUIRE must be true or false');
  if (env.DB_TLS_REQUIRE !== 'true') return { connectionString };
  if (!env.DB_TLS_CA_FILE) throw new Error('DB_TLS_CA_FILE is required when DB_TLS_REQUIRE=true');
  const url = new URL(connectionString);
  // node-postgres URI SSL settings can replace the explicit ssl object.
  for (const name of url.searchParams.keys()) {
    if (name.toLowerCase().startsWith('ssl')) throw new Error('Remove SSL URI parameters; use DB_TLS_REQUIRE and DB_TLS_CA_FILE');
  }
  return {
    connectionString,
    ssl: {
      ca: fs.readFileSync(env.DB_TLS_CA_FILE, 'utf8'),
      rejectUnauthorized: true,
      // pg omits SNI for IP hosts. Always verify the configured DB host,
      // rather than letting tls.connect default to checking "localhost".
      checkServerIdentity: (_servername, cert) => tls.checkServerIdentity(url.hostname, cert),
    },
  };
}

module.exports = { databaseOptions };
