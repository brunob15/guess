import * as ts from 'typescript';
import { RoutingModule } from '../../../common/interfaces';
import { existsSync, readFileSync } from 'fs';
import { dirname, resolve, join, sep } from 'path';
import { evaluate } from '@wessberg/ts-evaluator';

const imports = (
  parent: string,
  child: string,
  program: ts.Program,
  visited: { [key: string]: boolean } = {}
) => {
  const sf = program.getSourceFile(parent);
  if (!sf) {
    throw new Error('Cannot find source file for path: ' + parent);
  }
  if (visited[parent]) {
    return false;
  }
  visited[parent] = true;
  let found = false;
  sf.forEachChild(n => {
    if (found) {
      return;
    }
    if (n.kind !== ts.SyntaxKind.ImportDeclaration) {
      return;
    }
    const imprt = n as ts.ImportDeclaration;
    const path = (imprt.moduleSpecifier as ts.StringLiteral).text;
    const fullPath = join(dirname(parent), path) + '.ts';
    if (fullPath === child) {
      found = true;
    }
    if (!found && existsSync(fullPath)) {
      found = imports(fullPath, child, program, visited);
    }
  });
  return found;
};

// This can potentially break if there's a lazy module
// that is not only loaded lazily but also imported
// inside of a parent module.
//
// For example, `app.module.ts` lazily loads `bar.module.ts`
// in the same time `app.module.ts` imports `bar.module.ts`
// this way the module entry point will be `app.module.ts`.
const getModuleEntryPoint = (
  path: string,
  entryPoints: Set<string>,
  program: ts.Program
): string => {
  const parents = [...entryPoints].filter(e => imports(e, path, program));
  // If no parents, this could be the root module
  if (parents.length === 0) {
    return path;
  }
  if (parents.length > 1) {
    throw new Error(
      `Module ${path} belongs to more than one module: ${parents.join(', ')}`
    );
  }
  return parents[0];
};

const getObjectProp = (
  node: ts.ObjectLiteralExpression,
  prop: string
): ts.Expression | null => {
  const vals = node.properties.values();
  for (const val of vals) {
    if (val.kind !== ts.SyntaxKind.PropertyAssignment) {
      continue;
    }
    const value = val as ts.PropertyAssignment;
    if (value.name.kind !== ts.SyntaxKind.Identifier) {
      continue;
    }
    const name = value.name.text;
    if (name === prop) {
      return value.initializer;
    }
  }
  return null;
};

const readLoadChildren = (
  node: ts.ObjectLiteralExpression,
  typeChecker: ts.TypeChecker
): string | null => {
  const expr = getObjectProp(node, 'loadChildren');
  if (!expr) {
    return null;
  }
  if (expr.kind === ts.SyntaxKind.StringLiteral) {
    return (expr as ts.StringLiteral).text;
  }
  let result: string | null = null;
  const visitor = (n: ts.Node) => {
    if (n.kind === ts.SyntaxKind.ImportKeyword) {
      const parent = n.parent as ts.CallExpression;
      const arg = parent.arguments[0];
      const res = evaluate({
        node: arg,
        typeChecker: typeChecker
      });
      if (res.success) {
        result = res.value as string;
      }
    }
    if (result) {
      return;
    }
    n.forEachChild(visitor);
  };
  expr.forEachChild(visitor);
  // Fallback to when loadChildren looks like:
  // loadChildren: 'foo' + '/' + 'bar'
  if (!result) {
    const res = evaluate({
      node: expr,
      typeChecker: typeChecker
    });
    if (res.success) {
      result = res.value as string;
    }
  }
  return result;
};

const readPath = (
  node: ts.ObjectLiteralExpression,
  typeChecker: ts.TypeChecker
): string | null => {
  const expr = getObjectProp(node, 'path');
  if (!expr) {
    return null;
  }
  const val = evaluate({
    node: expr,
    typeChecker
  });
  if (val.success) {
    return val.value as string;
  }
  return null;
};

const readChildren = (
  node: ts.ObjectLiteralExpression,
  typeChecker: ts.TypeChecker
): ts.ArrayLiteralExpression | null => {
  const expr = getObjectProp(node, 'children');
  if (!expr) {
    return null;
  }
  const val = evaluate({
    node: expr,
    typeChecker
  });
  if (val.success) {
    return val.value as ts.ArrayLiteralExpression;
  }
  return null;
};

