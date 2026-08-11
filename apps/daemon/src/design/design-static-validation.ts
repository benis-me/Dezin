import { parse } from "@babel/parser";
import { transform as transformCss, transformStyleAttribute } from "lightningcss";
import {
  parse as parseHtml,
  type DefaultTreeAdapterTypes,
  type ParserError,
} from "parse5";
import {
  DesignStorageError,
  MAX_DESIGN_HTML_BYTES,
} from "./design-storage-primitives.ts";
import { isSafePassiveDesignDataUrl } from "./design-data-url-policy.ts";
import { designHtmlUrlContext } from "./design-html-url-context.ts";

function allowedDesignUrl(value: string, allowCanonicalAssets: boolean): boolean {
  const url = value.trim();
  if (url.startsWith("#") || url.startsWith("blob:")) return true;
  if (url.toLowerCase().startsWith("data:")) return isSafePassiveDesignDataUrl(url);
  if (/^dezin-asset:\/\/asset-[a-f0-9]{32}$/i.test(url)) return true;
  return allowCanonicalAssets
    && /^\/api\/projects\/[A-Za-z0-9._-]+\/design-canvas\/assets\/asset-[a-f0-9]{32}\/original\.[a-z0-9]{1,12}\?nodeId=[A-Za-z0-9._-]+&versionId=version-[A-Za-z0-9._-]+&checksum=[a-f0-9]{64}$/i.test(url);
}

interface DesignJavaScriptNode {
  type: string;
  [key: string]: unknown;
}

type DesignJavaScriptProvenance = "global" | "dom" | "style" | "local" | "unknown";

interface DesignJavaScriptScope {
  parent: DesignJavaScriptScope | null;
  kind: "program" | "parameter" | "function-body" | "static-block" | "block";
  bindings: Set<string>;
  constantStrings: Map<string, string>;
  possibleStrings: Map<string, ReadonlySet<string>>;
  possibleValues: Map<string, readonly unknown[]>;
  invalidatedBindings: Set<string>;
  reassignedBindings: Set<string>;
  initializers: Map<string, unknown>;
  stableValues: Map<string, unknown>;
  provenances: Map<string, DesignJavaScriptProvenance>;
  callables: Set<string>;
}

interface DesignJavaScriptIndex {
  bindings: WeakSet<object>;
  scopeByNode: WeakMap<object, DesignJavaScriptScope>;
  parentByNode: WeakMap<object, DesignJavaScriptNode | null>;
  thisOwnerByNode: WeakMap<object, DesignJavaScriptNode>;
  localThisFunctions: WeakSet<object>;
}

function designJavaScriptNode(value: unknown): value is DesignJavaScriptNode {
  return value !== null && typeof value === "object" && typeof (value as { type?: unknown }).type === "string";
}

function forEachDesignJavaScriptChild(
  node: DesignJavaScriptNode,
  visit: (child: DesignJavaScriptNode, key: string) => void,
): void {
  for (const [key, child] of Object.entries(node)) {
    if (key === "loc" || key === "comments" || key === "tokens" || key === "errors") continue;
    if (Array.isArray(child)) {
      for (const entry of child) {
        if (designJavaScriptNode(entry)) visit(entry, key);
      }
    } else if (designJavaScriptNode(child)) {
      visit(child, key);
    }
  }
}

function visitDesignJavaScript(
  node: DesignJavaScriptNode,
  visit: (node: DesignJavaScriptNode, parent: DesignJavaScriptNode | null, key: string | null) => void,
  parent: DesignJavaScriptNode | null = null,
  key: string | null = null,
): void {
  visit(node, parent, key);
  forEachDesignJavaScriptChild(node, (child, childKey) => {
    visitDesignJavaScript(child, visit, node, childKey);
  });
}

function designJavaScriptFunction(node: DesignJavaScriptNode): boolean {
  return node.type === "FunctionDeclaration"
    || node.type === "FunctionExpression"
    || node.type === "ArrowFunctionExpression"
    || node.type === "ObjectMethod"
    || node.type === "ClassMethod"
    || node.type === "ClassPrivateMethod";
}

function designJavaScriptClass(node: DesignJavaScriptNode): boolean {
  return node.type === "ClassDeclaration" || node.type === "ClassExpression";
}

function addDesignJavaScriptBinding(
  value: unknown,
  scope: DesignJavaScriptScope,
  bindings: WeakSet<object>,
): void {
  if (!designJavaScriptNode(value)) return;
  if (value.type === "Identifier" && typeof value.name === "string") {
    scope.bindings.add(value.name);
    bindings.add(value);
    return;
  }
  if (value.type === "RestElement") {
    addDesignJavaScriptBinding(value.argument, scope, bindings);
    return;
  }
  if (value.type === "AssignmentPattern") {
    addDesignJavaScriptBinding(value.left, scope, bindings);
    return;
  }
  if (value.type === "ArrayPattern") {
    for (const element of Array.isArray(value.elements) ? value.elements : []) {
      addDesignJavaScriptBinding(element, scope, bindings);
    }
    return;
  }
  if (value.type === "ObjectPattern") {
    for (const property of Array.isArray(value.properties) ? value.properties : []) {
      if (!designJavaScriptNode(property)) continue;
      addDesignJavaScriptBinding(
        property.type === "RestElement" ? property.argument : property.value,
        scope,
        bindings,
      );
    }
  }
}

function nearestDesignJavaScriptVarScope(scope: DesignJavaScriptScope): DesignJavaScriptScope {
  let current = scope;
  while (!["program", "function-body", "static-block"].includes(current.kind) && current.parent !== null) {
    current = current.parent;
  }
  return current;
}

function newDesignJavaScriptScope(
  parent: DesignJavaScriptScope | null,
  kind: DesignJavaScriptScope["kind"],
): DesignJavaScriptScope {
  return {
    parent,
    kind,
    bindings: new Set<string>(),
    constantStrings: new Map<string, string>(),
    possibleStrings: new Map<string, ReadonlySet<string>>(),
    possibleValues: new Map<string, readonly unknown[]>(),
    invalidatedBindings: new Set<string>(),
    reassignedBindings: new Set<string>(),
    initializers: new Map<string, unknown>(),
    stableValues: new Map<string, unknown>(),
    provenances: new Map<string, DesignJavaScriptProvenance>(),
    callables: new Set<string>(),
  };
}

