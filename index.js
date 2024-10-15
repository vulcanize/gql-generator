#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const program = require('commander');
const { Source, buildSchema } = require('graphql');
const del = require('del');

let destDirPath;
let depthLimit;
let excludeNestedArgs;
let includeDeprecatedFields;

let gqlSchema;
let indexJsExportAll = '';

/**
 * Compile arguments dictionary for a field
 * @param field current field object
 * @param duplicateArgCounts map for deduping argument name collisions
 * @param allArgsDict dictionary of all arguments
 */
const getFieldArgsDict = (
  field,
  duplicateArgCounts,
  allArgsDict = {},
) => {
  const duplicateArgCountsCopy = duplicateArgCounts;
  return field.args.reduce((o, arg) => {
    const oCopy = o;
    if (arg.name in duplicateArgCounts) {
      const index = duplicateArgCounts[arg.name] + 1;
      duplicateArgCountsCopy[arg.name] = index;
      oCopy[`${arg.name}${index}`] = arg;
    } else if (allArgsDict[arg.name]) {
      duplicateArgCountsCopy[arg.name] = 1;
      oCopy[`${arg.name}1`] = arg;
    } else {
      oCopy[arg.name] = arg;
    }
    return oCopy;
  }, {});
};

/**
 * Generate variables string
 * @param dict dictionary of arguments
 */
const getArgsToVarsStr = dict => Object.entries(dict)
  .map(([varName, arg]) => `${arg.name}: $${varName}`)
  .join(', ');

/**
 * Generate types string
 * @param dict dictionary of arguments
 */
const getVarsToTypesStr = dict => Object.entries(dict)
  .map(([varName, arg]) => `$${varName}: ${arg.type}`)
  .join(', ');

/**
 * Generate the query for the specified field
 * @param curName name of the current field
 * @param curParentType parent type of the current field
 * @param curParentName parent name of the current field
 * @param argumentsDict dictionary of arguments from all fields
 * @param duplicateArgCounts map for deduping argument name collisions
 * @param crossReferenceKeyList list of the cross reference
 * @param curDepth current depth of field
 * @param fromUnion adds additional depth for unions to avoid empty child
 */
const generateQuery = (
  curName,
  curParentType,
  curParentName,
  argumentsDict = {},
  duplicateArgCounts = {},
  crossReferenceKeyList = [], // [`${curParentName}To${curName}Key`]
  curDepth = 1,
  fromUnion = false,
) => {
  const field = gqlSchema.getType(curParentType).getFields()[curName];
  const curTypeName = field.type.inspect().replace(/[[\]!]/g, '');
  const curType = gqlSchema.getType(curTypeName);
  let queryStr = '';
  let childQuery = '';

  if (curType.getFields) {
    const crossReferenceKey = `${curParentName}To${curName}Key`;
    if (crossReferenceKeyList.indexOf(crossReferenceKey) !== -1 || (fromUnion ? curDepth - 2 : curDepth) > depthLimit) return '';
    if (!fromUnion) {
      crossReferenceKeyList.push(crossReferenceKey);
    }
    const childKeys = Object.keys(curType.getFields());
    childQuery = childKeys
      .filter((fieldName) => {
        /* Exclude deprecated fields */
        const fieldSchema = gqlSchema.getType(curType).getFields()[fieldName];
        return includeDeprecatedFields || !fieldSchema.isDeprecated;
      })
      .map(cur => generateQuery(cur, curType, curName, argumentsDict, duplicateArgCounts,
        crossReferenceKeyList, curDepth + 1, fromUnion).queryStr)
      .filter(cur => Boolean(cur))
      .join('\n');
  }

  if (!(curType.getFields && !childQuery)) {
    queryStr = `${'    '.repeat(curDepth)}${field.name}`;
    // Skip nested args when curDepth > 1 and excludeNestedArgs set
    if (field.args.length > 0 && (curDepth <= 1 || !excludeNestedArgs)) {
      const dict = getFieldArgsDict(field, duplicateArgCounts, argumentsDict);
      Object.assign(argumentsDict, dict);
      queryStr += `(${getArgsToVarsStr(dict)})`;
    }
    if (childQuery) {
      queryStr += `{\n${childQuery}\n${'    '.repeat(curDepth)}}`;
    }
  }

  /* Union types */
  if (curType.astNode && curType.astNode.kind === 'UnionTypeDefinition') {
    const types = curType.getTypes();
    if (types && types.length) {
      const indent = `${'    '.repeat(curDepth)}`;
      const fragIndent = `${'    '.repeat(curDepth + 1)}`;
      queryStr += '{\n';

      for (let i = 0, len = types.length; i < len; i++) {
        const valueTypeName = types[i];
        const valueType = gqlSchema.getType(valueTypeName);
        const unionChildQuery = Object.keys(valueType.getFields())
          .map(cur => generateQuery(cur, valueType, curName, argumentsDict, duplicateArgCounts,
            crossReferenceKeyList, curDepth + 2, true).queryStr)
          .filter(cur => Boolean(cur))
          .join('\n');

        /* Exclude empty unions */
        if (unionChildQuery) {
          queryStr += `${fragIndent}... on ${valueTypeName} {\n${unionChildQuery}\n${fragIndent}}\n`;
        }
      }
      queryStr += `${indent}}`;
    }
  }
  return { queryStr, argumentsDict };
};

