/* eslint-disable no-magic-numbers */
/* eslint-disable no-eval */
'use strict';

const Nife          = require('nife');
const Path          = require('path');
const FileSystem    = require('fs');
const Util          = require('util');
const {
  FileUtils,
  MiscUtils,
  EventUtils,
} = require('./utils');

function getOutputPathAndName(inputPath, outputPath, parsedSFC) {
  let fileName = Path.basename(parsedSFC.filePath);
  let name     = fileName.replace(/^([^.]+).*$/, '$1');

  let relativePath = FileUtils.relativeOutputPath(inputPath, outputPath, parsedSFC.filePath);
  relativePath = relativePath.split(Path.sep).filter(Boolean).map(MiscUtils.toHyphenated).join(Path.sep);

  let outputFilePath  = Path.join(outputPath, relativePath);
  let outputDir       = Path.dirname(outputFilePath);
  let nameConverted   = MiscUtils.toHyphenated(name);

  let filePath = Path.join(outputDir, nameConverted);
  FileSystem.mkdirSync(filePath, { recursive: true });

  return {
    fullFileName: Path.join(outputDir, nameConverted, `${nameConverted}.tsx`),
    filePath,
    nameConverted,
    name,
  };
}

function vueTypeToTSType(type) {
  if (type === String)
    return 'string';
  else if (type === Number)
    return 'number';
  else if (type === Boolean)
    return 'boolean';
  else if (type === BigInt)
    return 'bigint';
  else if (type === Object)
    return 'any /* Object */';
  else if (type === Array)
    return 'Array<any>';
  else if (type === Function)
    return 'any /* Function */';

  throw new Error(`TypeScript type "${type}" not supported`);
}

function toPropName(name) {
  return MiscUtils.convertPropOrStateName(name);
}

function propsToTS(props, _depth) {
  let depth           = _depth || 1;
  let isArray         = Array.isArray(props);
  let propNames       = Object.keys(props);
  let interfaceParts  = [];
  let prefix          = MiscUtils.getTabWidthForDepth(depth);

  if (!isArray)
    interfaceParts.push('\n');

  for (let i = 0, il = propNames.length; i < il; i++) {
    let propName    = propNames[i];
    let value       = props[propName];
    let newPropName = toPropName(propName);

    if (Nife.instanceOf(value, 'object')) {
      if (value.type) {
        value = value.type;
      } else {
        interfaceParts.push(`${prefix}${newPropName}: any /* TODO: Warning, unsure about this one, please check */;\n`);
        continue;
      }
    }

    if (Array.isArray(value)) {
      let result = propsToTS(value, depth + 1);
      interfaceParts.push(`${prefix}${newPropName}: Array<${result}>;\n`);
    } else {
      if (isArray)
        interfaceParts.push(vueTypeToTSType(value));
      else
        interfaceParts.push(`${prefix}${newPropName}: ${vueTypeToTSType(value)};\n`);
    }
  }

  return (isArray) ? interfaceParts.join(' | ') : interfaceParts.join('');
}

function propsToInterface(componentName, scriptObject) {
  let props = scriptObject.props;
  if (!props || Array.isArray(props))
    return `export interface ${componentName}Props {}`;

  return `export interface ${componentName}Props {${propsToTS(props)}};`;
}

function getState(scriptObject) {
  if (!scriptObject.data)
    return {};

  if (typeof scriptObject.data === 'function')
    return scriptObject.data();

  return scriptObject.data;
}

function toStateName(name) {
  return MiscUtils.convertPropOrStateName(name);
}

function generateStateCalls(state) {
  if (Nife.isEmpty(state))
    return '';

  let stateNames  = Object.keys(state);
  let stateParts  = [];

  for (let i = 0, il = stateNames.length; i < il; i++) {
    let stateName = stateNames[i];
    let value     = state[stateName];
    let newName   = toStateName(stateName);

    stateParts.push(`  const [ ${newName}, set${Nife.capitalize(newName)} ] = useState(${MiscUtils.convertValueToJS(value)});`);
  }

  return stateParts.join('\n');
}

