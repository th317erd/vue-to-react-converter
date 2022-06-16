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
    fullFileName: Path.join(outputDir, nameConverted, `${nameConverted}.jsx`),
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
    return 'any';
  else if (type === Array)
    return 'Array<any>';

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

    if (Array.isArray(value)) {
      let result = propsToTS(value, depth + 1);
      interfaceParts.push(`${prefix}${newPropName}: Array<${result}>;\n`);
    } else if (Nife.instanceOf(value, 'object')) {
      let result = propsToTS(value, depth + 1);
      interfaceParts.push(`${prefix}${newPropName}: {${result}${prefix}};\n`);
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
  if (!props)
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
  return `compute${Nife.capitalize(MiscUtils.convertPropOrStateName(name))}`;
}

function doMethodConversions(context, events) {
  let {
    propNames,
    stateNames,
    computedNames,
    methodNames,
  } = context;

  const doConversions = (m, name, equals) => {
    if (methodNames.indexOf(name) >= 0) {
      if (events)
        return `${toMethodName(name)}(event)`;
      else
        return `${toMethodName(name)}()`;
    } else if (computedNames.indexOf(name) >= 0) {
      return `${toComputeName(name)}()`;
    } else if (stateNames.indexOf(name) >= 0) {
      if (equals)
        return `set${Nife.capitalize(toStateName(name))}(${equals})`;

      return `${toStateName(name)}`;
    } else if (propNames.indexOf(name) >= 0) {
      return `props.${toPropName(name)}`;
    }

    return m;
  };

  return doConversions;
}

function convertInlineCode(context, code, events) {
  const doConversions = doMethodConversions(context, events);

  return code
    .replace(/([a-zA-Z$][\w$]*)\s*=([^=][^;]+)/gm, (m, name, _equals) => {
      let equals = _equals;
      if (equals)
        equals = equals.trim();

      return doConversions(m, name, equals);
    })
    .replace(/([a-zA-Z$][\w$]*)/gm, (m, name) => {
      return doConversions(m, name);
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
    .replace(/this\.([a-zA-Z$][\w$]*)\s*=([^=][^;]+)/gm, (m, name, _equals) => {
      let equals = _equals;
      if (equals)
        equals = equals.trim();

      return doConversions(m, name, equals);
    })
    .replace(/this\.([\w$]+)/g, (m, name) => {
      return doConversions(m, name);
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
  let computedParts = [];

  for (let i = 0, il = computedNames.length; i < il; i++) {
    let computeName = computedNames[i];
    let value       = computed[computeName];
    let funcBody    = convertMethod(context, value, true);

    computedParts.push(`  const ${toComputeName(computeName)} = () => ${funcBody};\n`);
  }

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

  return name;
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
    } else if ((/^v-bind:/).test(attributeName)) {
      propName  = convertAttributeNameToJSXName(attributeName.replace(/^v-bind:/, ''));
      value     = convertInlineCode(context, attributeValue);
    } else if (attributeName.charAt(0) === ':') {
      propName  = convertAttributeNameToJSXName(attributeName.substring(1));
      value     = convertInlineCode(context, attributeValue);
    } else if (attributeName.charAt(0) === '@') {
      let eventName       = attributeName.substring(1).split('.')[0];
      let reactEventName  = EventUtils.convertToReactEventName(eventName);
      value               = convertInlineCode(context, attributeValue, true);

      propName = reactEventName;
      value = `(event) => { ${value} }`;
    } else {
      propName  = convertAttributeNameToJSXName(attributeName);
      value     = MiscUtils.convertValueToJS(attributeValue);
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

    if (!(/^['"]/).test(value))
      value = `{${value}}`;

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

function generateJSXFromDOM(context, nodes, _depth, _insideJSX) {
  if (Nife.isEmpty(nodes))
    return '';

  let depth       = _depth || 0;
  let insideJSX   = _insideJSX || false;
  let results     = [];
  let prefix      = MiscUtils.getTabWidthForDepth(depth + 1);
  let firstChild  = true;

  for (let i = 0, il = nodes.length; i < il; i++) {
    let node = nodes[i];
    if (node.type === 'text') {
      if (!insideJSX)
        continue;

      if (Nife.isEmpty(node.data))
        continue;

      results.push(node.data.trim());

      continue;
    }

    if (node.type !== 'tag')
      continue;

    if (node.name === 'template') {
      results.push(generateJSXFromDOM(context, node.children, depth + 1, true));
      continue;
    }

    if (!firstChild)
      results.push('\n');

    firstChild = false;

    results.push(`${prefix}<${node.name}`);

    let attributes    = node.attribs;
    let attributesStr = attributesToJSX(context, node, attributes, depth);
    if (Nife.isNotEmpty(attributesStr)) {
      results.push(' ');
      results.push(attributesStr);
    }

    let childrenStr;

    if (Object.prototype.hasOwnProperty.call(attributes, 'v-text')) {
      let value = convertInlineCode(context, attributes['v-text']);
      childrenStr = `${MiscUtils.getTabWidthForDepth(depth + 2)}{${value}}`;
    } else {
      childrenStr = generateJSXFromDOM(context, node.children || [], depth + 1, true);
    }

    if (Nife.isNotEmpty(childrenStr)) {
      if (attributesStr.indexOf('\n') >= 0) {
        results.push('\n');
        results.push(`${prefix}>\n`);
      } else {
        results.push('>\n');
      }

      results.push(childrenStr);
      results.push(`${prefix}</${node.name}>\n`);
    } else {
      if (attributesStr.indexOf('\n') >= 0) {
        results.push('\n');
        results.push(`${prefix}/>\n`);
      } else {
        results.push('/>\n');
      }
    }
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
import './styles.css';

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

  let cssFullFileName = Path.join(filePath, 'styles.css');
  let styleSheet      = parsedSFC.style || '';
  FileSystem.writeFileSync(cssFullFileName, styleSheet, 'utf8');

  let reactComponent = generateReactComponent(parsedSFC);
  //let templateStr = Util.inspect(parsedSFC.template, { depth: Infinity });
  console.log('COMPONENT: ', reactComponent);

  FileSystem.writeFileSync(fullFileName, reactComponent, 'utf8');
}

module.exports = {
  convertToReact,
};