/**
 * Generate the query for the specified field
 * @param obj one of the root objects(Query, Mutation, Subscription)
 * @param description description of the current object
 */
const generateFile = (obj, description) => {
  let indexJs = 'import fs from \'fs\';\nimport path from \'path\';\n\n';
  let outputFolderName;
  switch (description) {
    case 'Mutation':
      outputFolderName = 'mutations';
      break;
    case 'Query':
      outputFolderName = 'queries';
      break;
    case 'Subscription':
      outputFolderName = 'subscriptions';
      break;
    default:
      console.log('[gqlg warning]:', 'description is required');
  }
  const writeFolder = path.join(destDirPath, `./${outputFolderName}`);
  try {
    fs.mkdirSync(writeFolder);
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
  Object.keys(obj).forEach((type) => {
    const field = gqlSchema.getType(description).getFields()[type];
    /* Only process non-deprecated queries/mutations: */
    if (includeDeprecatedFields || !field.isDeprecated) {
      const queryResult = generateQuery(type, description);
      const varsToTypesStr = getVarsToTypesStr(queryResult.argumentsDict);
      let query = queryResult.queryStr;
      query = `${description.toLowerCase()} ${type}${varsToTypesStr ? `(${varsToTypesStr})` : ''}{\n${query}\n}`;
      fs.writeFileSync(path.join(writeFolder, `./${type}.gql`), query);
      indexJs += `export const ${type} = fs.readFileSync(path.join(__dirname, '${type}.gql'), 'utf8');\n`;
    }
  });
  fs.writeFileSync(path.join(writeFolder, 'index.ts'), indexJs);
  indexJsExportAll += `export * as ${outputFolderName} from './${outputFolderName}';\n`;
};

function gqlGenerate(
  typeDef,
  destDirPathArg,
  depthLimitArg,
  excludeNestedArgsArg = false,
  includeDeprecatedFieldsArg = false,
) {
  destDirPath = destDirPathArg;
  depthLimit = depthLimitArg || 100;
  excludeNestedArgs = excludeNestedArgsArg;
  includeDeprecatedFields = includeDeprecatedFieldsArg;

  const source = new Source(typeDef);
  gqlSchema = buildSchema(source);

  del.sync(destDirPath, { force: true });
  path.resolve(destDirPath).split(path.sep).reduce((before, cur) => {
    const pathTmp = path.join(before, cur + path.sep);
    if (!fs.existsSync(pathTmp)) {
      fs.mkdirSync(pathTmp);
    }
    return path.join(before, cur + path.sep);
  }, '');

  if (gqlSchema.getMutationType()) {
    generateFile(gqlSchema.getMutationType().getFields(), 'Mutation');
  } else {
    console.log('[gqlg warning]:', 'No mutation type found in your schema');
  }

  if (gqlSchema.getQueryType()) {
    generateFile(gqlSchema.getQueryType().getFields(), 'Query');
  } else {
    console.log('[gqlg warning]:', 'No query type found in your schema');
  }

  if (gqlSchema.getSubscriptionType()) {
    generateFile(gqlSchema.getSubscriptionType().getFields(), 'Subscription');
  } else {
    console.log('[gqlg warning]:', 'No subscription type found in your schema');
  }

  fs.writeFileSync(path.join(destDirPath, 'index.ts'), indexJsExportAll);
}

function main() {
  program
    .option('--schemaFilePath [value]', 'path of your graphql schema file')
    .option('--destDirPath [value]', 'dir you want to store the generated queries')
    .option('--depthLimit [value]', 'query depth you want to limit (The default is 100)', 100)
    .option('--excludeNestedArgs [value]', 'Flag to exclude nested arguments (The default is to include)', false)
    .option('-C, --includeDeprecatedFields [value]', 'Flag to include deprecated fields (The default is to exclude)', false)
    .parse(process.argv);

  let schemaFilePath;
  (
    {
      schemaFilePath, destDirPath, depthLimit,
      excludeNestedArgs, includeDeprecatedFields,
    } = program
  );

  const schemaContent = fs.readFileSync(path.resolve(schemaFilePath), 'utf-8');
  gqlGenerate(schemaContent, destDirPath, depthLimit, excludeNestedArgs, includeDeprecatedFields);
}

module.exports = { main, gqlGenerate };