function indexDesignJavaScript(root: DesignJavaScriptNode): DesignJavaScriptIndex {
  const index: DesignJavaScriptIndex = {
    bindings: new WeakSet<object>(),
    scopeByNode: new WeakMap<object, DesignJavaScriptScope>(),
    parentByNode: new WeakMap<object, DesignJavaScriptNode | null>(),
    thisOwnerByNode: new WeakMap<object, DesignJavaScriptNode>(),
    localThisFunctions: new WeakSet<object>(),
  };
  const walk = (
    node: DesignJavaScriptNode,
    incoming: DesignJavaScriptScope | null,
    parent: DesignJavaScriptNode | null,
    incomingThisOwner: DesignJavaScriptNode | null,
  ): void => {
    if (node.type === "FunctionDeclaration" && incoming !== null) {
      addDesignJavaScriptBinding(node.id, incoming, index.bindings);
      if (designJavaScriptNode(node.id) && node.id.type === "Identifier" && typeof node.id.name === "string") {
        incoming.callables.add(node.id.name);
        incoming.stableValues.set(node.id.name, node);
      }
    } else if (node.type === "ClassDeclaration" && incoming !== null) {
      addDesignJavaScriptBinding(node.id, incoming, index.bindings);
      if (designJavaScriptNode(node.id) && node.id.type === "Identifier" && typeof node.id.name === "string") {
        incoming.stableValues.set(node.id.name, node);
      }
    }

    let scope = incoming;
    if (node.type === "Program") {
      scope = newDesignJavaScriptScope(null, "program");
    } else if (designJavaScriptFunction(node)) {
      scope = newDesignJavaScriptScope(incoming, "parameter");
      if (node.type === "FunctionExpression") {
        addDesignJavaScriptBinding(node.id, scope, index.bindings);
        if (designJavaScriptNode(node.id) && node.id.type === "Identifier" && typeof node.id.name === "string") {
          scope.callables.add(node.id.name);
        }
      }
      for (const parameter of Array.isArray(node.params) ? node.params : []) {
        addDesignJavaScriptBinding(parameter, scope, index.bindings);
      }
    } else if (designJavaScriptClass(node)) {
      scope = newDesignJavaScriptScope(incoming, "block");
      if (node.type === "ClassExpression") addDesignJavaScriptBinding(node.id, scope, index.bindings);
    } else if (node.type === "CatchClause") {
      scope = newDesignJavaScriptScope(incoming, "block");
      addDesignJavaScriptBinding(node.param, scope, index.bindings);
    } else if (node.type === "StaticBlock") {
      scope = newDesignJavaScriptScope(incoming, "static-block");
    } else if (node.type === "BlockStatement"
      || node.type === "ForStatement"
      || node.type === "ForInStatement"
      || node.type === "ForOfStatement"
      || node.type === "SwitchStatement") {
      scope = newDesignJavaScriptScope(incoming, "block");
    }
    if (scope === null) throw new Error("JavaScript AST has no Program scope");
    index.scopeByNode.set(node, scope);
    index.parentByNode.set(node, parent);
    if (incomingThisOwner !== null) index.thisOwnerByNode.set(node, incomingThisOwner);

    if (node.type === "VariableDeclarator" && parent?.type === "VariableDeclaration") {
      const target = parent.kind === "var" ? nearestDesignJavaScriptVarScope(scope) : scope;
      addDesignJavaScriptBinding(node.id, target, index.bindings);
      if (designJavaScriptNode(node.id) && node.id.type === "Identifier" && typeof node.id.name === "string") {
        if (target.stableValues.has(node.id.name)) {
          target.stableValues.delete(node.id.name);
          target.callables.delete(node.id.name);
          target.constantStrings.delete(node.id.name);
          target.possibleStrings.delete(node.id.name);
          target.possibleValues.delete(node.id.name);
          target.invalidatedBindings.add(node.id.name);
          target.reassignedBindings.add(node.id.name);
        } else {
          target.stableValues.set(node.id.name, node.init);
          if (designJavaScriptNode(node.init) && designJavaScriptFunction(node.init)) {
            target.callables.add(node.id.name);
          }
          if (parent.kind === "const") {
            target.initializers.set(node.id.name, node.init);
            const constant = staticDesignJavaScriptString(node.init);
            target.possibleValues.set(node.id.name, [node.init]);
            if (constant !== null) {
              target.constantStrings.set(node.id.name, constant);
              target.possibleStrings.set(node.id.name, new Set([constant]));
            }
          }
        }
      }
    } else if (node.type === "ImportSpecifier"
      || node.type === "ImportDefaultSpecifier"
      || node.type === "ImportNamespaceSpecifier") {
      addDesignJavaScriptBinding(node.local, scope, index.bindings);
    }

    const functionBodyScope = designJavaScriptFunction(node)
      ? newDesignJavaScriptScope(scope, "function-body")
      : null;
    forEachDesignJavaScriptChild(node, (child, key) => {
      const childScope = designJavaScriptFunction(node) && (key === "key" || key === "decorators")
        ? incoming
        : designJavaScriptFunction(node) && key === "body"
          ? functionBodyScope
        : scope;
      const thisOwner = designJavaScriptFunction(node) && node.type !== "ArrowFunctionExpression"
        ? node
        : incomingThisOwner;
      walk(child, childScope, node, thisOwner);
    });
  };
  walk(root, null, null, null);

  const invalidateStableValue = (
    value: unknown,
    scope: DesignJavaScriptScope | undefined,
    reassignsBinding = true,
  ): void => {
    if (!designJavaScriptNode(value)) return;
    if (value.type === "Identifier" && typeof value.name === "string") {
      const binding = designJavaScriptBindingScope(scope, value.name);
      binding?.stableValues.delete(value.name);
      binding?.callables.delete(value.name);
      binding?.constantStrings.delete(value.name);
      binding?.possibleStrings.delete(value.name);
      binding?.possibleValues.delete(value.name);
      binding?.invalidatedBindings.add(value.name);
      if (reassignsBinding) binding?.reassignedBindings.add(value.name);
      return;
    }
    if (value.type === "MemberExpression" || value.type === "OptionalMemberExpression") {
      invalidateStableValue(value.object, index.scopeByNode.get(value), false);
      return;
    }
    if (value.type === "RestElement") {
      invalidateStableValue(value.argument, scope, reassignsBinding);
      return;
    }
    if (value.type === "AssignmentPattern") {
      invalidateStableValue(value.left, scope, reassignsBinding);
      return;
    }
    if (value.type === "ArrayPattern") {
      for (const element of Array.isArray(value.elements) ? value.elements : []) {
        invalidateStableValue(element, scope, reassignsBinding);
      }
      return;
    }
    if (value.type === "ObjectPattern") {
      for (const property of Array.isArray(value.properties) ? value.properties : []) {
        if (!designJavaScriptNode(property)) continue;
        invalidateStableValue(
          property.type === "RestElement" ? property.argument : property.value,
          scope,
          reassignsBinding,
        );
      }
    }
  };
  visitDesignJavaScript(root, (node) => {
    if (node.type === "AssignmentExpression") {
      invalidateStableValue(node.left, index.scopeByNode.get(node));
    } else if (node.type === "UpdateExpression") {
      invalidateStableValue(node.argument, index.scopeByNode.get(node));
    } else if ((node.type === "ForInStatement" || node.type === "ForOfStatement")
      && (!designJavaScriptNode(node.left) || node.left.type !== "VariableDeclaration")) {
      invalidateStableValue(node.left, index.scopeByNode.get(node));
    } else if (node.type === "CallExpression" && designJavaScriptNode(node.callee)
      && (node.callee.type === "MemberExpression" || node.callee.type === "OptionalMemberExpression")) {
      const calleeName = designJavaScriptMemberName(node.callee, index);
      const calleePath = designJavaScriptGlobalPath(node.callee, index);
      const effective = calleePath === null ? null : designJavaScriptEffectivePath(calleePath);
      if ((effective?.root === "Object" && ["assign", "defineProperty"].includes(calleeName ?? ""))
        || (effective?.root === "Reflect" && calleeName === "set")) {
        invalidateStableValue(
          Array.isArray(node.arguments) ? node.arguments[0] : null,
          index.scopeByNode.get(node),
          false,
        );
      }
      if (["copyWithin", "fill", "pop", "push", "reverse", "shift", "sort", "splice", "unshift"]
        .includes(calleeName ?? "")) {
        invalidateStableValue(node.callee.object, index.scopeByNode.get(node), false);
      }
    }
  });

  interface StaticCallSite {
    args: unknown[];
    receiver: DesignJavaScriptProvenance | null;
  }
  const callSites = new Map<DesignJavaScriptNode, StaticCallSite[]>();
  const escapedFunctions = new WeakSet<object>();
  const recordCall = (
    callable: DesignJavaScriptNode,
    args: unknown[],
    receiver: DesignJavaScriptProvenance | null,
  ): void => {
    const existing = callSites.get(callable) ?? [];
    existing.push({ args, receiver });
    callSites.set(callable, existing);
  };
  visitDesignJavaScript(root, (node, parent, key) => {
    if ((node.type === "Identifier" || node.type === "MemberExpression" || node.type === "OptionalMemberExpression")
      && !index.bindings.has(node)) {
      const resolved = designJavaScriptStableValue(node, index);
      if (resolved !== null && designJavaScriptFunction(resolved)
        && !(parent?.type === "CallExpression" && key === "callee")) {
        escapedFunctions.add(resolved);
      }
    }
    if (node.type === "CallExpression" && designJavaScriptNode(node.callee)) {
      const callable = designJavaScriptStableValue(node.callee, index);
      if (callable !== null && designJavaScriptFunction(callable)) {
        const receiver = node.callee.type === "MemberExpression" || node.callee.type === "OptionalMemberExpression"
          ? designJavaScriptProvenance(node.callee.object, index)
          : null;
        recordCall(callable, Array.isArray(node.arguments) ? node.arguments : [], receiver);
      }
    }
    if (node.type === "NewExpression" && designJavaScriptNode(node.callee)) {
      const classNode = designJavaScriptStableValue(node.callee, index);
      if (classNode !== null && (classNode.type === "ClassDeclaration" || classNode.type === "ClassExpression")
        && designJavaScriptNode(classNode.body) && Array.isArray(classNode.body.body)) {
        const constructor = classNode.body.body.find((candidate) => designJavaScriptNode(candidate)
          && candidate.static !== true && designJavaScriptObjectPropertyName(candidate) === "constructor");
        if (designJavaScriptNode(constructor) && designJavaScriptFunction(constructor)) {
          recordCall(constructor, Array.isArray(node.arguments) ? node.arguments : [], "local");
        }
      }
    }
  });
  const assignLocalParameterProvenance = (
    pattern: unknown,
    scope: DesignJavaScriptScope,
  ): void => {
    if (!designJavaScriptNode(pattern)) return;
    if (pattern.type === "Identifier" && typeof pattern.name === "string") {
      if (!scope.invalidatedBindings.has(pattern.name)) scope.provenances.set(pattern.name, "local");
      return;
    }
    if (pattern.type === "RestElement") {
      assignLocalParameterProvenance(pattern.argument, scope);
      return;
    }
    if (pattern.type === "AssignmentPattern") {
      assignLocalParameterProvenance(pattern.left, scope);
      return;
    }
    if (pattern.type === "ArrayPattern") {
      for (const element of Array.isArray(pattern.elements) ? pattern.elements : []) {
        assignLocalParameterProvenance(element, scope);
      }
      return;
    }
    if (pattern.type === "ObjectPattern") {
      for (const property of Array.isArray(pattern.properties) ? pattern.properties : []) {
        if (!designJavaScriptNode(property)) continue;
        assignLocalParameterProvenance(
          property.type === "RestElement" ? property.argument : property.value,
          scope,
        );
      }
    }
  };
  const expandPossibleValues = (candidates: readonly unknown[]): readonly unknown[] | null => {
    const expanded: unknown[] = [];
    for (const candidate of candidates) {
      const possible = designJavaScriptPossibleValues(candidate, index);
      if (possible === null || expanded.length + possible.length > 256) return null;
      expanded.push(...possible);
    }
    return expanded;
  };
  const assignPossibleValueProvenance = (
    pattern: unknown,
    candidates: readonly unknown[],
    scope: DesignJavaScriptScope,
  ): void => {
    if (!designJavaScriptNode(pattern) || candidates.length === 0) return;
    const expanded = expandPossibleValues(candidates);
    if (expanded === null || expanded.length === 0) return;
    if (pattern.type === "Identifier" && typeof pattern.name === "string") {
      if (!scope.invalidatedBindings.has(pattern.name)) scope.possibleValues.set(pattern.name, expanded);
      return;
    }
    if (pattern.type === "AssignmentPattern") {
      assignPossibleValueProvenance(pattern.left, expanded.map((candidate) => (
        candidate === undefined ? pattern.right : candidate
      )), scope);
      return;
    }
    if (pattern.type === "ArrayPattern") {
      const arrays = expanded.map((candidate) => designJavaScriptPossibleValues(candidate, index)?.[0]);
      if (arrays.some((candidate) => !designJavaScriptNode(candidate) || candidate.type !== "ArrayExpression")) return;
      const elements = Array.isArray(pattern.elements) ? pattern.elements : [];
      for (let elementIndex = 0; elementIndex < elements.length; elementIndex += 1) {
        const element = elements[elementIndex];
        if (element === null || element === undefined) continue;
        const elementCandidates = arrays.map((candidate) => (
          designJavaScriptNode(candidate) && Array.isArray(candidate.elements)
            ? candidate.elements[elementIndex]
            : undefined
        ));
        if (elementCandidates.some((candidate) => candidate === null || candidate === undefined)) continue;
        assignPossibleValueProvenance(element, elementCandidates, scope);
      }
      return;
    }
    if (pattern.type === "ObjectPattern") {
      const objects = expanded.map((candidate) => designJavaScriptPossibleValues(candidate, index)?.[0]);
      if (objects.some((candidate) => !designJavaScriptNode(candidate) || candidate.type !== "ObjectExpression")) return;
      for (const property of Array.isArray(pattern.properties) ? pattern.properties : []) {
        if (!designJavaScriptNode(property) || property.type === "RestElement") continue;
        const propertyName = designJavaScriptObjectPropertyName(property);
        if (propertyName === null) continue;
        const propertyCandidates = objects.map((candidate) => designJavaScriptObjectPropertyValue(candidate, propertyName));
        if (propertyCandidates.some((candidate) => candidate === undefined)) continue;
        assignPossibleValueProvenance(property.value, propertyCandidates, scope);
      }
    }
  };
  const assignPossibleStringProvenance = (
    pattern: unknown,
    candidates: readonly unknown[],
    scope: DesignJavaScriptScope,
  ): void => {
    if (!designJavaScriptNode(pattern) || candidates.length === 0) return;
    if (pattern.type === "Identifier" && typeof pattern.name === "string") {
      if (scope.invalidatedBindings.has(pattern.name)) return;
      const values = new Set<string>();
      for (const candidate of candidates) {
        const possible = designJavaScriptPossibleConstantStrings(candidate, index);
        if (possible === null) return;
        for (const value of possible) {
          values.add(value);
          if (values.size > 256) return;
        }
      }
      scope.possibleStrings.set(pattern.name, values);
      if (values.size === 1) scope.constantStrings.set(pattern.name, values.values().next().value!);
      return;
    }
    if (pattern.type === "AssignmentPattern") {
      assignPossibleStringProvenance(pattern.left, candidates.map((candidate) => (
        candidate === undefined ? pattern.right : candidate
      )), scope);
      return;
    }
    if (pattern.type === "ArrayPattern") {
      const arrays = candidates.map((candidate) => designJavaScriptStableValue(candidate, index));
      if (arrays.some((candidate) => candidate?.type !== "ArrayExpression")) return;
      const elements = Array.isArray(pattern.elements) ? pattern.elements : [];
      for (let elementIndex = 0; elementIndex < elements.length; elementIndex += 1) {
        const element = elements[elementIndex];
        if (element === null || element === undefined) continue;
        const elementCandidates = arrays.map((candidate) => (
          Array.isArray(candidate?.elements) ? candidate.elements[elementIndex] : undefined
        ));
        if (elementCandidates.some((candidate) => candidate === null || candidate === undefined)) continue;
        assignPossibleStringProvenance(element, elementCandidates, scope);
      }
      return;
    }
    if (pattern.type === "ObjectPattern") {
      const objects = candidates.map((candidate) => designJavaScriptStableValue(candidate, index));
      if (objects.some((candidate) => candidate?.type !== "ObjectExpression")) return;
      for (const property of Array.isArray(pattern.properties) ? pattern.properties : []) {
        if (!designJavaScriptNode(property) || property.type === "RestElement") continue;
        const propertyName = designJavaScriptObjectPropertyName(property);
        if (propertyName === null) continue;
        const propertyCandidates = objects.map((candidate) => (
          designJavaScriptObjectPropertyValue(candidate, propertyName)
        ));
        if (propertyCandidates.some((candidate) => candidate === undefined)) continue;
        assignPossibleStringProvenance(property.value, propertyCandidates, scope);
      }
    }
  };
  const propagateLocalCallArguments = (): void => {
    for (const [callable, sites] of callSites) {
      if (escapedFunctions.has(callable) || sites.length === 0) continue;
      if (sites.every((site) => site.receiver === "local")) index.localThisFunctions.add(callable);
      const parameters = Array.isArray(callable.params) ? callable.params : [];
      const parameterScope = index.scopeByNode.get(callable);
      if (parameterScope === undefined) continue;
      for (let parameterIndex = 0; parameterIndex < parameters.length; parameterIndex += 1) {
        const parameter = parameters[parameterIndex];
        const allLocal = sites.every((site) => {
          const argument = site.args[parameterIndex];
          if (argument !== undefined) return designJavaScriptProvenance(argument, index) === "local";
          return designJavaScriptNode(parameter) && parameter.type === "AssignmentPattern"
            && designJavaScriptProvenance(parameter.right, index) === "local";
        });
        if (allLocal) assignLocalParameterProvenance(parameter, parameterScope);
        const stringArguments = sites.map((site) => {
          const argument = site.args[parameterIndex];
          return argument === undefined && designJavaScriptNode(parameter) && parameter.type === "AssignmentPattern"
            ? parameter.right
            : argument;
        });
        if (!stringArguments.some((argument) => argument === undefined)) {
          assignPossibleValueProvenance(parameter, stringArguments, parameterScope);
          assignPossibleStringProvenance(parameter, stringArguments, parameterScope);
        }
      }
    }
  };
  propagateLocalCallArguments();

  // Destructuring a statically local presentation record is not a browser-state
  // probe. Preserve the provenance through direct declarations, for-of loops,
  // and callbacks over a literal local array while leaving imported, DOM, and
  // global sources unknown/fail-closed.
  visitDesignJavaScript(root, (node, parent, key) => {
    if (node.type === "VariableDeclarator" && designJavaScriptNode(node.id)) {
      const declaration = index.parentByNode.get(node);
      let source = node.init;
      let loop: DesignJavaScriptNode | null = null;
      if (!designJavaScriptNode(source)) {
        loop = declaration === undefined || declaration === null
          ? null
          : index.parentByNode.get(declaration) ?? null;
        if (loop !== null && (loop.type === "ForOfStatement" || loop.type === "ForInStatement")
          && loop.left === declaration) source = loop.right;
      }
      const patternScope = index.scopeByNode.get(node.id);
      const stableDeclaration = declaration?.type === "VariableDeclaration"
        && (declaration.kind === "const"
          || ((loop?.type === "ForOfStatement" || loop?.type === "ForInStatement")
            && declaration.kind === "let"));
      if (stableDeclaration && patternScope !== undefined
        && designJavaScriptProvenance(source, index) === "local") {
        assignLocalParameterProvenance(node.id, patternScope);
        if (loop?.type === "ForOfStatement") {
          const collections = designJavaScriptPossibleValues(source, index);
          const elements = collections?.flatMap((collection) => (
            designJavaScriptNode(collection) && collection.type === "ArrayExpression" && Array.isArray(collection.elements)
              ? collection.elements
              : [undefined]
          )) ?? [];
          if (elements.length > 0 && !elements.some((element) => element === null || element === undefined)) {
            assignPossibleValueProvenance(node.id, elements, patternScope);
            assignPossibleStringProvenance(node.id, elements, patternScope);
          }
        } else if (designJavaScriptNode(source)) {
          assignPossibleValueProvenance(node.id, [source], patternScope);
          assignPossibleStringProvenance(node.id, [source], patternScope);
        }
      }
    }
    if (designJavaScriptFunction(node) && parent !== null
      && (parent.type === "CallExpression" || parent.type === "OptionalCallExpression")
      && key === "arguments" && designJavaScriptNode(parent.callee)
      && (parent.callee.type === "MemberExpression" || parent.callee.type === "OptionalMemberExpression")
      && ["every", "filter", "find", "findLast", "flatMap", "forEach", "map", "some"]
        .includes(designJavaScriptMemberName(parent.callee, index) ?? "")) {
      const receivers = designJavaScriptPossibleValues(parent.callee.object, index);
      const receiverElements = receivers?.flatMap((receiver) => (
        designJavaScriptNode(receiver) && receiver.type === "ArrayExpression" && Array.isArray(receiver.elements)
          ? receiver.elements
          : [undefined]
      )) ?? [];
      if (receiverElements.length === 0 || receiverElements.some((element) => element === null || element === undefined)) return;
      const parameterScope = index.scopeByNode.get(node);
      if (parameterScope === undefined) return;
      const parameters = Array.isArray(node.params) ? node.params : [];
      for (const parameter of parameters) assignLocalParameterProvenance(parameter, parameterScope);
      if (parameters[0] !== undefined) {
        assignPossibleValueProvenance(parameters[0], receiverElements, parameterScope);
        assignPossibleStringProvenance(parameters[0], receiverElements, parameterScope);
      }
    }
  });
  // Local loop/callback bindings can feed helper parameters, and helpers can
  // feed other helpers. Iterate over the finite static call graph so provenance
  // reaches a fixed point without treating escaped or imported callables as local.
  for (let pass = 0; pass <= callSites.size; pass += 1) propagateLocalCallArguments();
  return index;
}

