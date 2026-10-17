'use strict';

/**
 * 给前端页面测试用的最小 DOM 垫片。
 * 把 web/ 下的脚本放进一个干净的沙箱里跑，接口请求直接打到真实后端，
 * 于是能在不装浏览器、不引第三方依赖的前提下验证页面真的渲染得出来，
 * 还能把页面绑上去的点击处理器真的触发一遍。
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { ROOT_DIR } = require('./helpers');

const TAG_RE = /<\s*(\/?)([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g;
// 值可省：<div data-picked> 这种裸属性在页面里用得很多，必须也能被认出来
const ATTR_RE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'))?/g;
/** 这些标签没有闭合标签，不能进嵌套栈 */
const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

function decodeEntities(s) {
  return String(s)
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function parseAttrs(text) {
  const out = {};
  ATTR_RE.lastIndex = 0;
  let m = ATTR_RE.exec(text);
  while (m) {
    const raw = m[2] !== undefined ? m[2] : m[3];
    if (raw !== undefined) out[m[1]] = decodeEntities(raw);
    else if (!(m[1] in out)) out[m[1]] = '';
    m = ATTR_RE.exec(text);
  }
  return out;
}

function makeEl(tag) {
  const el = {
    tagName: String(tag || 'div').toUpperCase(),
    _html: '',
    _els: null,
    _qcache: Object.create(null),
    textContent: '',
    className: '',
    value: '',
    type: '',
    checked: false,
    disabled: false,
    style: {},
    listeners: {},
    addEventListener(type, fn) {
      if (!this.listeners[type]) this.listeners[type] = [];
      this.listeners[type].push(fn);
    },
    /** 触发绑在这个元素上的处理器（测试用） */
    async fire(type, event) {
      const fns = this.listeners[type] || [];
      for (const fn of fns) await fn(event || { target: this, currentTarget: this, preventDefault() {} });
      await new Promise((r) => setTimeout(r, 0));
      return fns.length;
    },
    setAttribute(k, v) { this[k] = v; },
    getAttribute(k) { return this[k] === undefined ? null : this[k]; },
    hasAttribute(k) { return this[k] !== undefined; },
    querySelector(sel) {
      const found = this.querySelectorAll(sel);
      return found.length ? found[0] : makeEl('div');
    },
    /**
     * 同一个元素上重复查询（哪怕选择器写法不同，比如 [data-x] 与 [data-x="v"]）
     * 必须拿到「同一个对象」，否则页面 addEventListener 绑在 A 上、测试却拿到新造的 B，就没法点。
     * 所以先按位置解析出全部元素，再按位置缓存对象，innerHTML 一变就整体清空。
     */
    querySelectorAll(sel) {
      if (!this._els) {
        this._src = this._html;
        this._els = parseElements(this._html);
      }
      const src = this._src || '';
      const memo = this._qcache;
      const out = [];
      this._els.forEach((node, i) => {
        if (!matchesSelector(node.attrs, sel)) return;
        if (!memo[i]) memo[i] = hydrate(makeEl(node.tag), node, src);
        out.push(memo[i]);
      });
      return out;
    },
    closest() { return null; },
    appendChild() {},
    remove() {},
    focus() {},
    select() {},
    click() { return this.fire('click'); },
    classList: { add() {}, remove() {}, toggle() {} },
  };
  Object.defineProperty(el, 'innerHTML', {
    enumerable: true,
    configurable: true,
    get() { return this._html; },
    set(v) { this._html = String(v); this._els = null; this._src = null; this._qcache = Object.create(null); },
  });
  return el;
}

/**
 * 把 HTML 里的标签逐个解析成 { tag, attrs, innerStart, innerEnd }，位置即身份。
 * innerStart / innerEnd 是「这个标签内部」在原文里的范围，用来让子元素也能被查到。
 */
function parseElements(html) {
  const out = [];
  const src = String(html || '');
  const stack = [];
  TAG_RE.lastIndex = 0;
  let t = TAG_RE.exec(src);
  while (t) {
    const closing = t[1] === '/';
    const tag = t[2].toLowerCase();
    const raw = t[3] || '';
    if (closing) {
      while (stack.length) {
        const top = stack.pop();
        out[top.nodeIndex].innerEnd = t.index;
        if (top.tag === tag) break;
      }
    } else {
      const selfClosed = VOID_TAGS.has(tag) || /\/\s*$/.test(raw);
      const node = {
        tag: t[2],
        attrs: parseAttrs(raw),
        innerStart: TAG_RE.lastIndex,
        innerEnd: TAG_RE.lastIndex,
      };
      out.push(node);
      if (!selfClosed) stack.push({ tag, nodeIndex: out.length - 1 });
    }
    t = TAG_RE.exec(src);
  }
  while (stack.length) {
    const top = stack.pop();
    out[top.nodeIndex].innerEnd = src.length;
  }
  return out;
}

/**
 * 只支持 [data-x] / [data-x="v"] / .class 以及它们不加空格的简单组合，
 * 页面里用的都是这几种；遇到后代、子选择器这类组合器一律当作不匹配。
 */
const PART_RE = /\[(?<name>[a-zA-Z0-9_-]+)(?:=(?:"(?<dq>[^"]*)"|'(?<sq>[^']*)'))?\]|(?<tag>[a-zA-Z][a-zA-Z0-9-]*)|\.(?<cls>[a-zA-Z0-9_-]+)/g;

function matchesSelector(attrs, selector) {
  const src = String(selector || '').trim();
  if (!src) return false;
  PART_RE.lastIndex = 0;
  let consumed = 0;
  let m = PART_RE.exec(src);
  while (m) {
    if (m.index !== consumed) return false;   // 有空隙说明用了组合器，不支持
    consumed = PART_RE.lastIndex;
    const g = m.groups;
    if (g.name !== undefined) {
      const want = g.dq !== undefined ? g.dq : g.sq;
      if (!(g.name in attrs)) return false;
      if (want !== undefined && attrs[g.name] !== want) return false;
    } else if (g.cls !== undefined) {
      if (!String(attrs.class || '').split(/\s+/).includes(g.cls)) return false;
    }
    m = PART_RE.exec(src);
  }
  return consumed === src.length && consumed > 0;
}

/** 一次性把匹配的节点都取出来（对外仍保留，方便单测直接从头解析） */
function queryAll(html, selector) {
  const src = String(html || '');
  const memo = [];
  return parseElements(src).map((node, i) => {
    if (!matchesSelector(node.attrs, selector)) return null;
    memo[i] = hydrate(makeEl(node.tag), node, src);
    return memo[i];
  }).filter(Boolean);
}

/**
 * 浏览器的 select.value 是「被选中项的 value」，不是 select 标签自己的属性。
 * 页面里大量用 select 承载「默认选中 AI 标出来的那张照片」这类语义，
 * 垫片必须照这个行为来，测试才验得了默认值。
 */
function selectedOptionValue(inner) {
  const re = /<option\b([^>]*)>/g;
  let m = re.exec(inner);
  let first = '';
  let seen = false;
  while (m) {
    const attrs = parseAttrs(m[1]);
    const v = attrs.value !== undefined ? attrs.value : '';
    if (!seen) { first = v; seen = true; }
    if ('selected' in attrs) return v;
    m = re.exec(inner);
  }
  return first;
}

/** 把解析出来的属性挂到元素上，并补齐少数需要「行为」的标签 */
function hydrate(el, node, src) {
  Object.entries(node.attrs).forEach(([k, v]) => { el[k] = v; });
  if (node.attrs.checked !== undefined) el.checked = true;
  const tag = node.tag.toLowerCase();
  if (tag === 'input') el.type = node.attrs.type || 'text';
  // 把子标签的原文也带上，页面里 row.querySelector('[data-x]') 这类写法才拿得到东西
  if (node.innerEnd > node.innerStart) el._html = src.slice(node.innerStart, node.innerEnd);
  if (tag === 'select') {
    const fallback = selectedOptionValue(el._html || '');
    el._selected = fallback;
    Object.defineProperty(el, 'value', {
      enumerable: true,
      configurable: true,
      get() { return this._value === undefined ? this._selected : this._value; },
      set(v) { this._value = v === undefined || v === null ? '' : String(v); },
    });
  }
  return el;
}

/**
 * @param {string} base 本地服务地址（相对路径的接口请求会拼到它上面）
 * @param {string[]} pages 要加载的页面脚本，如 ['pages/home.js']
 */
function loadFrontend(base, pages) {
  const registry = {};
  const captured = {
    modal: null,
    modalCalls: [],
    modalResult: true,
    confirmCalls: [],
    confirmResult: false,
    toasts: [],
    navigated: [],
    refreshed: 0,
    /** 页面发出的每一个后端请求，便于断言"发了什么、发了几次" */
    requests: [],
  };

  // 图片压缩链路 FileReader → Image → canvas 的垫片，三者共用这一格「最近一次读到的图」
  let lastImageSrc = null;

  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    fetch: (url, opts) => {
      const full = /^https?:/.test(url) ? url : base + url;
      captured.requests.push({
        url: full,
        method: (opts && opts.method) || 'GET',
        body: opts ? opts.body : undefined,
      });
      return fetch(full, opts);
    },
    location: { hash: '' },
    // 真实浏览器里的 FileReader：读假文件对象上的 __dataUrl / __text
    FileReader: class {
      readAsDataURL(file) {
        this.result = file && file.__dataUrl !== undefined
          ? file.__dataUrl
          : 'data:' + ((file && file.type) || 'image/jpeg') + ';base64,AA';
        if (typeof this.onload === 'function') this.onload();
      }
      readAsText(file) {
        this.result = file && file.__text !== undefined ? file.__text : '';
        if (typeof this.onload === 'function') this.onload();
      }
    },
    // 页面先挂 onload 再赋 src，所以这里同步回调即可
    Image: class {
      constructor() { this.width = 1200; this.height = 900; }
      set src(v) {
        this._src = v;
        lastImageSrc = v;
        if (typeof this.onload === 'function') this.onload();
      }
      get src() { return this._src; }
    },
    document: {
      getElementById: () => makeEl('div'),
      createElement: (tag) => {
        const el = makeEl(tag);
        if (String(tag).toLowerCase() === 'canvas') {
          el.getContext = () => ({ drawImage() {} });
          // 让压缩后的结果能反推出是哪张原图，测试才断言得了顺序
          el.toDataURL = () => 'data:image/jpeg;base64,' +
            String(lastImageSrc || 'CANVAS').replace(/^data:[^,]*,/, '');
        }
        return el;
      },
      querySelectorAll: () => [],
    },
    App: {
      NAV: [],
      register: (id, spec) => { registry[id] = spec; },
      navigate: (id, q) => { captured.navigated.push({ id, query: q }); },
      refresh: async () => { captured.refreshed += 1; },
      current: () => ({ id: null, query: {} }),
    },
  };
  sandbox.window = sandbox;
  sandbox.window.addEventListener = () => {};
  vm.createContext(sandbox);

  const files = ['core/ui.js', 'core/api.js'].concat(pages);
  files.forEach((rel) => {
    const file = path.join(ROOT_DIR, 'web', rel);
    vm.runInContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: file });
  });

  // 弹窗需要真实 DOM：这里记下内容，并按 captured.modalResult 决定"点确定/取消"
  sandbox.ui.modal = (html) => {
    captured.modal = html;
    captured.modalCalls.push(html);
    return Promise.resolve(captured.modalResult);
  };
  // confirmDialog / toast 在真实 ui.js 里是闭包内部函数，必须替换到 ui 对象上才拦得住
  sandbox.ui.confirmDialog = (title, message, okText) => {
    captured.confirmCalls.push({ title, message, okText });
    return Promise.resolve(captured.confirmResult);
  };
  sandbox.ui.toast = (text, kind) => {
    captured.toasts.push({ text, kind });
  };

  return { sandbox, registry, captured, root: makeEl('div') };
}

