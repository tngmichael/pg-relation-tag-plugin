// ASK how to import queryFromResolveData and omit
// BLOCK import queryFromResolveData from '../queryFromResolveData';
// BLOCK import omit from '../omit';
import debugFactory from 'debug';

const debug = debugFactory('graphile-build-pg');

function PgRelationTagPlugin(builder) {
  // NOTE forward relation
  builder.hook('GraphQLObjectType:fields', (fields, build, context) => {
    const {
      extend,
      getSafeAliasFromResolveInfo,
      getSafeAliasFromAlias,
      pgGetGqlTypeByTypeId,
      pgIntrospectionResultsByKind: introspectionResultsByKind,
      pgSql: sql,
      inflection,
      graphql: { GraphQLInt },
    } = build;

    const {
      scope: {
        isPgRowType,
        isMutationPayload,
        pgIntrospection,
        pgIntrospectionTable,
      },
      fieldWithHooks,
      Self,
    } = context;

    const table = pgIntrospectionTable || pgIntrospection;

    if (
      !(isPgRowType || isMutationPayload) ||
      !table ||
      table.kind !== 'class' ||
      !table.namespace
    ) {
      return fields;
    }

    // NOTE instead of constraint use attribute
    // ASK need pgColumnFilter ?
    const attributes = introspectionResultsByKind.attribute
      .filter(attr => attr.classId === table.id)
      .sort((a, b) => a.num - b.num);

    return extend(
      fields,
      attributes.reduce((memo, attr) => {
        // ASK need omit attr here ?
        // if (omit(constraint, 'read')) {
        //   return memo;
        // }

        const gqlTableType = pgGetGqlTypeByTypeId(table.type.id);
        const tableTypeName = gqlTableType.name;

        if (!gqlTableType) {
          // ASK is using attr.class.id right ? before is constraint.classId
          debug(`Could not determine type for table with id ${attr.class.id}`);
          return memo;
        }

        const referencesTag = attr.tags.references;
        if (referencesTag) {
          // ASK what common pattern of schema and table name ?
          const matches = referencesTag.match(
            /^([a-zA-Z_][a-zA-Z0-9_]+).([a-zA-Z_][a-zA-Z0-9_]+)\(([\S]*?)\)$/,
          );
          if (!matches) {
            throw new Error(
              `Error could not accept @references parameter '${referencesTag}'`,
            );
          }
          const [, schemaFromTag, tableFromTag, attrFromTag] = matches;

          // ASK better find by type or class ?
          // const foreignTable = introspectionResultsByKind.type.find(
          //   type =>
          //     type.type === 'c' &&
          //     type.category === 'C' &&
          //     type.namespaceId === table.namespaceId &&
          //     type.namespaceName === 'my' &&
          //     type.name === tableFromTag,
          // );
          const foreignTable = introspectionResultsByKind.class.find(
            table =>
              table.name === tableFromTag &&
              table.namespaceName === schemaFromTag,
          );
          if (!foreignTable) {
            throw new Error(
              `Could not find the foreign table '${schemaFromTag}.${tableFromTag}'`,
            );
          }

          const gqlForeignTableType = pgGetGqlTypeByTypeId(
            foreignTable.type.id,
          );
          const foreignTableTypeName = gqlForeignTableType.name;

          const foreignSchema = introspectionResultsByKind.namespace.filter(
            n => n.id === foreignTable.namespaceId,
          )[0];

          const foreignAttributes = introspectionResultsByKind.attribute
            .filter(attr => attr.classId === foreignTable.id)
            .sort((a, b) => a.num - b.num);

          // ASK as simple as this both ?
          const keys = [attr];
          const foreignKeys = [
            foreignAttributes.find(attr => attr.name === attrFromTag),
          ];

          if (!keys.every(_ => _) || !foreignKeys.every(_ => _)) {
            throw new Error('Could not find key columns!');
          }
          // BLOCK need to import omit
          // if (keys.some(key => omit(key, 'read'))) {
          //   return memo;
          // }
          // if (foreignKeys.some(key => omit(key, 'read'))) {
          //   return memo;
          // }

          const fieldName = inflection.singleRelationByKeys(
            keys,
            foreignTable,
            table,
            { tags: {} }, // NOTE no constraint anymore
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
                        gqlForeignTableType,
                      );

                      const foreignTableAlias = sql.identifier(Symbol());

                      const query = queryFromResolveData(
                        sql.identifier(foreignSchema.name, foreignTable.name),
                        foreignTableAlias,
                        resolveData,
                        { asJson: true },
                        innerQueryBuilder => {
                          keys.forEach((key, i) => {
                            innerQueryBuilder.where(
                              sql.fragment`${queryBuilder.getTableAlias()}.${sql.identifier(
                                key.name,
                              )} = ${foreignTableAlias}.${sql.identifier(
                                foreignKeys[i].name,
                              )}`,
                            );
                          });
                        },
                      );

                      return sql.fragment`(${query})`;
                    }, getSafeAliasFromAlias(parsedResolveInfoFragment.alias));
                  },
                };
              });

              return {
                // NOTE pass description
                description:
                  attr.description ||
                  `Reads a single \`${foreignTableTypeName}\` that is related to this \`${tableTypeName}\`.`,
                type: gqlForeignTableType,
                resolve: (rawData, _args, _context, resolveInfo) => {
                  const data = isMutationPayload ? rawData.data : rawData;
                  const safeAlias = getSafeAliasFromResolveInfo(resolveInfo);
                  return data[safeAlias];
                },
              };
            },
            {
              // ASK is pass attr right ?
              pgFieldIntrospection: attr,
              isPgForwardRelationField: true,
            },
          );
        }

        return memo;
      }, {}),
    );
  });
}

export default PgForwardRelationTagPlugin;