function hasDesignJavaScriptBinding(scope: DesignJavaScriptScope | undefined, name: string): boolean {
  let current = scope;
  while (current !== undefined) {
    if (current.bindings.has(name)) return true;
    current = current.parent ?? undefined;
  }
  return false;
}

function designJavaScriptBindingScope(
  scope: DesignJavaScriptScope | undefined,
  name: string,
): DesignJavaScriptScope | null {
  let current = scope;
  while (current !== undefined) {
    if (current.bindings.has(name)) return current;
    current = current.parent ?? undefined;
  }
  return null;
}

function designJavaScriptStableValue(
  value: unknown,
  index: DesignJavaScriptIndex,
  seen: Set<unknown> = new Set<unknown>(),
): DesignJavaScriptNode | null {
  if (!designJavaScriptNode(value) || seen.has(value)) return null;
  seen.add(value);
  if (value.type === "Identifier" && typeof value.name === "string") {
    const scope = designJavaScriptBindingScope(index.scopeByNode.get(value), value.name);
    return scope?.stableValues.has(value.name) === true
      ? designJavaScriptStableValue(scope.stableValues.get(value.name), index, seen)
      : null;
  }
  if (value.type === "MemberExpression" || value.type === "OptionalMemberExpression") {
    const receiver = designJavaScriptStableValue(value.object, index, seen);
    const memberName = designJavaScriptMemberName(value, index);
    if (receiver === null || memberName === null) return null;
    if (receiver.type === "ObjectExpression" && Array.isArray(receiver.properties)) {
      const property = receiver.properties.find((candidate) => designJavaScriptNode(candidate)
        && designJavaScriptObjectPropertyName(candidate) === memberName);
      if (!designJavaScriptNode(property)) return null;
      return property.type === "ObjectMethod" ? property : designJavaScriptStableValue(property.value, index, seen);
    }
    const receiverClass = receiver.type === "NewExpression"
      ? designJavaScriptStableValue(receiver.callee, index, seen)
      : receiver;
    if (receiverClass !== null && (receiverClass.type === "ClassDeclaration" || receiverClass.type === "ClassExpression")
      && designJavaScriptNode(receiverClass.body) && Array.isArray(receiverClass.body.body)) {
      const method = receiverClass.body.body.find((candidate) => designJavaScriptNode(candidate)
        && candidate.static === (receiver.type !== "NewExpression")
        && designJavaScriptObjectPropertyName(candidate) === memberName);
      if (!designJavaScriptNode(method)) return null;
      return designJavaScriptFunction(method) ? method : designJavaScriptStableValue(method.value, index, seen);
    }
    return null;
  }
  return value;
}

function designJavaScriptCallable(value: unknown, index: DesignJavaScriptIndex): boolean {
  if (!designJavaScriptNode(value)) return false;
  const resolved = designJavaScriptStableValue(value, index);
  if (resolved !== null && designJavaScriptFunction(resolved)) return true;
  if (value.type === "CallExpression" && designJavaScriptNode(value.callee)
    && (value.callee.type === "MemberExpression" || value.callee.type === "OptionalMemberExpression")
    && designJavaScriptMemberName(value.callee, index) === "bind") {
    return designJavaScriptCallable(value.callee.object, index);
  }
  return false;
}

function designJavaScriptPossibleValues(
  value: unknown,
  index: DesignJavaScriptIndex,
): readonly unknown[] | null {
  if (!designJavaScriptNode(value)) return null;
  if (["TSAsExpression", "TSInstantiationExpression", "TSNonNullExpression", "TSSatisfiesExpression", "TSTypeAssertion"]
    .includes(value.type)) {
    return designJavaScriptPossibleValues(value.expression, index);
  }
  if (value.type === "Identifier" && typeof value.name === "string") {
    let scope = index.scopeByNode.get(value);
    while (scope !== undefined) {
      if (scope.invalidatedBindings.has(value.name)) return null;
      const possible = scope.possibleValues.get(value.name);
      if (possible !== undefined) return possible;
      if (scope.stableValues.has(value.name)) return [scope.stableValues.get(value.name)];
      if (scope.bindings.has(value.name)) return null;
      scope = scope.parent ?? undefined;
    }
    return null;
  }
  if (value.type === "MemberExpression" || value.type === "OptionalMemberExpression") {
    const receivers = designJavaScriptPossibleValues(value.object, index);
    if (receivers === null) return null;
    const memberName = designJavaScriptMemberName(value, index);
    const numericIndex = value.computed === true && designJavaScriptNode(value.property)
      && value.property.type === "NumericLiteral" && typeof value.property.value === "number"
      ? value.property.value
      : null;
    const results: unknown[] = [];
    for (const receiver of receivers) {
      if (!designJavaScriptNode(receiver)) return null;
      if (receiver.type === "ObjectExpression" && memberName !== null) {
        const propertyValue = designJavaScriptObjectPropertyValue(receiver, memberName);
        if (propertyValue === undefined) return null;
        results.push(propertyValue);
      } else if (receiver.type === "ArrayExpression" && numericIndex !== null
        && Array.isArray(receiver.elements)) {
        const element = receiver.elements[numericIndex];
        if (element === null || element === undefined) return null;
        results.push(element);
      } else {
        return null;
      }
      if (results.length > 256) return null;
    }
    return results;
  }
  if ((value.type === "CallExpression" || value.type === "OptionalCallExpression")
    && designJavaScriptNode(value.callee)
    && (value.callee.type === "MemberExpression" || value.callee.type === "OptionalMemberExpression")
    && designJavaScriptMemberName(value.callee, index) === "slice") {
    const receivers = designJavaScriptPossibleValues(value.callee.object, index);
    return receivers !== null && receivers.every((receiver) => (
      designJavaScriptNode(receiver) && receiver.type === "ArrayExpression"
    )) ? receivers : null;
  }
  return [value];
}

function designJavaScriptPossibleConstantStrings(
  value: unknown,
  index: DesignJavaScriptIndex,
): ReadonlySet<string> | null {
  const direct = staticDesignJavaScriptString(value);
  if (direct !== null) return new Set([direct]);
  if (designJavaScriptNode(value) && value.type === "Identifier" && typeof value.name === "string") {
    let scope = index.scopeByNode.get(value);
    while (scope !== undefined) {
      if (scope.invalidatedBindings.has(value.name)) return null;
      const possible = scope.possibleStrings.get(value.name);
      if (possible !== undefined) return possible;
      if (scope.stableValues.has(value.name)) {
        const stable = staticDesignJavaScriptString(scope.stableValues.get(value.name));
        if (stable !== null) return new Set([stable]);
      }
      if (scope.bindings.has(value.name)) break;
      scope = scope.parent ?? undefined;
    }
  }
  const candidates = designJavaScriptPossibleValues(value, index);
  if (candidates === null || candidates.length === 0) return null;
  const strings = new Set<string>();
  for (const candidate of candidates) {
    const string = staticDesignJavaScriptString(candidate);
    if (string === null) return null;
    strings.add(string);
    if (strings.size > 256) return null;
  }
  return strings;
}

function designJavaScriptConstantString(
  value: unknown,
  index: DesignJavaScriptIndex,
): string | null {
  const possible = designJavaScriptPossibleConstantStrings(value, index);
  return possible?.size === 1 ? possible.values().next().value ?? null : null;
}

function designJavaScriptPatternIsLocal(
  pattern: unknown,
  index: DesignJavaScriptIndex,
): boolean {
  if (!designJavaScriptNode(pattern)) return false;
  if (pattern.type === "Identifier") return designJavaScriptProvenance(pattern, index) === "local";
  if (pattern.type === "RestElement") return designJavaScriptPatternIsLocal(pattern.argument, index);
  if (pattern.type === "AssignmentPattern") return designJavaScriptPatternIsLocal(pattern.left, index);
  if (pattern.type === "ArrayPattern") {
    return (Array.isArray(pattern.elements) ? pattern.elements : [])
      .filter((element) => element !== null)
      .every((element) => designJavaScriptPatternIsLocal(element, index));
  }
  if (pattern.type === "ObjectPattern") {
    return (Array.isArray(pattern.properties) ? pattern.properties : []).every((property) => {
      if (!designJavaScriptNode(property)) return false;
      return designJavaScriptPatternIsLocal(
        property.type === "RestElement" ? property.argument : property.value,
        index,
      );
    });
  }
  return false;
}

function designJavaScriptReference(
  node: DesignJavaScriptNode,
  parent: DesignJavaScriptNode | null,
  key: string | null,
  index: DesignJavaScriptIndex,
): boolean {
  if (node.type !== "Identifier" || index.bindings.has(node)) return false;
  if (parent === null) return true;
  if (parent.type.startsWith("TS")) {
    const runtimeExpression = [
      "TSAsExpression",
      "TSInstantiationExpression",
      "TSNonNullExpression",
      "TSSatisfiesExpression",
      "TSTypeAssertion",
    ].includes(parent.type) && key === "expression";
    const runtimeParameter = parent.type === "TSParameterProperty" && key === "parameter";
    if (!runtimeExpression && !runtimeParameter) return false;
  }
  if ((parent.type === "MemberExpression" || parent.type === "OptionalMemberExpression")
    && key === "property" && parent.computed !== true) return false;
  if ((parent.type === "ObjectProperty" || parent.type === "ObjectMethod"
      || parent.type === "ClassProperty" || parent.type === "ClassMethod"
      || parent.type === "ClassPrivateProperty" || parent.type === "ClassPrivateMethod")
    && key === "key" && parent.computed !== true) return false;
  if ((parent.type === "LabeledStatement" || parent.type === "BreakStatement" || parent.type === "ContinueStatement")
    && key === "label") return false;
  if (parent.type === "MetaProperty" || parent.type === "PrivateName") return false;
  if ((parent.type === "ImportSpecifier" && key === "imported")
    || ((parent.type === "ExportSpecifier" || parent.type === "ExportNamespaceSpecifier") && key === "exported")) {
    return false;
  }
  return true;
}

