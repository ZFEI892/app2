'use strict';

class HttpError extends Error {
  constructor(status, message, detail) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.detail = detail;
  }
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function compile(pattern) {
  const keys = [];
  const source = pattern
    .split('/')
    .map((seg) => {
      const m = seg.match(/^:([A-Za-z0-9_]+)(?:\((.+)\))?$/);
      if (m) {
        keys.push(m[1]);
        return m[2] ? `(${m[2]})` : '([^/]+)';
      }
      return escapeRegex(seg);
    })
    .join('/');
  return { regex: new RegExp('^' + source + '/?$'), keys };
}

class Router {
  constructor() {
    this.routes = [];
  }

  add(method, pattern, handler) {
    const { regex, keys } = compile(pattern);
    this.routes.push({ method, pattern, regex, keys, handler });
    return this;
  }

  get(p, h) { return this.add('GET', p, h); }
  post(p, h) { return this.add('POST', p, h); }
  put(p, h) { return this.add('PUT', p, h); }
  del(p, h) { return this.add('DELETE', p, h); }

  match(method, pathname) {
    let pathMatched = false;
    for (const route of this.routes) {
      const m = route.regex.exec(pathname);
      if (!m) continue;
      pathMatched = true;
      if (route.method !== method) continue;
      const params = {};
      route.keys.forEach((k, i) => {
        params[k] = decodeURIComponent(m[i + 1]);
      });
      return { handler: route.handler, params };
    }
    if (pathMatched) throw new HttpError(405, `方法 ${method} 不被支持`);
    return null;
  }
}

module.exports = { Router, HttpError };