const getModulePathFromRoute = (parentPath: string, loadChildren: string) => {
  const childModule = loadChildren.split('#')[0] + '.ts';
  if (loadChildren.startsWith('.')) {
    return join(dirname(parentPath), childModule);
  }
  const parentSegments = dirname(parentPath).split(sep);
  const childSegments = childModule.split('/');
  const max = Math.min(parentSegments.length, childSegments.length);
  let maxCommon = 0;
  for (let i = 1; i < max; i += 1) {
    for (let j = 0; j < i; j += 1) {
      let common = 0;
      if (parentSegments[parentSegments.length - 1 - j] === childSegments[j]) {
        common++;
        maxCommon = Math.max(maxCommon, common);
      } else {
        // breaking here
        common = 0;
        j = i;
      }
    }
  }
  return join(
    dirname(parentPath),
    childModule
      .split('/')
      .slice(maxCommon, childSegments.length)
      .join('/')
  );
};

interface Route {
  path: string;
  children: Route[];
}

interface LazyRoute extends Route {
  module: string;
}

const getRoute = (
  node: ts.ObjectLiteralExpression,
  entryPoints: Set<string>,
  program: ts.Program
): Route | null => {
  const path = readPath(node, program.getTypeChecker());
  if (path === null) {
    return null;
  }

  const childrenArray = readChildren(node, program.getTypeChecker());
  let children: Route[] = [];
  if (childrenArray) {
    children = (childrenArray.getChildren ? childrenArray.getChildren() : childrenArray as unknown as ts.Node[])
      .map(c => {
        if (c.kind !== ts.SyntaxKind.ObjectLiteralExpression) {
          return null;
        }
        return getRoute(c as ts.ObjectLiteralExpression, entryPoints, program);
      })
      .filter(e => e !== null) as Route[];
  }

  const route: Route = { path, children: [] };
  route.path = path;

  const loadChildren = readLoadChildren(node, program.getTypeChecker());
  if (loadChildren) {
    const parent = getModuleEntryPoint(
      resolve(node.getSourceFile().fileName),
      entryPoints,
      program
    );
    const module = getModulePathFromRoute(parent, loadChildren);
    return {
      ...route,
      module
    } as LazyRoute;
  }

  return route;
};

const isRoute = (n: ts.Node, typeChecker: ts.TypeChecker): boolean => {
  if (
    n.kind !== ts.SyntaxKind.ObjectLiteralExpression ||
    !n.parent ||
    n.parent.kind !== ts.SyntaxKind.ArrayLiteralExpression
  ) {
    return false;
  }

  const objLiteral = n as ts.ObjectLiteralExpression;
  const path = readPath(objLiteral, typeChecker) !== null;
  const children = !!readChildren(objLiteral, typeChecker);
  const loadChildren = !!readLoadChildren(objLiteral, typeChecker);
  const component = !!getObjectProp(objLiteral, 'component');

  return (path && children) || (path && component) || (path && loadChildren);
};

interface RoutesDeclaration {
  lazyRoutes: LazyRoute[];
  eagerRoutes: Route[];
}

interface Registry {
  [path: string]: RoutesDeclaration;
}

const findRootModule = (registry: Registry): string => {
  const childModules = new Set<string>();
  const traverseRoute = (route: Route) => {
    if ((route as LazyRoute).module) {
      childModules.add((route as LazyRoute).module);
    }
    route.children.forEach(traverseRoute);
  };
  const allModulePaths = Object.keys(registry);
  allModulePaths.forEach(path => {
    const declaration = registry[path];
    declaration.eagerRoutes.forEach(traverseRoute);
    declaration.lazyRoutes.forEach(traverseRoute);
  });
  const roots = allModulePaths.filter(m => !childModules.has(m));
  if (roots.length > 1) {
    throw new Error('Multiple root routing modules found ' + roots.join(', '));
  }
  return roots[0];
};

const collectRoutingModules = (
  root: string,
  registry: Registry,
  result: RoutingModule[],
  parentPath: string = root,
  currentPath: string = ''
) => {
  const declaration = registry[root];

  const process = (r: Route) => {
    if ((r as LazyRoute).module) {
      // tslint:disable-next-line: no-use-before-declare
      return processLazyRoute(r as LazyRoute);
    }
    // tslint:disable-next-line: no-use-before-declare
    return processRoute(r);
  };

  const processRoute = (r: Route) => {
    r.children.forEach(process);
    const path = (currentPath + '/' + r.path).replace(/\/$/, '');
    result.push({
      path,
      lazy: parentPath !== root,
      modulePath: root,
      parentModulePath: parentPath
    });
  };

  const processLazyRoute = (r: LazyRoute) => {
    r.children.forEach(process);
    const path = (currentPath + '/' + r.path).replace(/\/$/, '');
    collectRoutingModules(r.module, registry, result, root, path);
  };

  declaration.eagerRoutes.forEach(processRoute);
  declaration.lazyRoutes.forEach(processLazyRoute);
};