function staticDesignJavaScriptString(value: unknown): string | null {
  if (!designJavaScriptNode(value)) return null;
  if (["TSAsExpression", "TSInstantiationExpression", "TSNonNullExpression", "TSSatisfiesExpression", "TSTypeAssertion"]
    .includes(value.type)) return staticDesignJavaScriptString(value.expression);
  if (value.type === "StringLiteral" && typeof value.value === "string") return value.value;
  if (value.type === "TemplateLiteral"
    && Array.isArray(value.expressions) && value.expressions.length === 0
    && Array.isArray(value.quasis) && value.quasis.length === 1) {
    const quasi = value.quasis[0];
    if (designJavaScriptNode(quasi) && quasi.type === "TemplateElement"
      && quasi.value !== null && typeof quasi.value === "object") {
      const cooked = (quasi.value as { cooked?: unknown }).cooked;
      return typeof cooked === "string" ? cooked : null;
    }
  }
  if (value.type === "BinaryExpression" && value.operator === "+") {
    const left = staticDesignJavaScriptString(value.left);
    const right = staticDesignJavaScriptString(value.right);
    return left === null || right === null ? null : left + right;
  }
  return null;
}

function designJavaScriptMemberName(node: DesignJavaScriptNode, index?: DesignJavaScriptIndex): string | null {
  if (node.type !== "MemberExpression" && node.type !== "OptionalMemberExpression") return null;
  if (node.computed !== true && designJavaScriptNode(node.property)
    && node.property.type === "Identifier" && typeof node.property.name === "string") {
    return node.property.name;
  }
  return index === undefined
    ? staticDesignJavaScriptString(node.property)
    : designJavaScriptConstantString(node.property, index);
}

const DESIGN_JAVASCRIPT_NETWORK_GLOBALS = new Set([
  "fetch",
  "XMLHttpRequest",
  "WebSocket",
  "EventSource",
  "WebTransport",
  "Worker",
  "SharedWorker",
  "importScripts",
  "Image",
  "Audio",
  "RTCPeerConnection",
]);
const DESIGN_JAVASCRIPT_NETWORK_MEMBER_CAPABILITIES = new Set([
  ...DESIGN_JAVASCRIPT_NETWORK_GLOBALS,
  "sendBeacon",
  "send",
  "connect",
  "addModule",
  "register",
]);
const DESIGN_JAVASCRIPT_WINDOW_MEMBER_CAPABILITIES = new Set([
  "open",
  "postMessage",
]);
const DESIGN_JAVASCRIPT_DYNAMIC_CODE_GLOBALS = new Set([
  "eval",
  "Function",
  "AsyncFunction",
  "GeneratorFunction",
  "AsyncGeneratorFunction",
]);
const DESIGN_JAVASCRIPT_TIMER_GLOBALS = new Set(["setTimeout", "setInterval"]);
const DESIGN_JAVASCRIPT_EXPORT_SCHEDULER_GLOBALS = new Set([
  "setTimeout",
  "setInterval",
  "requestAnimationFrame",
  "requestIdleCallback",
  "queueMicrotask",
]);
const DESIGN_JAVASCRIPT_EXPORT_STATE_GLOBALS = new Set([
  "navigator",
  "screen",
  "devicePixelRatio",
  "matchMedia",
  "visualViewport",
  "performance",
  "chrome",
  "name",
  "localStorage",
  "sessionStorage",
  "indexedDB",
  "caches",
  "cookieStore",
  "Storage",
  "StorageManager",
  "IDBFactory",
  "IDBDatabase",
  "IDBObjectStore",
  "IDBTransaction",
  "IDBRequest",
  "IDBCursor",
  "IDBKeyRange",
]);
const DESIGN_JAVASCRIPT_EXPORT_STATE_MEMBERS = new Set([
  ...DESIGN_JAVASCRIPT_EXPORT_STATE_GLOBALS,
  "cookie",
  "hasStorageAccess",
  "requestStorageAccess",
  "webdriver",
  "outerWidth",
  "outerHeight",
  "__lookupGetter__",
  "__lookupSetter__",
]);
const DESIGN_JAVASCRIPT_EXPORT_ANIMATION_GLOBALS = new Set([
  "Animation",
  "AnimationEvent",
  "DocumentTimeline",
  "KeyframeEffect",
]);
const DESIGN_JAVASCRIPT_EXPORT_ANIMATION_MEMBERS = new Set([
  "animate",
  "getAnimations",
  "timeline",
  "animation",
  "animationDelay",
  "animationDuration",
  "animationName",
  "animationTimeline",
  "transition",
  "transitionDelay",
  "transitionDuration",
  "transitionProperty",
  "scrollTimeline",
  "viewTimeline",
]);
const DESIGN_JAVASCRIPT_EXPORT_REFLECTION_MEMBERS = new Set([
  "entries",
  "getOwnPropertyDescriptor",
  "getOwnPropertyDescriptors",
  "getOwnPropertyNames",
  "getOwnPropertySymbols",
  "has",
  "keys",
  "ownKeys",
  "values",
]);
const DESIGN_JAVASCRIPT_GLOBAL_NAMESPACES = new Set([
  "window",
  "self",
  "globalThis",
  "document",
  "navigator",
]);
const DESIGN_JAVASCRIPT_PARENT_GLOBALS = new Set(["top", "parent", "opener", "frames", "frameElement"]);
const DESIGN_JAVASCRIPT_URL_PROPERTIES = new Set([
  "src",
  "srcset",
  "href",
  "poster",
  "action",
  "formAction",
  "formaction",
]);
const DESIGN_JAVASCRIPT_MARKUP_PROPERTIES = new Set(["innerHTML", "outerHTML", "srcdoc"]);
const DESIGN_JAVASCRIPT_CSS_URL_PROPERTIES = new Set([
  "background",
  "backgroundImage",
  "borderImage",
  "borderImageSource",
  "content",
  "cursor",
  "filter",
  "listStyle",
  "listStyleImage",
  "mask",
  "maskImage",
  "clipPath",
  "offsetPath",
  "shapeOutside",
]);
const DESIGN_JAVASCRIPT_MARKUP_METHODS = new Set([
  "insertAdjacentHTML",
  "setHTMLUnsafe",
  "createContextualFragment",
  "write",
  "writeln",
  "parseFromString",
]);
const DESIGN_JAVASCRIPT_NAVIGATION_METHODS = new Set(["assign", "replace", "reload"]);
const DESIGN_JAVASCRIPT_HISTORY_METHODS = new Set(["pushState", "replaceState", "go", "back", "forward"]);
const DESIGN_JAVASCRIPT_UNSAFE_CREATED_ELEMENTS = new Set([
  "script",
  "style",
  "link",
  "base",
  "meta",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "portal",
  "fencedframe",
]);

interface DesignJavaScriptGlobalPath {
  root: string;
  path: string[];
  dynamic: boolean;
}

function designJavaScriptGlobalPath(
  value: unknown,
  index: DesignJavaScriptIndex,
): DesignJavaScriptGlobalPath | null {
  if (!designJavaScriptNode(value)) return null;
  if (value.type === "ThisExpression") {
    const owner = index.thisOwnerByNode.get(value);
    if (owner !== undefined && index.localThisFunctions.has(owner)) return null;
    return { root: "window", path: [], dynamic: false };
  }
  if (value.type === "Identifier" && typeof value.name === "string"
    && !hasDesignJavaScriptBinding(index.scopeByNode.get(value), value.name)) {
    return { root: value.name, path: [], dynamic: false };
  }
  if (value.type !== "MemberExpression" && value.type !== "OptionalMemberExpression") return null;
  const base = designJavaScriptGlobalPath(value.object, index);
  if (base === null) return null;
  const member = designJavaScriptMemberName(value, index);
  return {
    root: base.root,
    path: member === null ? base.path : [...base.path, member],
    dynamic: base.dynamic || member === null,
  };
}

function designJavaScriptSafeProbe(
  node: DesignJavaScriptNode,
  parent: DesignJavaScriptNode | null,
  key: string | null,
): boolean {
  if (parent?.type === "UnaryExpression" && key === "argument"
    && ["typeof", "void", "!"].includes(String(parent.operator))) return true;
  if (parent?.type === "BinaryExpression"
    && ["===", "!==", "==", "!=", "in"].includes(String(parent.operator))) return true;
  return parent?.type === "ExpressionStatement" && key === "expression";
}

function designJavaScriptMemberObject(
  parent: DesignJavaScriptNode | null,
  key: string | null,
): boolean {
  return (parent?.type === "MemberExpression" || parent?.type === "OptionalMemberExpression") && key === "object";
}

function designJavaScriptWriteTarget(
  parent: DesignJavaScriptNode | null,
  key: string | null,
): boolean {
  return (parent?.type === "AssignmentExpression" && key === "left")
    || (parent?.type === "UpdateExpression" && key === "argument")
    || (parent?.type === "UnaryExpression" && parent.operator === "delete" && key === "argument")
    || ((parent?.type === "ForInStatement" || parent?.type === "ForOfStatement") && key === "left");
}

function designJavaScriptCapabilityEscapes(
  node: DesignJavaScriptNode,
  parent: DesignJavaScriptNode | null,
  key: string | null,
): boolean {
  if (designJavaScriptSafeProbe(node, parent, key) || designJavaScriptMemberObject(parent, key)) return false;
  if (parent?.type === "UnaryExpression" && key === "argument") return false;
  if (parent?.type === "BinaryExpression" || parent?.type === "LogicalExpression"
    || parent?.type === "ConditionalExpression" || parent?.type === "IfStatement"
    || parent?.type === "WhileStatement" || parent?.type === "DoWhileStatement") return false;
  return true;
}

function designJavaScriptEffectivePath(path: DesignJavaScriptGlobalPath): { root: string; path: string[] } {
  if (["window", "self", "globalThis"].includes(path.root) && path.path.length > 0) {
    return { root: path.path[0]!, path: path.path.slice(1) };
  }
  return { root: path.root, path: path.path };
}

const DESIGN_JAVASCRIPT_DOM_RETURNING_METHODS = new Set([
  "querySelector",
  "getElementById",
  "getElementsByClassName",
  "getElementsByName",
  "getElementsByTagName",
  "closest",
  "createElement",
  "createElementNS",
  "createDocumentFragment",
  "createRange",
  "cloneNode",
]);
const DESIGN_JAVASCRIPT_PARENT_ESCAPE_PROPERTIES = new Set([
  "ownerDocument",
  "defaultView",
  "contentWindow",
  "contentDocument",
]);

