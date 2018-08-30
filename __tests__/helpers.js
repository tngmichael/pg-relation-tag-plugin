const pg = require("pg");
const { readFile } = require("fs");
const pgConnectionString = require("pg-connection-string");

function readFilePromise(filename, encoding) {
  return new Promise((resolve, reject) => {
    readFile(filename, encoding, (err, res) => {
      if (err) reject(err);
      else resolve(res);
    });
  });
}

const withPgClient = async (url, fn) => {
  if (!fn) {
    fn = url;
    url = process.env.TEST_DATABASE_URL;
  }
  const pgPool = new pg.Pool(pgConnectionString.parse(url));
  let client;
  try {
    client = await pgPool.connect();
    await client.query("begin");
    const result = await fn(client);
    await client.query("rollback");
    return result;
  } finally {
    try {
      await client.release();
    } catch (e) {
      console.error("Error releasing pgClient", e);
    }
    await pgPool.end();
  }
};

exports.withPgClient = withPgClient;
