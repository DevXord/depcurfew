// Finds CommonJS constructs and top-level await in TypeScript sources using the TypeScript parser.
import ts from 'typescript';

export interface EsmViolation {
  line: number;
  rule: 'top-level-await' | 'commonjs';
  text: string;
}

function isFunctionBoundary(node: ts.Node): boolean {
  return ts.isFunctionLike(node) || ts.isClassStaticBlockDeclaration(node);
}

function isInsideFunction(node: ts.Node): boolean {
  for (let current = node.parent; current !== undefined; current = current.parent) {
    if (isFunctionBoundary(current)) return true;
  }
  return false;
}

function isCommonJs(node: ts.Node): boolean {
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require') {
    return true;
  }
  if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
    return true;
  }
  if (ts.isExportAssignment(node) && node.isExportEquals === true) {
    return true;
  }
  if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
    const object = node.expression.text;
    return (object === 'module' && node.name.text === 'exports') || object === 'exports';
  }
  return false;
}

export function findEsmViolations(fileName: string, source: string): EsmViolation[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const violations: EsmViolation[] = [];

  const report = (node: ts.Node, rule: EsmViolation['rule']) => {
    const { line } = file.getLineAndCharacterOfPosition(node.getStart(file));
    violations.push({ line: line + 1, rule, text: node.getText(file).split('\n', 1)[0] ?? '' });
  };

  const visit = (node: ts.Node) => {
    const isAwait =
      ts.isAwaitExpression(node) || (ts.isForOfStatement(node) && node.awaitModifier !== undefined);
    if (isAwait && !isInsideFunction(node)) report(node, 'top-level-await');
    if (isCommonJs(node)) report(node, 'commonjs');
    ts.forEachChild(node, visit);
  };
  visit(file);
  return violations;
}