function designJavaScriptProvenance(
  value: unknown,
  index: DesignJavaScriptIndex,
  seen: Set<unknown> = new Set<unknown>(),
): DesignJavaScriptProvenance {
  if (!designJavaScriptNode(value) || seen.has(value)) return "unknown";
  seen.add(value);
  if (["TSAsExpression", "TSInstantiationExpression", "TSNonNullExpression", "TSSatisfiesExpression", "TSTypeAssertion"]
    .includes(value.type)) return designJavaScriptProvenance(value.expression, index, seen);
  if ([
    "ObjectExpression", "ArrayExpression", "FunctionExpression", "ArrowFunctionExpression",
    "ClassExpression", "StringLiteral", "NumericLiteral", "BooleanLiteral", "NullLiteral", "TemplateLiteral",
  ].includes(value.type)) return "local";
  if (value.type === "ThisExpression") {
    const owner = index.thisOwnerByNode.get(value);
    return owner !== undefined && index.localThisFunctions.has(owner) ? "local" : "global";
  }
  if (value.type === "Identifier" && typeof value.name === "string") {
    const binding = designJavaScriptBindingScope(index.scopeByNode.get(value), value.name);
    if (binding === null) {
      return ["document"].includes(value.name) ? "dom"
        : DESIGN_JAVASCRIPT_GLOBAL_NAMESPACES.has(value.name)
          || DESIGN_JAVASCRIPT_PARENT_GLOBALS.has(value.name)
          || ["location", "history", "open"].includes(value.name)
          ? "global"
          : "unknown";
    }
    const parameterProvenance = binding.provenances.get(value.name);
    if (parameterProvenance !== undefined) return parameterProvenance;
    if (!binding.reassignedBindings.has(value.name) && binding.initializers.has(value.name)) {
      return designJavaScriptProvenance(binding.initializers.get(value.name), index, seen);
    }
    if (binding.invalidatedBindings.has(value.name) || !binding.stableValues.has(value.name)) return "unknown";
    return designJavaScriptProvenance(binding.stableValues.get(value.name), index, seen);
  }
  if (value.type === "NewExpression") {
    const calleePath = designJavaScriptGlobalPath(value.callee, index);
    if (calleePath !== null) {
      const root = designJavaScriptEffectivePath(calleePath).root;
      if (["DOMParser", "Range"].includes(root)) return "dom";
      if (root === "CSSStyleSheet") return "style";
    }
    return "local";
  }
  if (value.type === "CallExpression" || value.type === "OptionalCallExpression") {
    if (!designJavaScriptNode(value.callee)) return "unknown";
    const calleeName = value.callee.type === "MemberExpression" || value.callee.type === "OptionalMemberExpression"
      ? designJavaScriptMemberName(value.callee, index)
      : null;
    const calleePath = designJavaScriptGlobalPath(value.callee, index);
    if (calleePath !== null) {
      const effective = designJavaScriptEffectivePath(calleePath);
      if (effective.root === "document" && DESIGN_JAVASCRIPT_DOM_RETURNING_METHODS.has(calleeName ?? "")) return "dom";
      if (effective.root === "Object" && calleeName === "assign" && Array.isArray(value.arguments)) {
        return designJavaScriptProvenance(value.arguments[0], index, seen);
      }
    }
    if (value.callee.type === "MemberExpression" || value.callee.type === "OptionalMemberExpression") {
      const receiver = designJavaScriptProvenance(value.callee.object, index, seen);
      if (DESIGN_JAVASCRIPT_DOM_RETURNING_METHODS.has(calleeName ?? "") && receiver === "dom") return "dom";
      if (receiver === "local" && [
        "at", "concat", "every", "filter", "find", "findIndex", "findLast", "findLastIndex",
        "flat", "flatMap", "includes", "indexOf", "join", "lastIndexOf", "map", "reduce",
        "reduceRight", "slice", "some", "split", "substring", "substr", "toLowerCase",
        "toUpperCase", "trim", "trimEnd", "trimStart",
      ].includes(calleeName ?? "")) return "local";
    }
    return "unknown";
  }
  if (value.type === "MemberExpression" || value.type === "OptionalMemberExpression") {
    const globalPath = designJavaScriptGlobalPath(value, index);
    if (globalPath !== null) {
      const effective = designJavaScriptEffectivePath(globalPath);
      if (effective.root === "document") {
        if (DESIGN_JAVASCRIPT_PARENT_ESCAPE_PROPERTIES.has(effective.path[0] ?? "")) return "global";
        if (effective.path.at(-1) === "style") return "style";
        if (["dataset", "classList"].includes(effective.path.at(-1) ?? "")) return "local";
        return "dom";
      }
      if (["window", "self", "globalThis", "navigator", "location", "history"].includes(effective.root)
        || DESIGN_JAVASCRIPT_PARENT_GLOBALS.has(effective.root)) return "global";
    }
    const receiver = designJavaScriptProvenance(value.object, index, seen);
    const memberName = designJavaScriptMemberName(value, index);
    if (receiver === "local") return "local";
    if (receiver === "style") return "style";
    if (receiver === "dom" && memberName === "style") return "style";
    if (receiver === "dom" && ["dataset", "classList"].includes(memberName ?? "")) return "local";
    if (receiver === "dom" && [
      "body", "head", "documentElement", "parentElement", "firstElementChild", "lastElementChild",
      "nextElementSibling", "previousElementSibling", "children",
    ].includes(memberName ?? "")) return "dom";
    return receiver === "global" ? "global" : "unknown";
  }
  return "unknown";
}

function designJavaScriptUnsafeReceiver(
  value: unknown,
  index: DesignJavaScriptIndex,
): boolean {
  return designJavaScriptProvenance(value, index) !== "local";
}

function designJavaScriptObjectPropertyName(
  property: DesignJavaScriptNode,
): string | null {
  if (!["ObjectProperty", "ObjectMethod", "ClassProperty", "ClassMethod", "ClassPrivateProperty", "ClassPrivateMethod"]
    .includes(property.type)) return null;
  if (property.computed !== true && designJavaScriptNode(property.key)
    && property.key.type === "Identifier" && typeof property.key.name === "string") return property.key.name;
  return staticDesignJavaScriptString(property.key);
}

function designJavaScriptObjectPropertyValue(
  value: unknown,
  propertyName: string,
): unknown {
  if (!designJavaScriptNode(value) || value.type !== "ObjectExpression" || !Array.isArray(value.properties)) {
    return undefined;
  }
  const property = value.properties.find((candidate) => designJavaScriptNode(candidate)
    && designJavaScriptObjectPropertyName(candidate) === propertyName);
  return designJavaScriptNode(property) && property.type === "ObjectProperty" ? property.value : undefined;
}

function designJavaScriptSelfTarget(value: unknown, index: DesignJavaScriptIndex): boolean {
  return designJavaScriptConstantString(value, index)?.trim().toLowerCase() === "_self";
}

function validateDesignJavaScriptUrl(
  value: unknown,
  index: DesignJavaScriptIndex,
  allowCanonicalAssets: boolean,
  exportProject = false,
  onAllowedUrl?: (url: string, value: unknown) => void,
): boolean {
  const urls = designJavaScriptPossibleConstantStrings(value, index);
  const allowed = urls !== null && urls.size > 0 && [...urls].every((url) => (
    allowedDesignUrl(url, allowCanonicalAssets)
    || (exportProject && allowedDesignExportUrl(url))
  ));
  if (allowed) for (const url of urls!) onAllowedUrl?.(url, value);
  return allowed;
}

export interface DesignJavaScriptUrlSink {
  readonly url: string;
  readonly sourceRange: { readonly start: number; readonly end: number } | null;
}

function designJavaScriptExactUrlSourceRange(
  value: unknown,
  index: DesignJavaScriptIndex,
  script: string,
  url: string,
): DesignJavaScriptUrlSink["sourceRange"] {
  const source = designJavaScriptStableValue(value, index);
  const semantic = source === null ? null : staticDesignJavaScriptString(source);
  if (source === null || !["StringLiteral", "TemplateLiteral"].includes(source.type)
    || semantic === null || !semantic.includes(url)) return null;
  const start = typeof source.start === "number" ? source.start : null;
  const end = typeof source.end === "number" ? source.end : null;
  if (start === null || end === null || start < 0 || end < start || end > script.length) return null;
  const relative = script.slice(start, end).indexOf(url);
  return relative < 0 ? null : { start: start + relative, end: start + relative + url.length };
}

function allowedDesignExportUrl(value: string): boolean {
  const url = value.trim();
  if (url.startsWith("#") || url.startsWith("blob:")) return true;
  if (/^data:(?:image|font)\/[a-z0-9.+-]+(?:;[a-z0-9.+-]+=[^;,]*)*;base64,[a-z0-9+/=\s]+$/i.test(url)) return true;
  if (/[\u0000-\u001f\u007f\\]/.test(url) || url.startsWith("//")) return false;
  return url.startsWith("/") || url.startsWith("./") || url.startsWith("../");
}

function allowedDesignExportModuleSpecifier(value: unknown): boolean {
  return designJavaScriptNode(value) && value.type === "StringLiteral"
    && typeof value.value === "string"
    && /^(?:\.\/|\.\.\/)[A-Za-z0-9._/-]+$/.test(value.value)
    && !value.value.split("/").includes(".context");
}

