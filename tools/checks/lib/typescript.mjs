// @ts-check
import { createRequire } from "node:module";
import path from "node:path";
import { UnverifiableError } from "./report.mjs";

/** @typedef {typeof import("typescript")} TypeScript */
/** @typedef {{ ts: TypeScript, dir: string, options: import("typescript").CompilerOptions, ambient: string[] }} Workspace */

/**
 * @param {string} packageDir a package that depends on the compiler
 * @returns {TypeScript}
 */
export function loadTypeScript(packageDir) {
  try {
    return createRequire(path.join(packageDir, "package.json"))("typescript");
  } catch (error) {
    throw new UnverifiableError(`typescript cannot be loaded from ${packageDir}: install the dependencies first`, {
      cause: error,
    });
  }
}

/**
 * @param {string} dir absolute directory of a package with a `tsconfig.json`
 * @param {TypeScript} [ts] the package's own compiler when omitted
 * @returns {Workspace}
 */
export function loadWorkspace(dir, ts = loadTypeScript(dir)) {
  const configPath = path.join(dir, "tsconfig.json");
  const parsed = ts.getParsedCommandLineOfConfigFile(configPath, undefined, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: diagnostic => {
      throw new UnverifiableError(`${configPath}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")}`);
    },
  });
  if (!parsed) throw new UnverifiableError(`${configPath} could not be read`);
  return {
    ts,
    dir,
    options: { ...parsed.options, noEmit: true, incremental: false, tsBuildInfoFile: undefined },
    ambient: parsed.fileNames.filter(file => file.endsWith(".d.ts")),
  };
}

/**
 * @param {Workspace} workspace
 * @param {string} specifier a package name as an import would spell it
 * @returns {Set<string> | undefined} its exported names, or undefined when the workspace cannot resolve it
 */
export function listModuleExports({ ts, dir, options }, specifier) {
  const resolved = ts.resolveModuleName(specifier, path.join(dir, "exports-probe.ts"), options, ts.sys).resolvedModule;
  if (!resolved) return undefined;
  const program = ts.createProgram([resolved.resolvedFileName], options);
  const sourceFile = program.getSourceFile(resolved.resolvedFileName);
  const moduleSymbol = sourceFile && program.getTypeChecker().getSymbolAtLocation(sourceFile);
  if (!moduleSymbol) return new Set();
  return new Set(
    program
      .getTypeChecker()
      .getExportsOfModule(moduleSymbol)
      .map(symbol => symbol.name),
  );
}

/**
 * Type-checks in-memory files as if they sat in the workspace, so its path aliases and dependencies resolve.
 * @param {Workspace} workspace
 * @param {Map<string, string>} files file name, relative to the workspace, to content
 * @returns {{ file: string, line: number, message: string }[]} line numbers are 1-based within each file
 */
export function typeCheckVirtualFiles({ ts, dir, options, ambient }, files) {
  const virtual = new Map([...files].map(([name, content]) => [path.join(dir, name), content]));
  const host = ts.createCompilerHost(options);
  const { fileExists, readFile, getSourceFile } = host;
  /** @param {string} file */
  const lookup = file => virtual.get(path.normalize(file));

  host.fileExists = file => lookup(file) !== undefined || fileExists(file);
  host.readFile = file => lookup(file) ?? readFile(file);
  host.getSourceFile = (file, languageVersion, ...rest) => {
    const content = lookup(file);
    return content === undefined
      ? getSourceFile(file, languageVersion, ...rest)
      : ts.createSourceFile(file, content, languageVersion, true);
  };

  const program = ts.createProgram([...virtual.keys(), ...ambient], options, host);
  return [...virtual.keys()].flatMap(file => {
    const sourceFile = program.getSourceFile(file);
    if (!sourceFile) throw new Error(`the compiler did not load ${file}`);
    const diagnostics = [...program.getSyntacticDiagnostics(sourceFile), ...program.getSemanticDiagnostics(sourceFile)];
    return diagnostics.map(diagnostic => ({
      file: path.relative(dir, file).split(path.sep).join("/"),
      line: sourceFile.getLineAndCharacterOfPosition(diagnostic.start ?? 0).line + 1,
      message: `TS${diagnostic.code}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`,
    }));
  });
}
