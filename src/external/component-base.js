import React from 'react';
import ReactDOM from 'react-dom';

export default class ComponentBase<P, S> extends React.PureComponent<P, S> {
  _debounceTimers: object;
  _references: object;
  cachedReferenceMethods: object;

  constructor(...args) {
    // @ts-ignore
    super(...args);

    Object.defineProperties(this, {
      '_debounceTimers': {
        writeable:    false,
        enumerable:   false,
        configurable: false,
        value:        {},
      },
      '_references': {
        writeable:    false,
        enumerable:   false,
        configurable: false,
        value:        {},
      },
      'cachedReferenceMethods': {
        writeable:    false,
        enumerable:   false,
        configurable: false,
        value:        {},
      },
    });
  }

  _callStateUpdateHooks(fieldName, value, oldValue) {
    let stateUpdateMethodName = `onStateUpdated_${fieldName}`;
    let stateUpdateMethod     = this[stateUpdateMethodName];

    if (typeof stateUpdateMethod !== 'function')
      return;

    stateUpdateMethod.call(this, value, oldValue);
  }

  getReference(name) {
    return this._references[name];
  }

  captureReference(name) {
    let cachedMethod = this.cachedReferenceMethods[name];
    if (cachedMethod)
      return cachedMethod;

    let captureMethod = (ref) => {
      this._references[name] = ref;

      if (ref) {
        this._references[`$${name}`] = ReactDOM.findDOMNode(ref);
      } else {
        this._references[`$${name}`] = null;
      }
    };

    this.cachedReferenceMethods[name] = captureMethod;

    return captureMethod;
  }

  emit(eventName, ...args) {
    let rootElement = this.getReference('rootElement');

    // TODO: Trigger event on rootElement
  }

  debounce(callback, _opts) {
    let opts  = ((typeof _opts === 'number') ? { time: _opts } : _opts) || {};
    let id    = opts.id;

    // If no id was provided, then the id
    // is the first frame of the stack trace
    if (!id) {
      let error = new Error();
      id = error.stack.split('\n').slice(1, 2)[0];
    }

    let timerInfo = this._debounceTimers[id];
    if (timerInfo)
      clearTimeout(timerInfo.timerID);

    let timerID = setTimeout(() => {
      callback();
    }, opts.time || 0);

    this._debounceTimers[id] = { timerID };

    return timerID;
  }
}