function validateDesignJavaScript(
  script: string,
  allowCanonicalAssets: boolean,
  sourceType: "script" | "module" = "script",
  exportProject = false,
  onAllowedUrl?: (sink: DesignJavaScriptUrlSink) => void,
): void {
  let syntax: ReturnType<typeof parse>;
  try {
    syntax = parse(script, {
      sourceType,
      plugins: exportProject ? ["typescript", "jsx"] : [],
    });
  } catch {
    throw new DesignStorageError("invalid-html", "Generated inline JavaScript is invalid");
  }
  const program: unknown = syntax.program;
  if (!designJavaScriptNode(program)) {
    throw new DesignStorageError("invalid-html", "Generated inline JavaScript is invalid");
  }
  const index = indexDesignJavaScript(program);
  const recordAllowedUrl = (url: string, value: unknown): void => {
    onAllowedUrl?.({
      url,
      sourceRange: designJavaScriptExactUrlSourceRange(value, index, script, url),
    });
  };
  let accessesParentNavigation = false;
  let accessesRemoteContent = false;
  let remoteContentViolation: string | null = null;
  let changesNavigation = false;
  let opensWindow = false;
  let evaluatesDynamicCode = false;
  let injectsMarkup = false;
  visitDesignJavaScript(program, (node, parent, key) => {
    if (node.type === "Identifier" && typeof node.name === "string"
      && designJavaScriptReference(node, parent, key, index)
      && !hasDesignJavaScriptBinding(index.scopeByNode.get(node), node.name)) {
      const safeProbe = designJavaScriptSafeProbe(node, parent, key);
      if (DESIGN_JAVASCRIPT_PARENT_GLOBALS.has(node.name)) accessesParentNavigation = true;
      if (DESIGN_JAVASCRIPT_NETWORK_GLOBALS.has(node.name) && !safeProbe) accessesRemoteContent = true;
      if (DESIGN_JAVASCRIPT_DYNAMIC_CODE_GLOBALS.has(node.name) && !safeProbe) evaluatesDynamicCode = true;
      if (node.name === "open" && !safeProbe) opensWindow = true;
      if (DESIGN_JAVASCRIPT_TIMER_GLOBALS.has(node.name) && !safeProbe
        && !(parent?.type === "CallExpression" && key === "callee")) evaluatesDynamicCode = true;
      if ((node.name === "location" || node.name === "history") && !safeProbe
        && !designJavaScriptMemberObject(parent, key)
        && designJavaScriptCapabilityEscapes(node, parent, key)) changesNavigation = true;
      if (DESIGN_JAVASCRIPT_GLOBAL_NAMESPACES.has(node.name) && !safeProbe
        && !designJavaScriptMemberObject(parent, key)) accessesRemoteContent = true;
    }
    if (node.type === "MemberExpression" || node.type === "OptionalMemberExpression") {
      const memberName = designJavaScriptMemberName(node, index);
      const globalPath = designJavaScriptGlobalPath(node, index);
      const receiver = designJavaScriptProvenance(node.object, index);
      const unsafeReceiver = receiver !== "local";
      const safeProbe = designJavaScriptSafeProbe(node, parent, key);
      if (memberName === "constructor" && !designJavaScriptSafeProbe(node, parent, key)) evaluatesDynamicCode = true;
      if (unsafeReceiver && memberName !== null && !safeProbe
        && DESIGN_JAVASCRIPT_NETWORK_MEMBER_CAPABILITIES.has(memberName)) accessesRemoteContent = true;
      if (unsafeReceiver && memberName !== null && !safeProbe
        && DESIGN_JAVASCRIPT_WINDOW_MEMBER_CAPABILITIES.has(memberName)) opensWindow = true;
      if (DESIGN_JAVASCRIPT_PARENT_ESCAPE_PROPERTIES.has(memberName ?? "") && unsafeReceiver) {
        accessesParentNavigation = true;
      }
      if (designJavaScriptWriteTarget(parent, key) && memberName === null && unsafeReceiver) accessesRemoteContent = true;
      if (designJavaScriptWriteTarget(parent, key) && unsafeReceiver
        && DESIGN_JAVASCRIPT_MARKUP_PROPERTIES.has(memberName ?? "")) {
        injectsMarkup = true;
      }
      if (globalPath !== null) {
        const effective = designJavaScriptEffectivePath(globalPath);
        const first = effective.path[0] ?? null;
        const last = effective.path.at(-1) ?? null;
        const safeProbe = designJavaScriptSafeProbe(node, parent, key);
        if (globalPath.dynamic && [
          "window", "self", "globalThis", "document", "navigator", "location", "history",
          "top", "parent", "opener", "frames", "frameElement",
        ].includes(globalPath.root)) accessesRemoteContent = true;
        if (DESIGN_JAVASCRIPT_PARENT_GLOBALS.has(effective.root)
          || (effective.root === "document" && first === "defaultView")) accessesParentNavigation = true;
        if (DESIGN_JAVASCRIPT_NETWORK_GLOBALS.has(effective.root) && !safeProbe) accessesRemoteContent = true;
        if (DESIGN_JAVASCRIPT_DYNAMIC_CODE_GLOBALS.has(effective.root) && !safeProbe) evaluatesDynamicCode = true;
        if (effective.root === "open" && !safeProbe) opensWindow = true;
        if (DESIGN_JAVASCRIPT_TIMER_GLOBALS.has(effective.root) && !safeProbe
          && !(parent?.type === "CallExpression" && key === "callee")) evaluatesDynamicCode = true;
        if (["window", "self", "globalThis", "document", "navigator"].includes(effective.root)
          && effective.path.length === 0 && !safeProbe
          && designJavaScriptCapabilityEscapes(node, parent, key)) accessesRemoteContent = true;
        if (effective.root === "location") {
          if (designJavaScriptWriteTarget(parent, key)
            || (first !== null && DESIGN_JAVASCRIPT_NAVIGATION_METHODS.has(first) && !safeProbe)
            || (effective.path.length === 0 && designJavaScriptCapabilityEscapes(node, parent, key))) {
            changesNavigation = true;
          }
        }
        if (effective.root === "history") {
          if (designJavaScriptWriteTarget(parent, key)
            || (first !== null && DESIGN_JAVASCRIPT_HISTORY_METHODS.has(first) && !safeProbe)
            || (effective.path.length === 0 && designJavaScriptCapabilityEscapes(node, parent, key))) {
            changesNavigation = true;
          }
        }
        if (effective.root === "navigator" && (first === "sendBeacon" || first === "serviceWorker") && !safeProbe) {
          accessesRemoteContent = true;
        }
        if (effective.root === "document" && (first === "location"
          || (first === "defaultView" && last === "location"))) changesNavigation = true;
      }
    }
    if ((node.type === "ImportDeclaration" || node.type === "ExportAllDeclaration"
      || (node.type === "ExportNamedDeclaration" && node.source !== null && node.source !== undefined))
      && !(exportProject && allowedDesignExportModuleSpecifier(node.source))) {
      accessesRemoteContent = true;
    }
    if (node.type === "ImportExpression"
      || (node.type === "CallExpression" && designJavaScriptNode(node.callee) && node.callee.type === "Import")) {
      accessesRemoteContent = true;
    }
    if (node.type === "AssignmentExpression" && designJavaScriptNode(node.left)
      && (node.left.type === "MemberExpression" || node.left.type === "OptionalMemberExpression")) {
      const memberName = designJavaScriptMemberName(node.left, index);
      const receiver = designJavaScriptProvenance(node.left.object, index);
      const unsafeReceiver = receiver !== "local";
      if (unsafeReceiver && DESIGN_JAVASCRIPT_URL_PROPERTIES.has(memberName ?? "")) {
          if (!validateDesignJavaScriptUrl(
            node.right,
            index,
            allowCanonicalAssets,
            exportProject,
            recordAllowedUrl,
          )) accessesRemoteContent = true;
      }
      if (unsafeReceiver && ["target", "formTarget"].includes(memberName ?? "")) {
        const target = designJavaScriptConstantString(node.right, index)?.trim().toLowerCase();
        if (target !== "_self") opensWindow = true;
      }
      if (receiver === "style") {
        const cssValues = designJavaScriptPossibleConstantStrings(node.right, index);
        if (memberName === "cssText") {
          if (cssValues === null || cssValues.size === 0) accessesRemoteContent = true;
          else for (const cssValue of cssValues) validateDesignCss(
            cssValue,
            allowCanonicalAssets,
            "attribute",
            (url) => recordAllowedUrl(url, node.right),
          );
        } else if (memberName === null
          || ((cssValues === null || cssValues.size === 0)
            && DESIGN_JAVASCRIPT_CSS_URL_PROPERTIES.has(memberName))) {
          accessesRemoteContent = true;
        } else if (cssValues !== null) {
          for (const cssValue of cssValues) {
            validateDesignCss(
              `${memberName}: ${cssValue}`,
              allowCanonicalAssets,
              "attribute",
              (url) => recordAllowedUrl(url, node.right),
            );
          }
        }
      }
    }
    if (node.type === "CallExpression" && designJavaScriptNode(node.callee)) {
      const args = Array.isArray(node.arguments) ? node.arguments : [];
      if (node.callee.type === "Identifier" && typeof node.callee.name === "string"
        && DESIGN_JAVASCRIPT_TIMER_GLOBALS.has(node.callee.name)
        && !hasDesignJavaScriptBinding(index.scopeByNode.get(node.callee), node.callee.name)) {
        if (!designJavaScriptCallable(args[0], index)) evaluatesDynamicCode = true;
      }
      if (node.callee.type === "MemberExpression" || node.callee.type === "OptionalMemberExpression") {
        const calleeName = designJavaScriptMemberName(node.callee, index);
        const calleePath = designJavaScriptGlobalPath(node.callee, index);
        const receiver = designJavaScriptProvenance(node.callee.object, index);
        const unsafeReceiver = receiver !== "local";
        if (unsafeReceiver && DESIGN_JAVASCRIPT_MARKUP_METHODS.has(calleeName ?? "")) injectsMarkup = true;
        if (unsafeReceiver && calleeName === "addModule") accessesRemoteContent = true;
        if (unsafeReceiver && (calleeName === "setAttribute" || calleeName === "setAttributeNS")) {
          const offset = calleeName === "setAttributeNS" ? 1 : 0;
          const attribute = designJavaScriptConstantString(args[offset], index);
          if (attribute === null) accessesRemoteContent = true;
          else if (/^on/i.test(attribute) || DESIGN_JAVASCRIPT_MARKUP_PROPERTIES.has(attribute)) injectsMarkup = true;
          else if (["target", "formtarget"].includes(attribute.toLowerCase())) {
            const target = designJavaScriptConstantString(args[offset + 1], index)?.trim().toLowerCase();
            if (target !== "_self") opensWindow = true;
          } else if (attribute.toLowerCase() === "style") {
            const style = designJavaScriptConstantString(args[offset + 1], index);
            if (style === null) accessesRemoteContent = true;
            else validateDesignCss(
              style,
              allowCanonicalAssets,
              "attribute",
              (url) => recordAllowedUrl(url, args[offset + 1]),
            );
          }
          else if (DESIGN_JAVASCRIPT_URL_PROPERTIES.has(attribute)
            && !validateDesignJavaScriptUrl(
              args[offset + 1],
              index,
              allowCanonicalAssets,
              exportProject,
              recordAllowedUrl,
            )) accessesRemoteContent = true;
        }
        if (receiver === "style" && calleeName === "setProperty") {
          const property = designJavaScriptConstantString(args[0], index);
          const cssValue = designJavaScriptConstantString(args[1], index);
          if (property === null
            || (cssValue === null && DESIGN_JAVASCRIPT_CSS_URL_PROPERTIES.has(property))) accessesRemoteContent = true;
          else if (cssValue !== null) validateDesignCss(
            `${property}: ${cssValue}`,
            allowCanonicalAssets,
            "attribute",
            (url) => recordAllowedUrl(url, args[1]),
          );
        }
        if ((unsafeReceiver && ["insertRule", "addRule", "replaceSync"].includes(calleeName ?? ""))
          || (receiver === "style" && calleeName === "replace")) {
          const css = designJavaScriptConstantString(args[0], index);
          if (css === null) accessesRemoteContent = true;
          else validateDesignCss(
            css,
            allowCanonicalAssets,
            "stylesheet",
            (url) => recordAllowedUrl(url, args[0]),
          );
        }
        if (calleePath !== null) {
          const effective = designJavaScriptEffectivePath(calleePath);
          if (DESIGN_JAVASCRIPT_TIMER_GLOBALS.has(effective.root)) {
            if (!designJavaScriptCallable(args[0], index)) evaluatesDynamicCode = true;
          }
          if (effective.root === "document"
            && (calleeName === "createElement" || calleeName === "createElementNS")) {
            const tagName = designJavaScriptConstantString(args[calleeName === "createElementNS" ? 1 : 0], index);
            if (tagName === null || DESIGN_JAVASCRIPT_UNSAFE_CREATED_ELEMENTS.has(tagName.toLowerCase())) {
              injectsMarkup = true;
            }
          }
          if (effective.root === "Reflect" && calleeName === "set") {
            const target = designJavaScriptProvenance(args[0], index);
            if (target !== "local") {
              const property = designJavaScriptConstantString(args[1], index);
              if (property === null) accessesRemoteContent = true;
              else if (DESIGN_JAVASCRIPT_MARKUP_PROPERTIES.has(property)) injectsMarkup = true;
              else if (["target", "formTarget"].includes(property)
                && !designJavaScriptSelfTarget(args[2], index)) opensWindow = true;
              else if (DESIGN_JAVASCRIPT_URL_PROPERTIES.has(property)
                && !validateDesignJavaScriptUrl(
                  args[2],
                  index,
                  allowCanonicalAssets,
                  exportProject,
                  recordAllowedUrl,
                )) accessesRemoteContent = true;
            }
          }
          if ((effective.root === "Object" || effective.root === "Reflect")
            && calleeName === "defineProperty") {
            const target = designJavaScriptProvenance(args[0], index);
            if (target !== "local") {
              const property = designJavaScriptConstantString(args[1], index);
              if (property === null) accessesRemoteContent = true;
              else if (DESIGN_JAVASCRIPT_MARKUP_PROPERTIES.has(property)) injectsMarkup = true;
              else if (["target", "formTarget"].includes(property)
                && !designJavaScriptSelfTarget(
                  designJavaScriptObjectPropertyValue(args[2], "value"),
                  index,
                )) opensWindow = true;
              else if (DESIGN_JAVASCRIPT_URL_PROPERTIES.has(property)) accessesRemoteContent = true;
            }
          }
          if (effective.root === "Object" && calleeName === "assign") {
            const target = designJavaScriptProvenance(args[0], index);
            for (const source of args.slice(1)) {
              if (target === "local") {
                if (designJavaScriptProvenance(source, index) !== "local") accessesRemoteContent = true;
                continue;
              }
              if (!designJavaScriptNode(source) || source.type !== "ObjectExpression"
                || !Array.isArray(source.properties)) {
                accessesRemoteContent = true;
                continue;
              }
              for (const property of source.properties) {
                if (!designJavaScriptNode(property) || property.type === "SpreadElement") {
                  accessesRemoteContent = true;
                  continue;
                }
                const propertyName = designJavaScriptObjectPropertyName(property);
                if (propertyName === null) accessesRemoteContent = true;
                else if (DESIGN_JAVASCRIPT_MARKUP_PROPERTIES.has(propertyName)) injectsMarkup = true;
                else if (["target", "formTarget"].includes(propertyName)
                  && !designJavaScriptSelfTarget(property.value, index)) opensWindow = true;
                else if (DESIGN_JAVASCRIPT_URL_PROPERTIES.has(propertyName)
                  && !validateDesignJavaScriptUrl(
                    property.value,
                    index,
                    allowCanonicalAssets,
                    exportProject,
                    recordAllowedUrl,
                  )) accessesRemoteContent = true;
              }
            }
          }
        }
      }
    }
    if (accessesRemoteContent && remoteContentViolation === null) {
      let operation = node.type;
      if (node.type === "Identifier" && typeof node.name === "string") {
        operation = `identifier ${node.name}`;
      } else if (node.type === "MemberExpression" || node.type === "OptionalMemberExpression") {
        operation = `member ${designJavaScriptMemberName(node, index) ?? "<dynamic>"}`;
      } else if (node.type === "AssignmentExpression" && designJavaScriptNode(node.left)
        && (node.left.type === "MemberExpression" || node.left.type === "OptionalMemberExpression")) {
        operation = `assignment to ${designJavaScriptMemberName(node.left, index) ?? "<dynamic member>"}`;
      } else if (node.type === "CallExpression" && designJavaScriptNode(node.callee)) {
        operation = node.callee.type === "MemberExpression" || node.callee.type === "OptionalMemberExpression"
          ? `call to ${designJavaScriptMemberName(node.callee, index) ?? "<dynamic member>"}`
          : `call to ${node.callee.type === "Identifier" ? String(node.callee.name) : node.callee.type}`;
      } else if (node.type === "ImportDeclaration" && designJavaScriptNode(node.source)
        && typeof node.source.value === "string") {
        operation = `import ${node.source.value}`;
      }
      const location = node.loc as { start?: { line?: number; column?: number } } | undefined;
      const line = location?.start?.line;
      const column = location?.start?.column;
      const excerpt = line === undefined ? "" : (script.split(/\r?\n/)[line - 1]?.trim().slice(0, 240) ?? "");
      remoteContentViolation = `${operation}${line === undefined ? "" : ` at ${line}:${(column ?? 0) + 1}`}${excerpt ? ` — ${excerpt}` : ""}`;
    }
  });
  if (accessesParentNavigation) {
    throw new DesignStorageError("invalid-html", "Generated HTML may not access parent, top, or opener");
  }
  if (changesNavigation) {
    throw new DesignStorageError("invalid-html", "Generated HTML may not change browser navigation");
  }
  if (opensWindow) {
    throw new DesignStorageError("invalid-html", "Generated HTML may not open browser windows");
  }
  if (evaluatesDynamicCode) {
    throw new DesignStorageError("invalid-html", "Generated HTML may not evaluate dynamic JavaScript");
  }
  if (injectsMarkup) {
    throw new DesignStorageError("invalid-html", "Generated HTML may not inject executable markup");
  }
  if (accessesRemoteContent) {
    throw new DesignStorageError(
      "invalid-html",
      `Generated HTML may not load remote scripts or resources${remoteContentViolation === null ? "" : ` (${remoteContentViolation})`}`,
    );
  }
}

