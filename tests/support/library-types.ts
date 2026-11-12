// Reads the published types of the library (dist/index.d.ts) with the TypeScript compiler, for the contract tests of
// the library (E02): what the package exports, the members of a union, the properties of an interface, the signature of
// a function, and whether a file of another program compiles against those types as the module 'depcurfew'.
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import type * as Library from '../../src/index.ts';

/**
 * The built library, dist/index.js, typed as the sources: the path is computed, so that npm run typecheck neither needs
 * the build nor compares the built types with the sources.
 */
export async function builtLibrary(): Promise<typeof Library> {
  const entry = new URL('../../dist/index.js', import.meta.url).href;
  return (await import(entry)) as typeof Library;
}

export const DIST_TYPES = fileURLToPath(new URL('../../dist/index.d.ts', import.meta.url));
const ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** The compiler options of agentcurfew 1.2.0 (tsconfig.json at v1.2.0), with 'depcurfew' mapped to `types`. */
function agentcurfewOptions(types: string): ts.CompilerOptions {
  return {
    target: ts.ScriptTarget.ES2023,
    lib: ['lib.es2023.d.ts'],
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    types: ['node'],
    strict: true,
    noUncheckedIndexedAccess: true,
    exactOptionalPropertyTypes: true,
    noImplicitOverride: true,
    noFallthroughCasesInSwitch: true,
    verbatimModuleSyntax: true,
    erasableSyntaxOnly: true,
    isolatedModules: true,
    allowImportingTsExtensions: true,
    forceConsistentCasingInFileNames: true,
    skipLibCheck: true,
    resolveJsonModule: true,
    noEmit: true,
    paths: { depcurfew: [types] },
  };
}

/** The errors of compiling `file` against `types` as the module 'depcurfew', one line each; none when it compiles. */
export function compileAgainst(file: string, types: string = DIST_TYPES): string[] {
  const options = agentcurfewOptions(types);
  const host = ts.createCompilerHost(options);
  host.getCurrentDirectory = () => ROOT;
  const program = ts.createProgram([file], options, host);
  return ts.getPreEmitDiagnostics(program).map((diagnostic) => {
    const text = ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ');
    if (diagnostic.file === undefined || diagnostic.start === undefined) return text;
    const { line } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
    return `${diagnostic.file.fileName}:${line + 1}: ${text}`;
  });
}

/** The published types of the library, read once. */
export class LibraryTypes {
  readonly #checker: ts.TypeChecker;
  readonly #exports: Map<string, ts.Symbol>;

  constructor(types: string = DIST_TYPES) {
    const program = ts.createProgram([types], { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, types: ['node'], strict: true, noEmit: true });
    this.#checker = program.getTypeChecker();
    const source = program.getSourceFile(types);
    const module = source === undefined ? undefined : this.#checker.getSymbolAtLocation(source);
    if (module === undefined) throw new Error(`cannot read ${types}`);
    this.#exports = new Map(this.#checker.getExportsOfModule(module).map((symbol) => [symbol.name, symbol]));
  }

  /** Every name the package exports, values and types, in order. */
  names(): string[] {
    return [...this.#exports.keys()].sort();
  }

  #symbol(name: string): ts.Symbol {
    const symbol = this.#exports.get(name);
    if (symbol === undefined) throw new Error(`depcurfew does not export ${name}`);
    return symbol.flags & ts.SymbolFlags.Alias ? this.#checker.getAliasedSymbol(symbol) : symbol;
  }

  #declared(name: string): ts.Type {
    return this.#checker.getDeclaredTypeOfSymbol(this.#symbol(name));
  }

  /** The string literals of a union type (a type alias or the type of a property `property` of an interface). */
  literals(name: string, property?: string): string[] {
    let type = this.#declared(name);
    if (property !== undefined) {
      const member = type.getProperty(property);
      if (member === undefined) throw new Error(`${name} has no property ${property}`);
      type = this.#checker.getNonNullableType(this.#checker.getTypeOfSymbol(member));
    }
    const members = type.isUnion() ? type.types : [type];
    return members.map((member) => (member.isStringLiteral() ? member.value : `<${this.#checker.typeToString(member)}>`)).sort();
  }

  /** The properties of an interface, required ones without a mark and optional ones with "?". */
  properties(name: string): string[] {
    return this.#checker
      .getPropertiesOfType(this.#declared(name))
      .map((member) => `${member.name}${member.flags & ts.SymbolFlags.Optional ? '?' : ''}`)
      .sort();
  }

  /** The call signatures of an exported function, or the construct signatures of an exported class, as text. */
  signatures(name: string): string[] {
    const type = this.#checker.getTypeOfSymbol(this.#symbol(name));
    const calls = type.getCallSignatures();
    const signatures = calls.length > 0 ? calls : type.getConstructSignatures();
    return signatures.map((signature) => this.#checker.signatureToString(signature));
  }
}
