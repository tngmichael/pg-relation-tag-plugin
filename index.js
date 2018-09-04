const debugFactory = require("debug");

const debug = debugFactory("graphile-build-pg");

function PgRelationTagPlugin(builder, options) {
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
    const relation = {};

    if (table.tags.foreignKey && table.tags.foreignKey !== true) {
      // TODO what if array
      const matches = table.tags.foreignKey.match(
        /^\((.+)\) references ([^(]+)(?:\((.+)\)|)$/
      );
      if (!matches) {
        throw new Error(
          `Could not accept @foreignKey parameter '${table.tags.foreignKey}'!`
        );
      }
      const [, rawAttrs, relationRef, rawRefAttrs] = matches;
      const { namespaceName, entityName } = pgParseIdentifier(relationRef);

      const attrs = rawAttrs.split(",").map(a => a.trim());
      if (!attrs[0]) {
        throw new Error(
          `Could not accept @foreignKey parameter '${rawAttrs}'!`
        );
      }
      const foreignAttrs = rawRefAttrs
        ? rawRefAttrs.split(",").map(a => a.trim())
        : [rawRefAttrs];
      if (attrs.length !== foreignAttrs.length) {
        throw new Error(
          `Could not accept @foreignKey parameter '${rawRefAttrs}'!`
        );
      }

      const originKeys = attrs.map(attr =>
        table.attributes.find(a => a.name === attr)
      );
      if (!originKeys.length) {
        throw new Error(
          `Could not find '${rawAttrs}' within table '${table.namespaceName}.${
            table.name
          }'!`
        );
      }

      // TODO should check attr.aclSelectable otherwise an error might occur
      // TODO redundant
      const gqlTableType = pgGetGqlTypeByTypeIdAndModifier(table.type.id, null);

      const tableTypeName = gqlTableType.name;
      if (!gqlTableType) {
        debug(`Could not determine type for table with id ${table.type.id}!`);
        return fields;
      }

      const foreignTable = introspectionResultsByKind.class.find(
        table =>
          table.name === entityName && table.namespaceName === namespaceName
      );
      if (!foreignTable) {
        // TODO not informative
        throw new Error(
          `Could not find the foreign table '${namespaceName}.${entityName}'!`
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

      const foreignKeys = foreignAttrs.map(attr =>
        foreignTable.attributes.find(a => a.name === (attr || "id"))
      );
      if (!foreignKeys.every(_ => _)) {
        throw new Error(`Could not find key columns!`);
      }

      const constraints = introspectionResultsByKind.constraint.filter(
        con =>
          con.classId === foreignTable.id &&
          (foreignAttrs[0]
            ? con.type === "p" || con.type === "u"
            : con.type === "p") &&
          con.keyAttributeNums.toString() ===
            foreignKeys.map(k => k.num).toString()
      );
      if (!constraints.length) {
        throw new Error(
          `Could not find unique column that reference to '${rawRefAttrs}'!`
        );
      }

      const key = originKeys.map(a => a.name).join(".");
      relation[key] = {
        tableTypeName,
        originKeys,
        foreignKeys,
        foreignSchema,
        foreignTable,
        foreignTableTypeName,
        gqlForeignTableType
      };
    }

    const attributes = table.attributes
      .filter(attr => attr.tags.references)
      .sort((a, b) => a.num - b.num);

    if (attributes.length) {
      // TODO should check attr.aclSelectable otherwise an error might occur
      // TODO redundant
      const gqlTableType = pgGetGqlTypeByTypeIdAndModifier(table.type.id, null);
      const tableTypeName = gqlTableType.name;
      if (!gqlTableType) {
        debug(`Could not determine type for table with id ${table.type.id}`);
        return fields;
      }

      attributes.reduce((memo, attr) => {
        if (!memo[attr.name]) {
          if (!attr.tags.references || attr.tags.references === true)
            return memo;
          // NOTE references might be an array
          const references = [].concat(attr.tags.references)[0];
          const matches = references.match(/^([^(]+)(?:\(\W*([^"]+)\W*\)|)$/);
          if (!matches) {
            throw new Error(
              `Could not accept @references parameter '${references}'`
            );
          }

          const [, relationRef, attrRef] = matches;
          const { namespaceName, entityName } = pgParseIdentifier(relationRef);

          const foreignTable = introspectionResultsByKind.class.find(
            table =>
              table.name === entityName && table.namespaceName === namespaceName
          );
          if (!foreignTable) {
            // TODO not informative
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

          const foreignKey = foreignTable.attributes.find(
            attr => attr.name === (attrRef || "id")
          );
          if (!foreignKey) {
            throw new Error(`Could not find key columns!`);
          }

          const constraints = introspectionResultsByKind.constraint.filter(
            con =>
              con.classId === foreignTable.id &&
              (attrRef
                ? con.type === "p" || con.type === "u"
                : con.type === "p") &&
              con.keyAttributeNums.toString() === foreignKey.num.toString()
          );
          if (!constraints.length) {
            throw new Error(
              `Could not find unique column that reference to '${attrRef}'!`
            );
          }

          memo[attr.name] = {
            tableTypeName,
            originKeys: [attr],
            foreignKeys: [foreignKey],
            foreignSchema,
            foreignTable,
            foreignTableTypeName,
            gqlForeignTableType
          };
        }

        return memo;
      }, relation);
    }

    return extend(
      fields,
      Object.keys(relation).reduce((memo, key) => {
        const {
          tableTypeName,
          originKeys,
          foreignKeys,
          foreignSchema,
          foreignTable,
          foreignTableTypeName,
          gqlForeignTableType
        } = relation[key];

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