/** Uses the same AST constants and URL-sink provenance as Design HTML
 * validation. Publication/export callers can therefore fail closed when the
 * accepted runtime URL has no source-preserving rewrite. */
export function collectDesignJavaScriptUrlSinks(
  script: string,
  sourceType: "script" | "module" = "script",
): readonly DesignJavaScriptUrlSink[] {
  const sinks: DesignJavaScriptUrlSink[] = [];
  validateDesignJavaScript(script, true, sourceType, false, (sink) => sinks.push(sink));
  return sinks;
}

const DESIGN_HTML_BROWSING_CONTEXT_ELEMENTS = new Set([
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "portal",
  "fencedframe",
]);
const DESIGN_HTML_JAVASCRIPT_TYPES = new Set([
  "application/ecmascript",
  "application/javascript",
  "application/x-ecmascript",
  "application/x-javascript",
  "text/ecmascript",
  "text/javascript",
  "text/javascript1.0",
  "text/javascript1.1",
  "text/javascript1.2",
  "text/javascript1.3",
  "text/javascript1.4",
  "text/javascript1.5",
  "text/jscript",
  "text/livescript",
  "text/x-ecmascript",
  "text/x-javascript",
]);

export function designHtmlJavaScriptSourceType(rawType: string): "script" | "module" | null {
  const type = rawType.trim().toLowerCase().split(";", 1)[0]?.trim() ?? "";
  if (type === "module") return "module";
  return type === "" || DESIGN_HTML_JAVASCRIPT_TYPES.has(type) ? "script" : null;
}

function designHtmlElement(node: DefaultTreeAdapterTypes.Node): node is DefaultTreeAdapterTypes.Element {
  return "tagName" in node && typeof node.tagName === "string" && Array.isArray(node.attrs);
}

function designHtmlChildren(node: DefaultTreeAdapterTypes.Node): DefaultTreeAdapterTypes.ChildNode[] {
  const children = "childNodes" in node && Array.isArray(node.childNodes) ? [...node.childNodes] : [];
  if (designHtmlElement(node) && node.tagName === "template" && "content" in node
    && node.content !== null && typeof node.content === "object" && Array.isArray(node.content.childNodes)) {
    children.push(...node.content.childNodes);
  }
  return children;
}

function designHtmlText(element: DefaultTreeAdapterTypes.Element): string {
  return element.childNodes.map((node) => node.nodeName === "#text" && "value" in node ? node.value : "").join("");
}

function designHtmlAttribute(element: DefaultTreeAdapterTypes.Element, name: string): string | null {
  return element.attrs.find((attribute) => attribute.name.toLowerCase() === name)?.value ?? null;
}

function validateDesignCss(
  css: string,
  allowCanonicalAssets: boolean,
  mode: "stylesheet" | "attribute" = "stylesheet",
  onAllowedUrl?: (url: string) => void,
): void {
  let dependencies: ReturnType<typeof transformCss>["dependencies"];
  try {
    dependencies = mode === "attribute"
      ? transformStyleAttribute({
        filename: "design-inline-style.css",
        code: Buffer.from(css),
        analyzeDependencies: true,
      }).dependencies
      : transformCss({
        filename: "design-inline.css",
        code: Buffer.from(css),
        analyzeDependencies: true,
      }).dependencies;
  } catch {
    throw new DesignStorageError("invalid-html", "Generated HTML contains invalid CSS");
  }
  for (const dependency of dependencies ?? []) {
    if (dependency.type === "import") {
      throw new DesignStorageError("invalid-html", "Generated HTML must keep styles and style assets local");
    }
    if (dependency.type !== "url" || !allowedDesignUrl(dependency.url, allowCanonicalAssets)) {
      throw new DesignStorageError("invalid-html", "Generated HTML contains an unpinned style asset URL");
    }
    onAllowedUrl?.(dependency.url);
  }
}

export function validateDesignExportJavaScript(source: string): string[] {
  validateDesignJavaScript(source, false, "module", true);
  const syntax = parse(source, { sourceType: "module", plugins: ["typescript", "jsx"] });
  const program = syntax.program as unknown as DesignJavaScriptNode;
  const index = indexDesignJavaScript(program);
  const specifiers: string[] = [];
  let usesDeferredScheduler = false;
  let executionEnvironmentProbe: string | null = null;
  let usesWebAnimations = false;
  let usesDynamicStyle = false;
  const markExecutionEnvironmentProbe = (node: DesignJavaScriptNode, reason: string): void => {
    if (executionEnvironmentProbe !== null) return;
    const location = node.loc as { start?: { line?: number; column?: number } } | undefined;
    const line = location?.start?.line;
    const column = location?.start?.column;
    const excerpt = line === undefined ? "" : (source.split(/\r?\n/)[line - 1]?.trim().slice(0, 240) ?? "");
    executionEnvironmentProbe = `${reason}${line === undefined ? "" : ` at ${line}:${(column ?? 0) + 1}`}${excerpt ? ` — ${excerpt}` : ""}`;
  };
  visitDesignJavaScript(program, (node, parent, key) => {
    if (node.type === "Identifier" && typeof node.name === "string"
      && designJavaScriptReference(node, parent, key, index)
      && !hasDesignJavaScriptBinding(index.scopeByNode.get(node), node.name)) {
      if (DESIGN_JAVASCRIPT_EXPORT_SCHEDULER_GLOBALS.has(node.name)) usesDeferredScheduler = true;
      if (DESIGN_JAVASCRIPT_EXPORT_STATE_GLOBALS.has(node.name)) {
        markExecutionEnvironmentProbe(node, `global ${node.name}`);
      }
      if (DESIGN_JAVASCRIPT_EXPORT_ANIMATION_GLOBALS.has(node.name)) usesWebAnimations = true;
    }
    if (node.type === "MemberExpression" || node.type === "OptionalMemberExpression") {
      const memberName = designJavaScriptMemberName(node, index);
      const globalPath = designJavaScriptGlobalPath(node, index);
      const effective = globalPath === null ? null : designJavaScriptEffectivePath(globalPath);
      if (memberName !== null && DESIGN_JAVASCRIPT_EXPORT_SCHEDULER_GLOBALS.has(memberName)
        && designJavaScriptProvenance(node.object, index) !== "local") {
        usesDeferredScheduler = true;
      }
      if (memberName !== null && DESIGN_JAVASCRIPT_EXPORT_STATE_MEMBERS.has(memberName)
        && designJavaScriptProvenance(node.object, index) !== "local") {
        markExecutionEnvironmentProbe(node, `unproven member ${memberName}`);
      }
      const receiverProvenance = designJavaScriptProvenance(node.object, index);
      if (memberName === null && receiverProvenance !== "local") {
        markExecutionEnvironmentProbe(node, `dynamic member on a ${receiverProvenance} receiver`);
      }
      if (effective !== null && DESIGN_JAVASCRIPT_EXPORT_STATE_GLOBALS.has(effective.root)) {
        markExecutionEnvironmentProbe(node, `global path ${effective.root}`);
      }
      if (effective?.root === "document"
        && ["visibilityState", "hidden", "prerendering", "referrer", "hasFocus"].includes(effective.path[0] ?? "")) {
        markExecutionEnvironmentProbe(node, `document.${effective.path[0]}`);
      }
      if (memberName !== null && DESIGN_JAVASCRIPT_EXPORT_ANIMATION_MEMBERS.has(memberName)) {
        usesWebAnimations = true;
      }
    }
    if (node.type === "ObjectProperty" && parent?.type === "ObjectPattern") {
      const memberName = node.computed === true
        ? designJavaScriptConstantString(node.key, index)
        : designJavaScriptNode(node.key) && node.key.type === "Identifier" && typeof node.key.name === "string"
          ? node.key.name
          : staticDesignJavaScriptString(node.key);
      const localPattern = designJavaScriptPatternIsLocal(parent, index);
      if (!localPattern && (memberName === null || DESIGN_JAVASCRIPT_EXPORT_STATE_MEMBERS.has(memberName))) {
        markExecutionEnvironmentProbe(node, `destructured ${memberName ?? "dynamic property"} from an unproven value`);
      }
      if (!localPattern && (memberName === null || DESIGN_JAVASCRIPT_EXPORT_ANIMATION_MEMBERS.has(memberName))) {
        usesWebAnimations = true;
      }
    }
    if (node.type === "ObjectProperty" && parent?.type === "ObjectExpression") {
      const propertyName = designJavaScriptObjectPropertyName(node);
      if (propertyName !== null && DESIGN_JAVASCRIPT_EXPORT_ANIMATION_MEMBERS.has(propertyName)) {
        usesWebAnimations = true;
      }
    }
    if (node.type === "AssignmentExpression" && designJavaScriptNode(node.left)
      && (node.left.type === "MemberExpression" || node.left.type === "OptionalMemberExpression")) {
      const memberName = designJavaScriptMemberName(node.left, index);
      const receiver = designJavaScriptProvenance(node.left.object, index);
      if (receiver === "style" && memberName === "cssText") {
        const cssValues = designJavaScriptPossibleConstantStrings(node.right, index);
        if (cssValues === null || cssValues.size === 0) usesDynamicStyle = true;
        else for (const css of cssValues) assertDesignExportCssIsStatic(css);
      } else if (receiver === "style") {
        const values = designJavaScriptPossibleConstantStrings(node.right, index);
        if (memberName === null || values === null || values.size === 0) usesDynamicStyle = true;
        else for (const value of values) assertDesignExportCssIsStatic(`${memberName}: ${value}`);
      }
      if (memberName !== null && DESIGN_JAVASCRIPT_EXPORT_ANIMATION_MEMBERS.has(memberName)) {
        usesWebAnimations = true;
      }
    }
    if ((node.type === "CallExpression" || node.type === "OptionalCallExpression")
      && designJavaScriptNode(node.callee)
      && (node.callee.type === "MemberExpression" || node.callee.type === "OptionalMemberExpression")) {
      const args = Array.isArray(node.arguments) ? node.arguments : [];
      const calleeName = designJavaScriptMemberName(node.callee, index);
      const calleePath = designJavaScriptGlobalPath(node.callee, index);
      const effective = calleePath === null ? null : designJavaScriptEffectivePath(calleePath);
      const receiver = designJavaScriptProvenance(node.callee.object, index);
      if (effective !== null && ["Object", "Reflect"].includes(effective.root)
        && DESIGN_JAVASCRIPT_EXPORT_REFLECTION_MEMBERS.has(calleeName ?? "")
        && designJavaScriptProvenance(args[0], index) !== "local") {
        markExecutionEnvironmentProbe(node, `${effective.root}.${calleeName ?? "dynamic reflection"} on an unproven value`);
      }
      if (calleeName === "setAttribute" || calleeName === "setAttributeNS") {
        const offset = calleeName === "setAttributeNS" ? 1 : 0;
        const attribute = designJavaScriptConstantString(args[offset], index)?.toLowerCase();
        const value = designJavaScriptConstantString(args[offset + 1], index);
        if (attribute === "style") {
          if (value === null) usesDynamicStyle = true;
          else assertDesignExportCssIsStatic(value);
        }
      }
      if (receiver === "style" && calleeName === "setProperty") {
        const property = designJavaScriptConstantString(args[0], index);
        const value = designJavaScriptConstantString(args[1], index);
        if (property === null || value === null) usesDynamicStyle = true;
        else assertDesignExportCssIsStatic(`${property}: ${value}`);
      }
      if (["insertRule", "addRule", "replaceSync"].includes(calleeName ?? "")
        || (receiver === "style" && calleeName === "replace")) {
        const css = designJavaScriptConstantString(args[0], index);
        if (css === null) usesDynamicStyle = true;
        else assertDesignExportCssIsStatic(css);
      }
      if (effective?.root === "document"
        && (calleeName === "createElement" || calleeName === "createElementNS")) {
        const tagName = designJavaScriptConstantString(args[calleeName === "createElementNS" ? 1 : 0], index)?.toLowerCase();
        if (["animate", "set", "marquee"].includes(tagName ?? "")) usesWebAnimations = true;
      }
      if (effective !== null && ["Object", "Reflect"].includes(effective.root)
        && ["defineProperty", "get", "set"].includes(calleeName ?? "")) {
        const property = designJavaScriptConstantString(args[1], index);
        if (property !== null && DESIGN_JAVASCRIPT_EXPORT_STATE_MEMBERS.has(property)) {
          markExecutionEnvironmentProbe(node, `${effective.root}.${calleeName ?? "reflection"} of ${property}`);
        }
        if (property !== null && DESIGN_JAVASCRIPT_EXPORT_ANIMATION_MEMBERS.has(property)) {
          usesWebAnimations = true;
        }
      }
    }
    if ((node.type === "ImportDeclaration" || node.type === "ExportAllDeclaration"
      || (node.type === "ExportNamedDeclaration" && node.source !== null && node.source !== undefined))
      && designJavaScriptNode(node.source) && node.source.type === "StringLiteral"
      && typeof node.source.value === "string") {
      specifiers.push(node.source.value);
    }
  });
  if (usesDeferredScheduler) {
    throw new DesignStorageError("invalid-html", "Design Export JavaScript cannot use deferred timer or scheduler capabilities");
  }
  if (usesWebAnimations) {
    throw new DesignStorageError("invalid-html", "Design Export JavaScript cannot use Web Animations or deferred animation capabilities");
  }
  if (usesDynamicStyle) {
    throw new DesignStorageError("invalid-html", "Design Export JavaScript cannot construct dynamic CSS outside static validation");
  }
  if (executionEnvironmentProbe !== null) {
    throw new DesignStorageError(
      "invalid-html",
      `Design Export JavaScript cannot inspect browser environment or persistent storage state (${executionEnvironmentProbe})`,
    );
  }
  return specifiers;
}

