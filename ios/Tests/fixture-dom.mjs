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