const findMainModule = (program: ts.Program) => {
  const tryFindMainModule = (n: ts.Node, sf: ts.SourceFile) => {
    if (
      n.kind === ts.SyntaxKind.Identifier &&
      (n as ts.Identifier).text === 'bootstrapModule'
    ) {
      const propAccess = (n as ts.Identifier).parent;
      if (
        !propAccess ||
        propAccess.kind !== ts.SyntaxKind.PropertyAccessExpression
      ) {
        return null;
      }
      const tempExpr = propAccess.parent;
      if (!tempExpr || tempExpr.kind !== ts.SyntaxKind.CallExpression) {
        return null;
      }
      const expr = tempExpr as ts.CallExpression;
      const module = expr.arguments[0];
      const tc = program.getTypeChecker();
      const symbol = tc.getTypeAtLocation(module).getSymbol();
      if (!symbol) {
        return null;
      }
      const decl = symbol.getDeclarations();
      if (!decl) {
        return null;
      }
      return resolve(decl[0].getSourceFile().fileName);
    }
    let mainPath: null | string = null;
    n.forEachChild(c => {
      if (mainPath) {
        return mainPath;
      }
      mainPath = tryFindMainModule(c, sf);
    });
    return mainPath;
  };
  return program.getSourceFiles().reduce((a, sf) => {
    if (a) {
      return a;
    }
    let mainPath: null | string = null;
    sf.forEachChild(n => {
      if (mainPath) {
        return;
      }
      mainPath = tryFindMainModule(n, sf);
    });
    return mainPath;
  }, null);
};

const getLazyEntryPoints = (
  node: ts.ObjectLiteralExpression,
  program: ts.Program
) => {
  const value = readLoadChildren(node, program.getTypeChecker());
  if (!value) {
    return null;
  }

  const parent = resolve(node.getSourceFile().fileName);
  const module = getModulePathFromRoute(parent, value);
  return module;
};

export const parseRoutes = (
  tsconfig: string,
  exclude: string[] = []
): RoutingModule[] => {
  const parseConfigHost: ts.ParseConfigHost = {
    fileExists: existsSync,
    readDirectory: ts.sys.readDirectory,
    readFile: file => readFileSync(file, 'utf8'),
    useCaseSensitiveFileNames: true
  };
  const config = ts.readConfigFile(tsconfig, path =>
    readFileSync(path).toString()
  );
  const parsed = ts.parseJsonConfigFileContent(
    config.config,
    parseConfigHost,
    resolve(dirname(tsconfig)),
    {
      noEmit: true
    }
  );

  const host = ts.createCompilerHost(parsed.options, true);
  const program = ts.createProgram(parsed.fileNames, parsed.options, host);
  const typeChecker = program.getTypeChecker();

  const toAbsolute = (file: string) =>
    file.startsWith('/') ? file : join(process.cwd(), file);
  const excludeFiles = new Set<string>(exclude.map(toAbsolute));
  const visitNode = (
    s: ts.SourceFile,
    callback: (routeObj: ts.Node) => void,
    n: ts.Node
  ) => {
    if (excludeFiles.has(resolve(s.fileName))) {
      return;
    }
    if (!n) {
      return;
    }
    n.forEachChild(visitNode.bind(null, s, callback));
    if (isRoute(n, typeChecker)) {
      callback(n);
    }
  };

  const mainPath = findMainModule(program);
  if (!mainPath) {
    throw new Error('Cannot find the main application module');
  }

  const entryPoints: Set<string> = new Set([mainPath]);
  program.getSourceFiles().map(s => {
    s.forEachChild(
      visitNode.bind(null, s, (n: ts.Node) => {
        const path = getLazyEntryPoints(
          n as ts.ObjectLiteralExpression,
          program
        );
        if (!path) {
          return;
        }
        entryPoints.add(path);
      })
    );
  });

  const registry: Registry = {};

  program.getSourceFiles().map(s => {
    s.forEachChild(
      visitNode.bind(null, s, (n: ts.Node) => {
        const path = resolve(n.getSourceFile().fileName);
        const route = getRoute(
          n as ts.ObjectLiteralExpression,
          entryPoints,
          program
        );
        if (!route) {
          return;
        }

        const modulePath = getModuleEntryPoint(path, entryPoints, program);
        const current = registry[modulePath] || {
          lazyRoutes: [],
          eagerRoutes: []
        };
        if ((route as LazyRoute).module) {
          current.lazyRoutes.push(route as LazyRoute);
        } else {
          current.eagerRoutes.push(route);
        }
        registry[modulePath] = current;
      })
    );
  });

  const result: RoutingModule[] = [];
  if (Object.keys(registry).length > 0) {
    collectRoutingModules(findRootModule(registry), registry, result);
  }

  return result;
};