function normalizedDesignExportCssForCapabilityScan(css: string): string {
  let normalized = "";
  for (let index = 0; index < css.length;) {
    const character = css[index]!;
    const next = css[index + 1];
    if (character === "/" && next === "*") {
      const end = css.indexOf("*/", index + 2);
      if (end < 0) return normalized;
      normalized += " ";
      index = end + 2;
      continue;
    }
    if (character === "\"" || character === "'") {
      const quote = character;
      normalized += " ";
      index += 1;
      while (index < css.length) {
        if (css[index] === "\\") {
          index += css[index + 1] === "\r" && css[index + 2] === "\n" ? 3 : 2;
          continue;
        }
        if (css[index] === quote) {
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }
    normalized += character;
    index += 1;
  }
  return normalized.replace(
    /\\(?:([0-9a-f]{1,6})(?:\r\n|[\t\n\f\r ])?|([^\r\n\f]))/gi,
    (_match, hexadecimal: string | undefined, escaped: string | undefined) => hexadecimal === undefined
      ? escaped ?? ""
      : String.fromCodePoint(Number.parseInt(hexadecimal, 16)),
  );
}

function assertDesignExportCssIsStatic(css: string): void {
  const normalized = normalizedDesignExportCssForCapabilityScan(css);
  if (/@(?:-webkit-)?keyframes\b|@starting-style\b/i.test(normalized)
    || /(?:^|[;{])\s*(?:-webkit-)?(?:animation|transition)(?:-[a-z-]+)?\s*:/i.test(normalized)
    || /(?:^|[;{])\s*(?:scroll-timeline|view-timeline|timeline-scope)(?:-[a-z-]+)?\s*:/i.test(normalized)) {
    throw new DesignStorageError(
      "invalid-input",
      "Implementation Export CSS cannot use animations, transitions, timelines, or deferred visual changes",
    );
  }
}

export function validateDesignExportCss(
  css: string,
  mode: "stylesheet" | "attribute" = "stylesheet",
): void {
  assertDesignExportCssIsStatic(css);
  let dependencies: ReturnType<typeof transformCss>["dependencies"];
  try {
    dependencies = mode === "attribute"
      ? transformStyleAttribute({
        filename: "design-export-style.css",
        code: Buffer.from(css),
        analyzeDependencies: true,
      }).dependencies
      : transformCss({
        filename: "design-export.css",
        code: Buffer.from(css),
        analyzeDependencies: true,
      }).dependencies;
  } catch {
    throw new DesignStorageError("invalid-input", "Implementation Export contains invalid CSS");
  }
  for (const dependency of dependencies ?? []) {
    if (dependency.type === "import" || dependency.type !== "url"
      || !allowedDesignExportUrl(dependency.url)) {
      throw new DesignStorageError("invalid-input", "Implementation Export CSS must remain local and self-contained");
    }
  }
}

function validateDesignResponsiveUrls(value: string, allowCanonicalAssets: boolean): void {
  const candidates = value.split(",").map((entry) => entry.trim().split(/\s+/, 1)[0] ?? "");
  if (candidates.length === 0 || candidates.some((candidate) => !allowedDesignUrl(candidate, allowCanonicalAssets))) {
    throw new DesignStorageError("invalid-html", "Generated HTML contains an unpinned or external responsive-image URL");
  }
}

function validateDesignScriptElement(
  element: DefaultTreeAdapterTypes.Element,
  allowCanonicalAssets: boolean,
  onJavaScriptUrl?: (sink: DesignJavaScriptUrlSink) => void,
): void {
  if (designHtmlAttribute(element, "src") !== null) {
    throw new DesignStorageError("invalid-html", "Generated HTML must keep JavaScript inline");
  }
  const rawType = designHtmlAttribute(element, "type") ?? "";
  const type = rawType.trim().toLowerCase().split(";", 1)[0]?.trim() ?? "";
  const script = designHtmlText(element);
  if (type === "speculationrules" || type === "importmap") {
    throw new DesignStorageError("invalid-html", "Generated HTML may not declare browser-loading script data");
  }
  const sourceType = designHtmlJavaScriptSourceType(rawType);
  if (sourceType !== null) {
    validateDesignJavaScript(script, allowCanonicalAssets, sourceType, false, onJavaScriptUrl);
    return;
  }
  if ((type === "application/json" || type.endsWith("+json")) && script.trim()) {
    try {
      JSON.parse(script);
    } catch {
      throw new DesignStorageError("invalid-html", "Generated HTML contains invalid JSON script data");
    }
  }
}

function validateDesignHtmlElement(
  element: DefaultTreeAdapterTypes.Element,
  allowCanonicalAssets: boolean,
  onJavaScriptUrl?: (sink: DesignJavaScriptUrlSink) => void,
): void {
  const tagName = element.tagName.toLowerCase();
  if (DESIGN_HTML_BROWSING_CONTEXT_ELEMENTS.has(tagName)) {
    throw new DesignStorageError("invalid-html", "Generated HTML may not create nested browsing contexts");
  }
  if (tagName === "base") {
    throw new DesignStorageError("invalid-html", "Generated HTML may not redefine navigation");
  }
  const rel = designHtmlAttribute(element, "rel")?.trim().toLowerCase().split(/\s+/) ?? [];
  if (tagName === "link" && rel.includes("stylesheet")) {
    throw new DesignStorageError("invalid-html", "Generated HTML must keep styles inline");
  }
  if (tagName === "meta" && designHtmlAttribute(element, "http-equiv")?.trim().toLowerCase() === "refresh") {
    throw new DesignStorageError("invalid-html", "Generated HTML may not refresh navigation");
  }
  for (const attribute of element.attrs) {
    const name = attribute.name.toLowerCase();
    const urlContext = designHtmlUrlContext(element, attribute);
    if (name.startsWith("on")) {
      throw new DesignStorageError("invalid-html", "Generated HTML may not use executable event attributes");
    }
    if (["target", "formtarget"].includes(name) && attribute.value.trim().toLowerCase() !== "_self") {
      throw new DesignStorageError("invalid-html", "Generated HTML may not target another browsing context");
    }
    if (urlContext?.kind === "unsupported") {
      throw new DesignStorageError(
        "invalid-html",
        `Generated HTML contains an unsupported URL-bearing attribute ${urlContext.sourceAttributeName}`,
      );
    }
    if (urlContext?.kind === "style") validateDesignCss(attribute.value, allowCanonicalAssets, "attribute");
    if (urlContext?.kind === "style-value") {
      validateDesignCss(`${urlContext.cssPropertyName}:${attribute.value}`, allowCanonicalAssets, "attribute");
    }
    if (urlContext?.kind === "single" && !allowedDesignUrl(attribute.value, allowCanonicalAssets)) {
      const rejected = attribute.value.trim();
      const preview = rejected.length > 160 ? `${rejected.slice(0, 160)}…` : rejected;
      throw new DesignStorageError(
        "invalid-html",
        `Generated HTML contains an unpinned or external URL in <${tagName}> ${name}=${JSON.stringify(preview)}`,
      );
    }
    if (urlContext?.kind === "responsive") {
      validateDesignResponsiveUrls(attribute.value, allowCanonicalAssets);
    }
    if (urlContext?.kind === "space-separated") {
      const targets = attribute.value.trim().split(/\s+/).filter(Boolean);
      if (targets.length === 0 || targets.some((target) => !allowedDesignUrl(target, allowCanonicalAssets))) {
        throw new DesignStorageError("invalid-html", "Generated HTML contains an external hyperlink audit URL");
      }
    }
  }
  if (tagName === "style") validateDesignCss(designHtmlText(element), allowCanonicalAssets);
  if (tagName === "script") validateDesignScriptElement(element, allowCanonicalAssets, onJavaScriptUrl);
}

export function validateDesignHtml(
  html: string,
  options: {
    allowCanonicalAssets?: boolean;
    onJavaScriptUrl?: (sink: DesignJavaScriptUrlSink) => void;
  } = {},
): void {
  if (typeof html !== "string" || !html.trim()) {
    throw new DesignStorageError("invalid-html", "Generated HTML is empty");
  }
  const bytes = Buffer.byteLength(html, "utf8");
  if (bytes > MAX_DESIGN_HTML_BYTES) {
    throw new DesignStorageError("invalid-html", "Generated HTML exceeds the size limit");
  }
  if (!/^\s*<!doctype\s+html\s*>/i.test(html) || !/<\/html\s*>\s*$/i.test(html)) {
    throw new DesignStorageError("invalid-html", "Generated output must be one complete HTML document");
  }
  const parseErrors: ParserError[] = [];
  const document = parseHtml(html, {
    sourceCodeLocationInfo: true,
    onParseError: (error) => parseErrors.push(error),
  });
  if (parseErrors.length > 0) {
    throw new DesignStorageError("invalid-html", "Generated output is not valid HTML");
  }
  let doctypeCount = 0;
  const structural = new Map<string, DefaultTreeAdapterTypes.Element[]>();
  const visit = (node: DefaultTreeAdapterTypes.Node): void => {
    if (node.nodeName === "#documentType" && "name" in node) {
      if (node.name.toLowerCase() === "html" && node.sourceCodeLocation) doctypeCount += 1;
    }
    if (designHtmlElement(node)) {
      const tagName = node.tagName.toLowerCase();
      if (["html", "head", "body"].includes(tagName)) {
        const matches = structural.get(tagName) ?? [];
        matches.push(node);
        structural.set(tagName, matches);
      }
      validateDesignHtmlElement(
        node,
        options.allowCanonicalAssets === true,
        options.onJavaScriptUrl,
      );
    }
    for (const child of designHtmlChildren(node)) visit(child);
  };
  visit(document);
  const hasExactSourceElement = (tagName: "html" | "head" | "body"): boolean => {
    const matches = structural.get(tagName) ?? [];
    return matches.length === 1
      && matches[0]?.sourceCodeLocation !== null
      && matches[0]?.sourceCodeLocation !== undefined
      && matches[0]?.sourceCodeLocation?.startTag !== undefined
      && matches[0]?.sourceCodeLocation?.endTag !== undefined;
  };
  if (doctypeCount !== 1 || !hasExactSourceElement("html")
    || !hasExactSourceElement("head") || !hasExactSourceElement("body")) {
    throw new DesignStorageError("invalid-html", "Generated output must be one complete HTML document");
  }
}
