const { graphql } = require("graphql");
const { withPgClient } = require("../helpers");
const { createPostGraphileSchema } = require("postgraphile-core");
const { readdirSync, readFile: rawReadFile } = require("fs");
const { resolve: resolvePath } = require("path");
const { printSchema } = require("graphql/utilities");

function readFile(filename, encoding) {
  return new Promise((resolve, reject) => {
    rawReadFile(filename, encoding, (err, res) => {
      if (err) reject(err);
      else resolve(res);
    });
  });
}

const queriesDir = `${__dirname}/../fixtures/queries`;
const queryFileNames = readdirSync(queriesDir);
let queryResults = [];

const data = () => readFile(`${__dirname}/../p-data.sql`, "utf8");

beforeAll(() => {
  const gqlSchemasPromise = withPgClient(async pgClient => {
    const [normal] = await Promise.all([
      createPostGraphileSchema(pgClient, ["p"], {
        appendPlugins: [require("../../index.js")]
      })
    ]);
    return {
      normal
    };
  });

  const queryResultsPromise = (async () => {
    const gqlSchemas = await gqlSchemasPromise;
    return await withPgClient(async pgClient => {
      await pgClient.query(await data());
      return await Promise.all(
        queryFileNames.map(async fileName => {
          const query = await readFile(
            resolvePath(queriesDir, fileName),
            "utf8"
          );
          const schemas = {
            "p.graphql": gqlSchemas.normal
          };
          const gqlSchema = schemas[fileName]
            ? schemas[fileName]
            : gqlSchemas.normal;
          const result = await graphql(gqlSchema, query, null, {
            pgClient: pgClient
          });
          if (result.errors) {
            console.log(result.errors.map(e => e.originalError));
          }
          return result;
        })
      );
    });
  })();
  queryResults = queryFileNames.map(async (_, i) => {
    return await (await queryResultsPromise)[i];
  });
});

for (let i = 0; i < queryFileNames.length; i++) {
  test(queryFileNames[i], async () => {
    expect(await queryResults[i]).toMatchSnapshot();
  });
}