/** 断言页面 HTML 里包含某段文字，找不到时把实际内容带出来便于排查 */
function has(html, text) {
  if (!html.includes(text)) {
    throw new Error(`页面里没有找到「${text}」，实际内容片段：\n${String(html).slice(0, 800)}`);
  }
}

/** 从渲染结果里把带 data-go-page 的条目解析出来（首页的卡片与列表都用它承载跳转） */
function goTargets(html) {
  const out = [];
  const re = /data-go-page="([a-z]+)" data-go-query='([^']*)'/g;
  let m = re.exec(String(html));
  while (m) {
    out.push({ page: m[1], query: JSON.parse(decodeEntities(m[2])) });
    m = re.exec(html);
  }
  return out;
}

/** 把首页四张摘要卡拆出来，便于逐个核对数字与跳转目标 */
function metricCards(html) {
  return String(html).split('data-metric="').slice(1).map((chunk) => {
    const page = (chunk.match(/data-go-page="([a-z]+)"/) || [])[1] || null;
    const q = (chunk.match(/data-go-query='([^']*)'/) || [])[1];
    return {
      key: (chunk.match(/^([a-zA-Z]+)"/) || [])[1] || '',
      label: (chunk.match(/metric-label">([^<]*)</) || [])[1] || '',
      value: (chunk.match(/metric-value">([0-9]+)/) || [])[1] || '',
      page,
      query: q === undefined ? null : JSON.parse(decodeEntities(q)),
    };
  });
}

module.exports = { loadFrontend, makeEl, has, goTargets, metricCards, decodeEntities };
