// learnings/memo-d-foundation/browser-tools/trace-css-rules.js
// Walk same-origin stylesheets for every style rule that matches an element
// and sets a given property. Recurses into @media/@layer/@supports groups.

function toCamel(prop) {
  return prop.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

function toKebab(prop) {
  return prop.replace(/([A-Z])/g, '-$1').toLowerCase();
}

function collectRules(rules, element, property, kebabProp, out) {
  for (const rule of rules) {
    if (rule.type === CSSRule.STYLE_RULE) {
      let matched = false;
      try { matched = element.matches(rule.selectorText); } catch { matched = false; }
      if (!matched) continue;
      const value = rule.style.getPropertyValue(kebabProp);
      if (value) out.push({ selector: rule.selectorText, value });
    } else if (rule.cssRules) {
      // @media, @layer, @supports and other grouping rules nest further rules.
      collectRules(rule.cssRules, element, property, kebabProp, out);
    }
  }
}

async function traceCssRules(args) {
  const { selector, property } = args || {};
  const element = document.querySelector(selector);
  if (!element) return { selector, property, error: 'no element matches selector' };

  const kebabProp = property.includes('-') ? property : toKebab(property);
  const camelProp = toCamel(kebabProp);

  const rules = [];
  for (const sheet of document.styleSheets) {
    let cssRules;
    try { cssRules = sheet.cssRules; } catch { continue; } // cross-origin, skip
    if (!cssRules) continue;
    collectRules(cssRules, element, property, kebabProp, rules);
  }

  const computed = getComputedStyle(element).getPropertyValue(kebabProp);
  const inline = element.style.getPropertyValue(kebabProp) || element.style[camelProp] || '';

  return { selector, property, computed, inline, rules };
}
