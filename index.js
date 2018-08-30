const debugFactory = require("debug");

const debug = debugFactory("graphile-build-pg");

const OMIT = 0;
const DEPRECATED = 1;
const ONLY = 2;

function PgRelationTagPlugin(builder, options) {
  const {
    pgLegacyRelations,
    pgSimpleCollections,
    pgSchemas: schemas
  } = options;
  const hasConnections = pgSimpleCollections !== "only";
  const hasSimpleCollections =
    pgSimpleCollections === "only" || pgSimpleCollections === "both";
  const legacyRelationMode =
    {
      only: ONLY,
      deprecated: DEPRECATED
    }[pgLegacyRelations] || OMIT;

  // NOTE forward relation
  builder.hook("GraphQLObjectType:fields", (fields, build, context) => {
    const {
      extend,
      getSafeAliasFromResolveInfo,
      getSafeAliasFromAlias,
      pgGetGqlTypeByTypeIdAndModifier,
      pgIntrospectionResultsByKind: introspectionResultsByKind,
      pgSql: sql,
      inflection,
      graphql: { GraphQLInt },
      pgParseIdentifier,
      pgQueryFromResolveData
    } = build;

    const {
      scope: {
        isPgRowType,
        isMutationPayload,
        pgIntrospection,
        pgIntrospectionTable
      },
      fieldWithHooks,
      Self
    } = context;

    const table = pgIntrospectionTable || pgIntrospection;
    if (
      !(isPgRowType || isMutationPayload) ||
      !table ||
      table.kind !== "class" ||
      !table.namespace
    ) {
      return fields;
    }
    // NOTE This is a relation in which we (table) are local, and there's a foreign table

    const attributes = table.attributes
      .filter(attr => attr.classId === table.id && attr.tags.references)
      .sort((a, b) => a.num - b.num);

    let relation = {};
    if (attributes.length) {
      // TODO should check attr.aclSelectable otherwise an error might occur
      const gqlTableType = pgGetGqlTypeByTypeIdAndModifier(table.type.id, null);
      const tableTypeName = gqlTableType.name;
      if (!gqlTableType) {
        debug(`Could not determine type for table with id ${attr.class.id}`);
        return memo;
      }

      attributes.reduce((memo, attr) => {
        if (!attr.tags.references || attr.tags.references === true) return memo;
        // TODO must test if array
        const tags = [].concat(attr.tags.references);
        tags.forEach(references => {
          const matches = references.match(/^([^(]+)(?:\(\W*([^"]+)\W*\)|)$/);
          if (!matches) {
            throw new Error(
              `Error could not accept @references parameter '${references}'`
            );
          }

          const [, relationRef, attrRef] = matches;
          const { namespaceName, entityName } = pgParseIdentifier(relationRef);
          const key = `${namespaceName}.${entityName}`;

          if (memo[key]) {
            memo[key].originKeys.push(attr);
            memo[key].rawForeignAttributes.push(attrRef);
          } else {
            const foreignTable = introspectionResultsByKind.class.find(
              table =>
                table.name === entityName &&
                table.namespaceName === namespaceName
            );
            if (!foreignTable) {
              // TODO give as much information in this error as possible; e.g. include the table and attribute you're currently looking at and the `references` tag value. More data helps people debug things faster.
              throw new Error(
                `Could not find the foreign table '${namespaceName}.${entityName}'`
              );
            }

            const gqlForeignTableType = pgGetGqlTypeByTypeIdAndModifier(
              foreignTable.type.id,
              null
            );
            const foreignTableTypeName = gqlForeignTableType.name;
            const foreignSchema = introspectionResultsByKind.namespace.find(
              n => n.id === foreignTable.namespaceId
            );

            memo[key] = {
              gqlTableType,
              tableTypeName,
              originKeys: [attr],
              rawForeignAttributes: [attrRef],
              foreignSchema: foreignSchema,
              foreignTable: foreignTable,
              foreignTableTypeName,
              gqlForeignTableType
            };
          }
        });

        return memo;
      }, relation);
    }

    return extend(
      fields,
      Object.keys(relation).reduce((memo, key) => {
        const {
          gqlTableType,
          tableTypeName,
          originKeys,
          rawForeignAttributes,
          foreignSchema,
          foreignTable,
          foreignTableTypeName,
          gqlForeignTableType
        } = relation[key];

        const foreignAttributes = introspectionResultsByKind.attribute
          .filter(attr => attr.classId === foreignTable.id)
          .sort((a, b) => a.num - b.num);

        const foreignKeys = rawForeignAttributes.map(attrRef => {
          const uniqueConstraints = introspectionResultsByKind.constraint.filter(
            con =>
              con.classId === foreignTable.id &&
              (attrRef
                ? con.type === "p" || con.type === "u"
                : con.type === "p")
          );
          if (attrRef) {
            const key = foreignAttributes.find(attr => attr.name === attrRef);
            const isUnique = uniqueConstraints.some(
              constraint =>
                constraint.keyAttributeNums.indexOf(key && key.num) !== -1
            );
            // TODO throw error if not unique
            return isUnique && key;
          } else {
            return (
              uniqueConstraints[0] &&
              foreignAttributes.find(
                attr =>
                  attr.num ===
                  primaryKeyConstraints[0].keyAttributeNums.sort(
                    (a, b) => a - b
                  )[0]
              )
            );
          }
        });

        if (!originKeys.every(_ => _) || !foreignKeys.every(_ => _)) {
          throw new Error("Could not find key columns!");
        }

        const fieldName = inflection.singleRelationByKeys(
          originKeys,
          foreignTable,
          table,
          { tags: {} } // NOTE definitely a hack
        );

        memo[fieldName] = fieldWithHooks(
          fieldName,
          ({ getDataFromParsedResolveInfoFragment, addDataGenerator }) => {
            addDataGenerator(parsedResolveInfoFragment => {
              return {
                pgQuery: queryBuilder => {
                  queryBuilder.select(() => {
                    const resolveData = getDataFromParsedResolveInfoFragment(
                      parsedResolveInfoFragment,
                      gqlForeignTableType
                    );

                    const foreignTableAlias = sql.identifier(Symbol());

                    const query = pgQueryFromResolveData(
                      sql.identifier(foreignSchema.name, foreignTable.name),
                      foreignTableAlias,
                      resolveData,
                      { asJson: true },
                      innerQueryBuilder => {
                        originKeys.forEach((key, i) => {
                          innerQueryBuilder.where(
                            sql.fragment`${queryBuilder.getTableAlias()}.${sql.identifier(
                              key.name
                            )} = ${foreignTableAlias}.${sql.identifier(
                              foreignKeys[i].name
                            )}`
                          );
                        });
                      }
                    );

                    return sql.fragment`(${query})`;
                  }, getSafeAliasFromAlias(parsedResolveInfoFragment.alias));
                }
              };
            });

            return {
              description: `Reads a single \`${foreignTableTypeName}\` that is related to this \`${tableTypeName}\`.`,
              type: gqlForeignTableType,
              resolve: (rawData, _args, _context, resolveInfo) => {
                const data = isMutationPayload ? rawData.data : rawData;
                const safeAlias = getSafeAliasFromResolveInfo(resolveInfo);
                return data[safeAlias];
              }
            };
          },
          {
            isPgForwardRelationField: true
          }
        );

        return memo;
      }, {}),
      `Adding forward relations to '${Self.name}'  with references tag`
    );
  });
}

// NOTE backward relation is reverted, coming soon

module.exports = PgRelationTagPlugin;
