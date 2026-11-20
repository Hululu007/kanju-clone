/* 夹具节点带着 parentNode/children 双向引用和一长串方法。断言失败时 Node 默认会把
   actual 整棵树展开成字符串；同一个节点既被 parentNode 引用、又在 children 里，
   展开量随层数指数增长 —— 2026-11-20 的一条失败断言就是这样把 node 吃到 40GB。
   所有夹具节点都用这一行摘要代替整棵树，失败的测试只报错，不再把机器撑死。 */
export function describeFixtureNode(node) {
  const tag = String((node && node.tagName) || 'node').toLowerCase();
  const id = node && node.id ? '#' + node.id : '';
  const classes = String((node && node.className) || '').split(/\s+/).filter(Boolean).map((name) => '.' + name).join('');
  return '[fixture ' + tag + id + classes + ']';
}

/* 给一个夹具节点挂上 util.inspect 摘要（不可枚举，不参与 deepEqual）。 */
export function attachFixtureInspect(node) {
  Object.defineProperty(node, Symbol.for('nodejs.util.inspect.custom'), {
    value: () => describeFixtureNode(node),
    enumerable: false,
  });
  return node;
}

export function withDOM(element, createNode) {
  let text = '';
  const removeChildren = () => {
    while (element.firstChild) element.removeChild(element.firstChild);
  };
  const listeners = new Map();
  element.addEventListener = (type, listener) => {
    if (!listeners.has(type)) listeners.set(type, []);
    listeners.get(type).push(listener);
  };
  element.dispatchFixtureEvent = (type, event) => {
    for (const listener of listeners.get(type) || []) listener(event);
  };
  Object.defineProperty(element, 'textContent', {
    get: () => text + element.children.map((child) => child.textContent || '').join(''),
    set(value) {
      removeChildren();
      text = String(value);
    },
  });
  // The injection uses static HTML fragments. Parse their tags, attributes and text
  // so tests exercise mounted controls, not manually supplied stand-ins.
  Object.defineProperty(element, 'innerHTML', {
    set(html) {
      removeChildren();
      text = '';
      const stack = [element];
      for (const token of html.match(/<[^>]+>|[^<]+/g) || []) {
        const parent = stack.at(-1);
        if (/^<\//.test(token)) {
          if (stack.length > 1) stack.pop();
        } else if (token.startsWith('<')) {
          const [, tag, attributes] = /^<(\w+)([^>]*)>$/.exec(token);
          const child = createNode(tag);
          for (const [, name, value = ''] of attributes.matchAll(/([\w-]+)(?:="([^"]*)")?/g)) {
            child.setAttribute(name === 'class' ? 'className' : name, value);
          }
          parent.appendChild(child);
          if (!/^(img|input|br|hr)$/i.test(tag)) stack.push(child);
        } else {
          const leaf = { textContent: token };
          parent.appendChild(leaf);
        }
      }
    },
  });
  element.querySelectorAll = (selector) => {
    const matches = (child) => {
      const [, tagName, attributes] = /^([\w-]+)(.*)$/.exec(selector) || [];
      if (tagName && child.tagName !== tagName.toUpperCase()) return false;
      const classSelector = /\.([\w-]+)/.exec(attributes || '');
      if (classSelector && !String(child.className || '').split(/\s+/).includes(classSelector[1])) return false;
      if (selector.startsWith('.')) return String(child.className || '').split(/\s+/).includes(selector.slice(1));
      if (selector.startsWith('#')) return child.id === selector.slice(1);
      const attribute = /\[([\w-]+)(?:="([^"]*)")?\]/.exec(attributes || selector);
      if (attribute) return child.hasAttribute?.(attribute[1]) && (attribute[2] === undefined || child.getAttribute(attribute[1]) === attribute[2]);
      return !!tagName;
    };
    const descendants = (parent) => (parent.children || []).flatMap((child) => [child, ...descendants(child)]);
    return descendants(element).filter(matches);
  };
  element.querySelector = (selector) => element.querySelectorAll(selector)[0] || null;
  return element;
}