function toComputeName(name) {
  return MiscUtils.convertPropOrStateName(name);
}

function doMethodConversions(context, events) {
  let {
    propNames,
    stateNames,
    computedNames,
    methodNames,
  } = context;

  const doConversions = (name, equals, followingChar) => {
    if (methodNames.indexOf(name) >= 0) {
      if (events && followingChar !== '(')
        return `${toMethodName(name)}(event)`;
      else
        return `${toMethodName(name)}`;
    } else if (computedNames.indexOf(name) >= 0) {
      if (equals)
        return `computedState.${toComputeName(name)} = ${equals}`;

      return `computedState.${toComputeName(name)}`;
    } else if (stateNames.indexOf(name) >= 0) {
      if (equals)
        return `set${Nife.capitalize(toStateName(name))}(${equals})`;

      return `${toStateName(name)}`;
    } else if (propNames.indexOf(name) >= 0) {
      return `props.${toPropName(name)}`;
    }

    if (equals)
      return `${name} = ${equals}`;

    return name;
  };

  return doConversions;
}

function convertInlineCode(context, code, events) {
  const doConversions = doMethodConversions(context, events);

  return code
    .replace(/([.\W]|\b)([a-zA-Z$][\w$]*)\s*[+*/-]?=([^=][^;]+)/gm, (m, _prefix, name, _equals) => {
      let prefix = _prefix.trim();
      if (prefix && (/[.'"-]/).test(prefix))
        return m;

      if ((/^\s+$/).test(_prefix))
        prefix = _prefix;

      let equals = _equals;
      if (equals)
        equals = equals.trim();

      return `${prefix}${doConversions(name, equals)}`;
    })
    .replace(/([.\W]|\b)([a-zA-Z$][\w$]*)/gm, (m, _prefix, name, offset, str) => {
      let followingChar = str.charAt(offset + m.length);
      if (followingChar === ':')
        return m;

      let prefix = _prefix.trim();
      if (prefix && (/[.'"-]/).test(prefix))
        return m;

      if ((/^\s+$/).test(_prefix))
        prefix = _prefix;

      return `${prefix}${doConversions(name, false, followingChar)}`;
    });
}

function convertMethod(context, func, stripPrefix, convertMethodToArrow) {
  let funcStr = ('' + func);

  if (stripPrefix)
    funcStr = funcStr.replace(/^[^{]+/, '');

  if (convertMethodToArrow) {
    let parts = funcStr.split(/\n/gm);
    parts[0] = parts[0].replace(/\{\s*$/, '=> {');
    funcStr = parts.join('\n');
  }

  const doConversions = doMethodConversions(context);

  return funcStr
    .replace(/(this\.)([a-zA-Z$][\w$]*)\s*[+*/-]?=([^=][^;]+)/gm, (m, prefix, name, _equals) => {
      let equals = _equals;
      if (equals)
        equals = equals.trim();

      return `${prefix}${doConversions(name, equals)}`;
    })
    .replace(/(this\.)([\w$]+)/g, (m, prefix, name) => {
      return `${prefix}${doConversions(name)}`;
    });
}

function getComputedNames(scriptObject) {
  let computed = scriptObject.computed;
  if (Nife.isEmpty(computed))
    return [];

  return Object.keys(computed);
}

function generateComputed(context, scriptObject) {
  let computed = scriptObject.computed;
  if (Nife.isEmpty(computed))
    return '';

  let computedNames = context.computedNames;
  let computedParts = [ '  const computedState = ComponentUtils.createComputedState({' ];

  for (let i = 0, il = computedNames.length; i < il; i++) {
    let computeName = computedNames[i];
    let value       = computed[computeName];
    let isFunction  = (typeof value === 'function');
    let funcBody    = (!isFunction) ? convertInlineCode(context, MiscUtils.convertValueToJS(value, 2), false).replace(/(get|set)\(([^)]*)\)\s*{/g, (m, name, args) => {
      return `(${args}) => {`;
    }) : convertMethod(context, value, true);

    if (isFunction)
      computedParts.push(`    '${toComputeName(computeName)}': () => ${funcBody},`);
    else
      computedParts.push(`    '${toComputeName(computeName)}': ${funcBody},`);
  }

  computedParts.push('  });');

  return computedParts.join('\n');
}

function getMethodNames(scriptObject) {
  let methods = scriptObject.methods;
  if (Nife.isEmpty(methods))
    return [];

  return Object.keys(methods);
}

function toMethodName(name) {
  return MiscUtils.convertPropOrStateName(name);
}

function generateMethods(context, scriptObject) {
  let methods = scriptObject.methods;
  if (Nife.isEmpty(methods))
    return '';

  let methodNames = context.methodNames;
  let methodParts = [];

  for (let i = 0, il = methodNames.length; i < il; i++) {
    let methodName  = methodNames[i];
    let value       = methods[methodName];
    let funcBody    = convertMethod(context, value, false, true);

    funcBody = funcBody.replace(/^[\w$]+/, `${toMethodName(methodName)} = `);

    methodParts.push(`  const ${funcBody};\n`);
  }

  return methodParts.join('\n');
}

function convertAttributeNameToJSXName(name) {
  if (name === 'class')
    return 'className';

  if (name.startsWith('v-'))
    return name;

  return toPropName(name);
}

function attributesToJSX(context, node, attributes, _depth) {
  if (Nife.isEmpty(attributes))
    return '';

  let depth           = _depth || 1;
  let attributeNames  = Object.keys(attributes);
  let attributeParts  = [];
  let finalAttributes = {};
  let prefix          = MiscUtils.getTabWidthForDepth(depth + 2);

  for (let i = 0, il = attributeNames.length; i < il; i++) {
    let attributeName   = attributeNames[i];
    let attributeValue  = attributes[attributeName];
    let propName        = undefined;
    let value           = undefined;

    if (attributeName === 'v-text') {
      // Handled at the JSX level
      continue;
    } else if ((/^(v-text|v-html|v-for|v-if|v-else-if|v-else|v-show)/).test(attributeName)) {
      // Handled at the JSX level
      continue;
    } else if ((/^v-bind:/).test(attributeName)) {
      propName  = convertAttributeNameToJSXName(attributeName.replace(/^v-bind:/, ''));
      value     = convertInlineCode(context, attributeValue);
    } else if (attributeName.charAt(0) === ':') {
      propName  = convertAttributeNameToJSXName(attributeName.substring(1));
      value     = convertInlineCode(context, attributeValue);
    } else if (attributeName.charAt(0) === '@') {
      let eventNameParts  = attributeName.substring(1).split('.');
      let eventName       = eventNameParts[0];
      let reactEventName  = EventUtils.convertToReactEventName(eventName);
      let comment         = '';
      value               = convertInlineCode(context, attributeValue, true);

      if (eventNameParts.length > 1 || eventName === reactEventName)
        comment = ' /* TODO: WARNING: This was a special binding... please refer to the Vue code to correct this event method */';

      propName = reactEventName;
      value = `(event: any) => { ${value} }${comment}`;
    } else {
      propName  = convertAttributeNameToJSXName(attributeName);
      value     = attributeValue;

      if (Nife.isEmpty(value))
        value = 'true';
      else
        value = MiscUtils.convertValueToJS(attributeValue);

      if (propName === 'v-model')
        value = value + ' /* TODO: Dual binding from child to parent */';
    }

    if (!propName || !value)
      continue;

    let values = finalAttributes[propName];
    if (!values)
      values = finalAttributes[propName] = [];

    values.push(value);
  }

  let keys = Object.keys(finalAttributes);
  for (let i = 0, il = keys.length; i < il; i++) {
    let propName  = keys[i];
    let values    = finalAttributes[propName];
    let value     = undefined;

    if (propName === 'className') {
      if (node.parent && node.parent.name === 'template')
        values = Nife.uniq([].concat(values));

      value = `classNames(${values.join(', ')})`;
    } else {
      value = values.join(', ');
    }

    if (!(/^['"]/).test(value) || !(/['"]$/).test(value))
      value = `{${value.replace(/\n\s*/g, ' ')}}`;

    attributeParts.push(`${propName}=${value}`);
  }

  let totalLength = attributeParts.reduce((sum, part) => (sum + part.length), 0);

  // eslint-disable-next-line no-magic-numbers
  if (totalLength > 100) {
    attributeParts = [ '' ].concat(attributeParts.map((part) => `${prefix}${part}`));
    return attributeParts.join('\n');
  } else {
    return attributeParts.join(' ');
  }
}

function generateJSXFromDOM(context, nodes, _incomingNodeContext) {
  if (Nife.isEmpty(nodes))
    return '';

  const constructNode = (results, nodeContext) => {
    let {
      attributes,
      node,
      nodeName,
      prefix,
      firstChild,
      lastChild,
      insideIf,
      lastNodeWasIf,
    } = nodeContext;

    let resultContext = {};

    if (!firstChild && !insideIf)
      results.push('\n');

    let ifResult = handleIfStatement(results, nodeContext);
    if (ifResult) {
      if (lastChild)
        results.push(`\n${prefix}})()}\n\n`);

      return { lastNodeWasIf: true };
    } else if (lastNodeWasIf) {
      if (ifResult !== 'NO_END')
        results.push(`\n${prefix}})()}\n\n`);

      nodeContext.lastNodeWasIf  = false;
      resultContext.lastNodeWasIf = false;
    }

    if (handleForLoop(results, nodeContext))
      return resultContext;

    results.push(`${prefix}<${nodeName}`);

    if (nodeContext.isTemplate)
      results.push(' /* TODO: Was template = true */ ');

    let attributesStr = attributesToJSX(context, node, attributes, depth + 1);
    if (Nife.isNotEmpty(attributesStr)) {
      results.push(' ');
      results.push(attributesStr);
    }

    let childrenStr;

    if (Object.prototype.hasOwnProperty.call(attributes, 'v-text')) {
      let value = convertInlineCode(context, attributes['v-text'], false);
      childrenStr = `  ${MiscUtils.getTabWidthForDepth(depth + 2)}{${value}}\n`;
    } else {
      childrenStr = generateJSXFromDOM(context, node.children || [], Object.assign({}, nodeContext, { depth: depth + 1 }));
    }

    if (Nife.isNotEmpty(childrenStr)) {
      if (attributesStr.indexOf('\n') >= 0) {
        results.push('\n');
        results.push(`${prefix}>\n`);
      } else {
        results.push('>\n');
      }

      results.push(childrenStr);
      results.push(`${prefix}</${nodeName}>\n`);
    } else {
      if (attributesStr.indexOf('\n') >= 0) {
        results.push('\n');
        results.push(`${prefix}/>\n`);
      } else {
        results.push('/>\n');
      }
    }

    return resultContext;
  };

  const getIfAttribute = (attributes) => {
    let attributeNames = Object.keys(attributes);
    for (let i = 0, il = attributeNames.length; i < il; i++) {
      let attributeName = attributeNames[i];
      if ((/^(v-if|v-else-if|v-else|v-show)/).test(attributeName))
        return { type: attributeName, value: attributes[attributeName] };
    }
  };

  const getForAttribute = (attributes) => {
    const parseForLoop = (value) => {
      let name;
      let indexName;
      let sourceName;

      if (value.charAt(0) === '(') {
        value.replace(/\(\s*([\w$]+),\s*([\w$]+)\s*\)\s+in\s+([\w$.]+)/i, (m, _name, _indexName, _sourceName) => {
          name = _name;
          indexName = _indexName;
          sourceName = _sourceName;
        });
      } else {
        value.replace(/([\w$]+)\s+in\s+([\w$.]+)/i, (m, _name, _sourceName) => {
          name = _name;
          sourceName = _sourceName;
        });
      }

      if (sourceName)
        sourceName = convertInlineCode(context, sourceName);

      if (sourceName.match(/^\d+$/)) {
        let items = [];
        sourceName = parseInt(sourceName, 10);
        for (let i = 0; i < sourceName; i++)
          items.push(i);

        sourceName = `[ ${items.join(', ')} ]`;
      }

      return { name, indexName, sourceName };
    };

    let attributeNames = Object.keys(attributes);
    for (let i = 0, il = attributeNames.length; i < il; i++) {
      let attributeName = attributeNames[i];
      if (attributeName === 'v-for') {
        let attributeValue  = attributes[attributeName];
        let parsed          = parseForLoop(attributeValue);

        let keyValue = attributes[':key'];
        if (Nife.isEmpty(keyValue) && parsed.indexName)
          keyValue = parsed.indexName;

        parsed.key = keyValue;

        return parsed;
      }
    }
  };

  const handleIfStatement = (results, nodeContext) => {
    let {
      prefix,
      attributes,
      node,
      insideIf,
      lastChild,
      lastNodeWasIf,
    } = nodeContext;

    let ifAttribute = getIfAttribute(attributes);
    if (!ifAttribute) {
      if (insideIf) {
        insideIf = false;

        results.push(`\n${prefix}})()}\n\n`);
      }

      return;
    }

    if (nodeContext.ignoreIfStatements === true)
      return;

    let type          = ifAttribute.type;
    let isShow        = (type === 'v-show');
    let value         = convertInlineCode(context, ifAttribute.value);
    let innerPrefix   = MiscUtils.getTabWidthForDepth(depth + 3);
    let innerPrefix2  = MiscUtils.getTabWidthForDepth(depth + 4);
    let innerPrefix3  = MiscUtils.getTabWidthForDepth(depth + 5);

    if (type === 'v-if' || type === 'v-show')
      type = 'if';
    else if (type === 'v-else-if')
      type = 'else if';
    else if (type === 'v-else')
      type = 'else';

    if (type === 'if') {
      if (insideIf || lastNodeWasIf)
        results.push(`\n${prefix}})()}\n\n`);

      insideIf = (isShow) ? 'v-show' : 'v-if';

      results.push(`\n${prefix}{(() => {\n`);
    }

    let condition;

    if (type !== 'else')
      condition = ` (${value}) `;
    else
      condition = ' ';

    results.push(`${(type !== 'if') ? ' ' : innerPrefix}${type}${condition}{\n`);
    let innerResult = generateJSXFromDOM(context, [ node ], Object.assign({}, nodeContext, { depth: depth + 4, ignoreIfStatements: true, insideIf: true, lastNodeWasIf: false }));

    if (Nife.isEmpty(innerResult))
      results.push(`${innerPrefix2}return null;`);
    else
      results.push(`${innerPrefix2}return (\n${innerPrefix3}<React.Fragment>\n${innerResult}${innerPrefix3}</React.Fragment>\n${innerPrefix2});`);

    results.push(`\n${innerPrefix}}`);

    // if (lastChild)
    //   results.push(`\n${prefix}})()}\n\n`);

    return (isShow) ? 'NO_END' : true;
  };

  const handleForLoop = (results, nodeContext) => {
    let {
      prefix,
      attributes,
      node,
      ignoreForLoop,
    } = nodeContext;

    if (ignoreForLoop)
      return;

    let forAttribute = getForAttribute(attributes);
    if (!forAttribute)
      return;

    let args            = [ forAttribute.name, forAttribute.indexName ].filter(Boolean).join(', ');
    let forLoopResults  = [];
    let innerPrefix     = MiscUtils.getTabWidthForDepth(depth + 3);

    forLoopResults.push(`\n${prefix}{${forAttribute.sourceName}.map((${args}) => {\n`);
    let innerResult = generateJSXFromDOM(context, [ node ], Object.assign({}, nodeContext, { depth: depth + 2, ignoreForLoop: true }));

    if (Nife.isEmpty(innerResult))
      forLoopResults.push(`${innerPrefix}return null;`);
    else
      forLoopResults.push(`${innerPrefix}return (\n${innerResult}\n${innerPrefix});`);
    forLoopResults.push(`\n${prefix}})}\n`);

    results.push(forLoopResults.join(''));

    return true;
  };

  // v-html = v-text, but for html

  let incomingNodeContext = Object.assign({}, _incomingNodeContext || {});
  let depth               = incomingNodeContext.depth || 0;
  let insideJSX           = incomingNodeContext.insideJSX || false;
  let results             = [];
  let prefix              = MiscUtils.getTabWidthForDepth(depth + 2);
  let firstChild          = true;
  let insideIf            = false;
  let filteredNodes       = nodes.filter((node) => {
    if (node.type === 'text') {
      if (!insideJSX)
        return false;

      if (Nife.isEmpty(node.data))
        return false;

      return true;
    } else {
      return true;
    }
  });

  let nodeContext = Object.assign({}, incomingNodeContext, {
    depth,
    insideJSX,
    insideIf,
    firstChild,
    prefix,
  });

  for (let i = 0, il = filteredNodes.length; i < il; i++) {
    let node = filteredNodes[i];
    if (node.type !== 'tag')
      continue;

    let nodeName = node.name;
    let isTemplate = false;

    if (nodeName === 'template') {
      // results.push(generateJSXFromDOM(context, node.children, depth + 1, true));
      // continue;

      nodeName = 'div';
      isTemplate = true;
    } else if (nodeName.indexOf('-') >= 0) {
      nodeName = Nife.capitalize(MiscUtils.convertPropOrStateName(nodeName));
    }

    let attributes = node.attribs;
    let lastChild = ((i + 1) >= filteredNodes.length);

    nodeContext = Object.assign(nodeContext, {
      node,
      nodeName,
      attributes,
      lastChild,
      firstChild,
      isTemplate,
    });

    let result = constructNode(results, nodeContext);
    if (result)
      Object.assign(nodeContext, result);

    firstChild = false;
  }

  return results.join('');
}

function generateRenderMethod(context, template) {
  if (!template)
    return '  return null;';

  let jsx = generateJSXFromDOM(context, [ template ]);
  return `  return (\n${jsx}\n  );`;
}

function generateReactComponent(parsedSFC) {
  let componentName           = parsedSFC.componentName;
  let convertedComponentName  = parsedSFC.convertedComponentName;
  let scriptObject            = MiscUtils.evalScript(parsedSFC.script);
  let propsInterface          = propsToInterface(componentName, scriptObject);
  let state                   = getState(scriptObject);
  let propNames               = Object.keys(scriptObject.props || {});
  let stateNames              = Object.keys(state || {});
  let computedNames           = getComputedNames(scriptObject);
  let methodNames             = getMethodNames(scriptObject);
  let context                 = { propNames, stateNames, computedNames, methodNames, componentName, convertedComponentName };
  let stateCalls              = generateStateCalls(state);
  let computeMethods          = generateComputed(context, scriptObject);
  let methods                 = generateMethods(context, scriptObject);
  let renderJSX               = generateRenderMethod(context, parsedSFC.template);
  // TODO: Handle scriptSetup

  return `
import React, { useState, useEffect } from 'react';
import classNames from 'classnames';
import ComponentUtils from '@utils/component-utils';
import './styles.sass';

${propsInterface}

export default function ${componentName}(props: ${componentName}Props) {
${methods}

${computeMethods}

${stateCalls}

${renderJSX}
}
`;
}

function convertToReact(inputPath, outputPath, parsedSFC) {
  let { filePath, fullFileName, name, nameConverted } = getOutputPathAndName(inputPath, outputPath, parsedSFC);

  parsedSFC.componentName = name;
  parsedSFC.convertedComponentName = nameConverted;

  let cssFullFileName = Path.join(filePath, 'styles.sass');
  let styleSheet      = parsedSFC.style || '';
  FileSystem.writeFileSync(cssFullFileName, styleSheet, 'utf8');

  let reactComponent = generateReactComponent(parsedSFC);
  //let templateStr = Util.inspect(parsedSFC.template, { depth: Infinity });
  // console.log('COMPONENT: ', reactComponent);

  FileSystem.writeFileSync(fullFileName, reactComponent, 'utf8');
}

module.exports = {
  convertToReact,
};
