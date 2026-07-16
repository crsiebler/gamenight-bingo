import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { isBuiltin } from "node:module";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import * as ts from "typescript";

const ROOT = resolve(import.meta.dirname, "..");
const DOMAIN_ROOT = join(ROOT, "packages/domain");
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);
const JAVASCRIPT_SOURCE_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".cjs"]);
const MODULE_RESOLUTION_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".d.ts",
  ".js",
  ".jsx",
  ".mts",
  ".d.mts",
  ".mjs",
  ".cts",
  ".d.cts",
  ".cjs",
];
const MODULE_EXTENSION_SUBSTITUTIONS = new Map([
  [".js", [".ts", ".tsx", ".d.ts", ".js", ".jsx"]],
  [".jsx", [".tsx", ".ts", ".d.ts", ".jsx", ".js"]],
  [".mjs", [".mts", ".d.mts", ".mjs"]],
  [".cjs", [".cts", ".d.cts", ".cjs"]],
]);
const TYPECHECK_SCRIPT = "tsc --project tsconfig.json --pretty false";
const STRICT_COMPILER_OPTIONS = [
  "alwaysStrict",
  "noImplicitAny",
  "noImplicitThis",
  "strictBindCallApply",
  "strictBuiltinIteratorReturn",
  "strictFunctionTypes",
  "strictNullChecks",
  "strictPropertyInitialization",
  "useUnknownInCatchVariables",
];
const EXPECTED_WORKSPACES = new Map([
  ["apps/web", "@gamenight-bingo/web"],
  ["apps/game-server", "@gamenight-bingo/game-server"],
  ["packages/contracts", "@gamenight-bingo/contracts"],
  ["packages/domain", "@gamenight-bingo/domain"],
  ["packages/database", "@gamenight-bingo/database"],
  ["packages/patterns", "@gamenight-bingo/patterns"],
  ["packages/themes", "@gamenight-bingo/themes"],
  ["packages/ui", "@gamenight-bingo/ui"],
  ["packages/test-support", "@gamenight-bingo/test-support"],
]);

export function isForbiddenDomainModule(specifier) {
  const canonicalSpecifier = specifier.replaceAll("\\", "/").toLowerCase();
  const forbiddenTypePackages = ["@types/react", "@types/next", "@types/prisma", "@types/socket.io"];
  return (
    canonicalSpecifier === "react" ||
    canonicalSpecifier.startsWith("react/") ||
    canonicalSpecifier.startsWith("react-") ||
    forbiddenTypePackages.some(
      (packageName) =>
        canonicalSpecifier === packageName ||
        canonicalSpecifier.startsWith(`${packageName}/`) ||
        canonicalSpecifier.startsWith(`${packageName}-`),
    ) ||
    canonicalSpecifier === "next" ||
    canonicalSpecifier.startsWith("next/") ||
    canonicalSpecifier.startsWith("@next/") ||
    canonicalSpecifier === "prisma" ||
    canonicalSpecifier.startsWith("prisma/") ||
    canonicalSpecifier.startsWith("@prisma/") ||
    canonicalSpecifier === "socket.io" ||
    canonicalSpecifier.startsWith("socket.io/") ||
    canonicalSpecifier.startsWith("socket.io-") ||
    canonicalSpecifier.startsWith("@socket.io/")
  );
}

function aliasedPackageName(version) {
  const match = /^npm:((?:@[^/]+\/)?[^@]+)(?:@|$)/u.exec(version);
  return match?.[1];
}

export function findForbiddenDomainDependencies(packageJson) {
  const forbidden = new Set();

  for (const section of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    const dependencies = packageJson[section];
    if (!dependencies || typeof dependencies !== "object" || Array.isArray(dependencies)) continue;

    for (const [name, version] of Object.entries(dependencies)) {
      const alias = typeof version === "string" ? aliasedPackageName(version) : undefined;
      if (isForbiddenDomainModule(name) || (alias && isForbiddenDomainModule(alias))) forbidden.add(name);
    }
  }

  return [...forbidden].sort();
}

function moduleReference(node) {
  if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return node.moduleSpecifier;
  if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference))
    return node.moduleReference.expression;
  if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) return node.argument.literal;
  if (ts.isJSDocImportTag(node)) return node.moduleSpecifier;
  return undefined;
}

function unwrapTransparentExpression(expression) {
  while (true) {
    if (
      ts.isParenthesizedExpression(expression) ||
      ts.isAsExpression(expression) ||
      ts.isTypeAssertionExpression(expression) ||
      ts.isNonNullExpression(expression) ||
      ts.isSatisfiesExpression(expression) ||
      ts.isPartiallyEmittedExpression(expression) ||
      ts.isExpressionWithTypeArguments(expression)
    ) {
      expression = expression.expression;
      continue;
    }
    if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.CommaToken) {
      expression = expression.right;
      continue;
    }
    return expression;
  }
}

function markRecognizedLoaderExpression(expression, recognizedLoaderNodes) {
  while (true) {
    recognizedLoaderNodes?.add(expression);
    if (
      ts.isParenthesizedExpression(expression) ||
      ts.isAsExpression(expression) ||
      ts.isTypeAssertionExpression(expression) ||
      ts.isNonNullExpression(expression) ||
      ts.isSatisfiesExpression(expression) ||
      ts.isPartiallyEmittedExpression(expression) ||
      ts.isExpressionWithTypeArguments(expression)
    ) {
      expression = expression.expression;
      continue;
    }
    if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.CommaToken) {
      expression = expression.right;
      continue;
    }
    if (ts.isPropertyAccessExpression(expression)) recognizedLoaderNodes?.add(expression.name);
    return;
  }
}

function staticMemberAccess(expression) {
  expression = unwrapTransparentExpression(expression);
  if (ts.isPropertyAccessExpression(expression))
    return {
      receiver: unwrapTransparentExpression(expression.expression),
      rawReceiver: expression.expression,
      name: expression.name.text,
    };
  if (ts.isElementAccessExpression(expression) && expression.argumentExpression) {
    const name = staticStringValue(expression.argumentExpression);
    if (name !== undefined)
      return {
        receiver: unwrapTransparentExpression(expression.expression),
        rawReceiver: expression.expression,
        name,
      };
  }
  return undefined;
}

function staticStringValue(expression) {
  expression = unwrapTransparentExpression(expression);
  if (ts.isStringLiteralLike(expression)) return expression.text;
  if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = staticStringValue(expression.left);
    const right = staticStringValue(expression.right);
    if (left !== undefined && right !== undefined) return left + right;
  }
  return undefined;
}

function isCommonJsRequire(expression) {
  expression = unwrapTransparentExpression(expression);
  if (ts.isIdentifier(expression)) return expression.text === "require";
  const member = staticMemberAccess(expression);
  return member?.name === "require" && ts.isIdentifier(member.receiver) && member.receiver.text === "module";
}

function appliedArguments(kind, argumentsList) {
  if (kind === "call") return argumentsList.slice(1);
  const argumentList = argumentsList[1] && unwrapTransparentExpression(argumentsList[1]);
  if (!argumentList || !ts.isArrayLiteralExpression(argumentList)) return undefined;
  return argumentList.elements.map(unwrapTransparentExpression);
}

function commonJsBindFunction(expression, recognizedLoaderNodes) {
  expression = unwrapTransparentExpression(expression);
  const member = staticMemberAccess(expression);
  if (member?.name === "bind") {
    const loader = commonJsLoaderFunction(member.rawReceiver, recognizedLoaderNodes);
    if (loader)
      return (argumentsList) => {
        const boundArguments = argumentsList.slice(1).map(unwrapTransparentExpression);
        return (invocationArguments) => loader([...boundArguments, ...invocationArguments]);
      };
  }
  if (member && ["call", "apply"].includes(member.name)) {
    const bind = commonJsBindFunction(member.rawReceiver, recognizedLoaderNodes);
    if (bind)
      return (argumentsList) => bind(appliedArguments(member.name, argumentsList) ?? []);
  }
  if (ts.isCallExpression(expression)) {
    const invocationMember = staticMemberAccess(expression.expression);
    if (invocationMember?.name === "bind") {
      const bind = commonJsBindFunction(invocationMember.rawReceiver, recognizedLoaderNodes);
      if (bind) {
        const boundArguments = [...expression.arguments].slice(1).map(unwrapTransparentExpression);
        return (argumentsList) => bind([...boundArguments, ...argumentsList]);
      }
    }
  }
  return undefined;
}

function commonJsLoaderFunction(expression, recognizedLoaderNodes) {
  const loaderExpression = expression;
  expression = unwrapTransparentExpression(expression);
  if (isCommonJsRequire(expression)) {
    markRecognizedLoaderExpression(loaderExpression, recognizedLoaderNodes);
    return (argumentsList) => argumentsList[0] && unwrapTransparentExpression(argumentsList[0]);
  }

  const member = staticMemberAccess(expression);
  if (member?.name === "call") {
    const loader = commonJsLoaderFunction(member.rawReceiver, recognizedLoaderNodes);
    if (loader) return (argumentsList) => loader(appliedArguments("call", argumentsList));
  }
  if (member?.name === "apply") {
    const loader = commonJsLoaderFunction(member.rawReceiver, recognizedLoaderNodes);
    if (loader) return (argumentsList) => loader(appliedArguments("apply", argumentsList) ?? []);
  }

  if (ts.isCallExpression(expression)) {
    const bind = commonJsBindFunction(expression.expression, recognizedLoaderNodes);
    if (bind) return bind([...expression.arguments]);
  }

  return undefined;
}

function loaderReference(node, recognizedLoaderNodes) {
  if (!ts.isCallExpression(node) && !ts.isNewExpression(node)) return undefined;
  const expression = node.expression;
  if (
    ts.isCallExpression(node) &&
    unwrapTransparentExpression(expression).kind === ts.SyntaxKind.ImportKeyword
  )
    return {
      kind: "dynamic import",
      argument: node.arguments[0] && unwrapTransparentExpression(node.arguments[0]),
    };
  const loader = commonJsLoaderFunction(expression, recognizedLoaderNodes);
  if (loader) return { kind: "require", argument: loader([...(node.arguments ?? [])]) };
  return undefined;
}

function sourceScriptKind(fileName) {
  const extension = fileName.slice(fileName.lastIndexOf(".")).toLowerCase();
  if (extension === ".tsx") return ts.ScriptKind.TSX;
  if (extension === ".jsx") return ts.ScriptKind.JSX;
  if ([".js", ".mjs", ".cjs"].includes(extension)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function isAbsoluteModuleSpecifier(specifier) {
  const normalized = specifier.replaceAll("\\", "/");
  return normalized.startsWith("/") || /^file:/iu.test(normalized) || /^[a-z]:\//iu.test(normalized);
}

function modulePathCandidates(target) {
  const candidates = new Set([target]);
  const extension = extname(target).toLowerCase();
  if (extension === "") {
    for (const candidateExtension of MODULE_RESOLUTION_EXTENSIONS)
      candidates.add(`${target}${candidateExtension}`);
    for (const candidateExtension of MODULE_RESOLUTION_EXTENSIONS)
      candidates.add(join(target, `index${candidateExtension}`));
  } else {
    const substitutions = MODULE_EXTENSION_SUBSTITUTIONS.get(extension);
    if (substitutions) {
      const extensionlessTarget = target.slice(0, -extension.length);
      for (const candidateExtension of substitutions)
        candidates.add(`${extensionlessTarget}${candidateExtension}`);
    }
  }
  return [...candidates];
}

export function findDomainImportViolations(
  source,
  fileName = "domain.ts",
  domainRoot,
  findSymbolicLink = findSymbolicLinkInPath,
  allowedPackages,
) {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    sourceScriptKind(fileName),
  );
  const violations = [];
  const visitedJsDoc = new Set();
  const recognizedLoaderNodes = new Set();

  function addViolation(position, message, specifier) {
    const safePosition = Math.max(0, Math.min(position ?? 0, sourceFile.end));
    const { line } = sourceFile.getLineAndCharacterOfPosition(safePosition);
    violations.push({ line: line + 1, message, specifier });
  }

  function inspectDeclaredPackage(specifier, position) {
    if (!allowedPackages || specifier.startsWith(".") || isAbsoluteModuleSpecifier(specifier)) return;
    const canonicalSpecifier = specifier.replaceAll("\\", "/");
    const segments = canonicalSpecifier.split("/");
    if (segments.some((segment) => segment === "." || segment === ".." || segment === "")) {
      addViolation(position, `Package import path traversal is not allowed: "${specifier}".`, specifier);
      return;
    }
    if (isBuiltin(canonicalSpecifier) || isForbiddenDomainModule(canonicalSpecifier)) return;
    const packageName = canonicalSpecifier.startsWith("@")
      ? segments.slice(0, 2).join("/")
      : segments[0];
    if (!allowedPackages.has(packageName))
      addViolation(position, `Undeclared domain package import "${specifier}".`, specifier);
  }

  function inspectFileSystemSpecifier(
    specifier,
    position,
    escapeMessage,
    useUrlSemantics = false,
    isRelativeReference = false,
  ) {
    const normalized = specifier.replaceAll("\\", "/");
    if (isAbsoluteModuleSpecifier(normalized)) {
      addViolation(position, "Absolute paths and file URLs are not allowed in domain imports.", specifier);
      return;
    }
    if ((normalized.startsWith(".") || isRelativeReference) && domainRoot) {
      const sourceRoot = join(domainRoot, "src");
      let target;
      if (useUrlSemantics) {
        try {
          const targetUrl = new URL(normalized, pathToFileURL(fileName));
          if (targetUrl.search || targetUrl.hash) {
            addViolation(position, "Query strings and fragments are not allowed in domain imports.", specifier);
            return;
          }
          target = fileURLToPath(targetUrl);
        } catch {
          addViolation(position, "Unsafe encoded path characters are not allowed in domain imports.", specifier);
          return;
        }
      } else target = resolve(dirname(fileName), normalized);

      if (!isInside(sourceRoot, target)) addViolation(position, escapeMessage, specifier);
      else if (modulePathCandidates(target).some((candidate) => findSymbolicLink(domainRoot, candidate)))
        addViolation(position, "Symbolic links are not allowed in domain imports.", specifier);
    }
  }

  for (const diagnostic of sourceFile.parseDiagnostics) {
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
    addViolation(diagnostic.start ?? 0, `Cannot parse domain source: ${message}`, undefined);
  }
  if (sourceFile.checkJsDirective?.enabled === false)
    addViolation(
      sourceFile.checkJsDirective.pos,
      "@ts-nocheck is not allowed in domain source.",
      undefined,
    );

  function inspect(node) {
    const loader = loaderReference(node, recognizedLoaderNodes);
    const kind = loader?.kind;
    const loaderArgument = loader?.argument;
    const declaredReference = moduleReference(node);
    const reference = declaredReference ??
      (loaderArgument && ts.isStringLiteralLike(loaderArgument) ? loaderArgument : undefined);
    if (reference && ts.isStringLiteralLike(reference) && isForbiddenDomainModule(reference.text))
      addViolation(reference.getStart(sourceFile), `Forbidden domain import "${reference.text}".`, reference.text);

    if (reference && ts.isStringLiteralLike(reference))
      inspectDeclaredPackage(reference.text, reference.getStart(sourceFile));

    if (reference && ts.isStringLiteralLike(reference))
      inspectFileSystemSpecifier(
        reference.text,
        reference.getStart(sourceFile),
        "Relative imports cannot leave packages/domain.",
        kind === "dynamic import" ||
          ts.isImportDeclaration(node) ||
          ts.isExportDeclaration(node) ||
          ts.isImportTypeNode(node) ||
          ts.isJSDocImportTag(node),
      );

    if (kind && (!loaderArgument || !ts.isStringLiteralLike(loaderArgument)))
      addViolation(node.getStart(sourceFile), `A non-literal ${kind} is not allowed in domain code.`, undefined);

    if (isCommonJsRequire(node) && !recognizedLoaderNodes.has(node))
      addViolation(
        node.getStart(sourceFile),
        "A direct CommonJS loader value is not allowed in domain code.",
        undefined,
      );

    for (const jsDoc of node.jsDoc ?? []) {
      if (visitedJsDoc.has(jsDoc)) continue;
      visitedJsDoc.add(jsDoc);
      inspect(jsDoc);
    }

    ts.forEachChild(node, inspect);
  }

  for (const directive of sourceFile.typeReferenceDirectives) {
    if (isForbiddenDomainModule(directive.fileName))
      addViolation(
        directive.pos,
        `Forbidden domain type reference "${directive.fileName}".`,
        directive.fileName,
      );
    inspectDeclaredPackage(directive.fileName, directive.pos);
    inspectFileSystemSpecifier(
      directive.fileName,
      directive.pos,
      "Type references cannot leave packages/domain.",
    );
  }

  for (const directive of sourceFile.referencedFiles) {
    inspectFileSystemSpecifier(
      directive.fileName,
      directive.pos,
      "File references cannot leave packages/domain.",
      false,
      true,
    );
  }

  for (const directive of sourceFile.amdDependencies) {
    if (isForbiddenDomainModule(directive.path))
      addViolation(
        directive.pos,
        `Forbidden domain AMD dependency "${directive.path}".`,
        directive.path,
      );
    inspectDeclaredPackage(directive.path, directive.pos);
    inspectFileSystemSpecifier(
      directive.path,
      directive.pos,
      "AMD dependencies cannot leave packages/domain.",
    );
  }

  inspect(sourceFile);
  return violations;
}

function isSymbolicLink(path) {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

export function findSymbolicLinkInPath(root, target, inspect = isSymbolicLink) {
  if (!isInside(root, target)) return undefined;
  const segments = relative(root, target).split(sep).filter(Boolean);
  let candidate = root;
  if (inspect(candidate)) return candidate;
  for (const segment of segments) {
    candidate = join(candidate, segment);
    if (inspect(candidate)) return candidate;
  }
  return undefined;
}

export function collectDomainSourceFiles(
  directory,
  errors,
  readDirectory = readdirSync,
  root = directory,
  inspect = isSymbolicLink,
) {
  const files = [];
  if (inspect(directory)) {
    errors.push(`Symbolic links are not allowed in packages/domain source: ${relative(root, directory) || "."}`);
    return files;
  }
  for (const entry of readDirectory(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink())
      errors.push(`Symbolic links are not allowed in packages/domain source: ${relative(root, path)}`);
    else if (entry.isDirectory())
      files.push(...collectDomainSourceFiles(path, errors, readDirectory, root, inspect));
    else {
      const extension = entry.name.slice(entry.name.lastIndexOf(".")).toLowerCase();
      if (SOURCE_EXTENSIONS.has(extension)) {
        files.push(path);
        if (JAVASCRIPT_SOURCE_EXTENSIONS.has(extension))
          errors.push(
            `JavaScript source is not allowed in packages/domain because it bypasses the strict TypeScript check: ${relative(root, path)}`,
          );
      }
    }
  }
  return files;
}

export function findWorkspaceConfigurationErrors(workspace, manifest, tsconfig) {
  const errors = [];
  const typecheckScript = manifest.scripts?.typecheck;
  if (typeof typecheckScript !== "string" || typecheckScript.length === 0)
    errors.push(`${workspace}/package.json must define a typecheck script.`);
  else if (typecheckScript !== TYPECHECK_SCRIPT)
    errors.push(`${workspace}/package.json typecheck script must run TypeScript for its tsconfig.`);
  if (tsconfig.extends !== "../../tsconfig.base.json")
    errors.push(`${workspace}/tsconfig.json must extend "../../tsconfig.base.json".`);
  if (
    tsconfig.compilerOptions?.strict === false ||
    STRICT_COMPILER_OPTIONS.some((option) => tsconfig.compilerOptions?.[option] === false)
  )
    errors.push(`${workspace}/tsconfig.json cannot disable strict TypeScript options.`);
  if (tsconfig.compilerOptions?.noCheck === true)
    errors.push(`${workspace}/tsconfig.json cannot disable TypeScript type checking.`);
  if (workspace === "packages/domain" && hasModuleAliases(tsconfig.compilerOptions))
    errors.push("packages/domain/tsconfig.json cannot configure module aliases.");
  if (workspace === "packages/domain" && hasModuleResolutionRedirects(tsconfig.compilerOptions))
    errors.push("packages/domain/tsconfig.json cannot configure module resolution redirects.");
  if (workspace === "packages/domain" && hasImplicitModuleImports(tsconfig.compilerOptions))
    errors.push("packages/domain/tsconfig.json cannot configure implicit module imports.");
  return errors;
}

export function findWorkspaceSourceCoverageErrors(workspace, tsconfig) {
  const errors = [];
  const includesAllSource =
    Array.isArray(tsconfig.include) &&
    tsconfig.include.some((pattern) => pattern.replaceAll("\\", "/") === "src/**/*");
  if (!includesAllSource)
    errors.push(`${workspace}/tsconfig.json must include all source files with "src/**/*".`);
  if (
    (Array.isArray(tsconfig.files) && tsconfig.files.length > 0) ||
    (Array.isArray(tsconfig.exclude) && tsconfig.exclude.length > 0)
  )
    errors.push(`${workspace}/tsconfig.json cannot restrict source files with files or exclude.`);
  return errors;
}

export function findEffectiveWorkspaceConfigurationErrors(workspace, workspaceRoot, compilerOptions) {
  const errors = [];
  if (compilerOptions.noEmit !== true)
    errors.push(`${workspace}/tsconfig.json must enable noEmit after configuration inheritance.`);

  const sourceRoot = join(workspaceRoot, "src");
  for (const option of ["outDir", "declarationDir"]) {
    const outputDirectory = compilerOptions[option];
    if (typeof outputDirectory === "string" && isInside(sourceRoot, resolve(workspaceRoot, outputDirectory)))
      errors.push(`${workspace}/tsconfig.json cannot place effective ${option} under src.`);
  }
  return errors;
}

export function findUnexpectedWorkspaceErrors(workspaces) {
  const expected = new Set(EXPECTED_WORKSPACES.keys());
  return workspaces
    .filter((workspace) => !expected.has(workspace))
    .sort()
    .map((workspace) => `Unexpected workspace matched by root configuration: ${workspace}`);
}

export function findWorkspaceGlobErrors(workspaceGlobs) {
  const requiredGlobs = new Set(["apps/*", "packages/*"]);
  const errors = [];
  for (const requiredGlob of requiredGlobs)
    if (!workspaceGlobs.includes(requiredGlob))
      errors.push(`Root workspaces must include "${requiredGlob}".`);
  for (const workspaceGlob of workspaceGlobs)
    if (!requiredGlobs.has(workspaceGlob))
      errors.push(`Root workspaces cannot include unsupported glob "${workspaceGlob}".`);
  return errors;
}

function collectConfiguredWorkspacePaths() {
  const workspaces = [];
  for (const parent of ["apps", "packages"]) {
    const directory = join(ROOT, parent);
    if (!existsSync(directory)) continue;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const workspace = `${parent}/${entry.name}`;
      if (
        (entry.isDirectory() || entry.isSymbolicLink()) &&
        existsSync(join(ROOT, workspace, "package.json"))
      )
        workspaces.push(workspace);
    }
  }
  return workspaces;
}

function collectWorkspaceSourceFiles(directory) {
  const files = [];
  if (!existsSync(directory)) return files;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...collectWorkspaceSourceFiles(path));
    else if (entry.isFile()) {
      const extension = entry.name.slice(entry.name.lastIndexOf(".")).toLowerCase();
      if (SOURCE_EXTENSIONS.has(extension)) files.push(path);
    }
  }
  return files;
}

export function findUncheckedWorkspaceSourceFiles(workspace, workspaceRoot, sourceFiles, checkedFiles) {
  const checked = new Set(checkedFiles.map((path) => resolve(path)));
  return sourceFiles
    .filter((path) => !checked.has(resolve(path)))
    .map(
      (path) =>
        `${workspace}/tsconfig.json does not typecheck source file: ${relative(workspaceRoot, path)}`,
    )
    .sort();
}

export function findParsedTypeScriptConfigurationErrors(workspace, parsedConfig) {
  return (parsedConfig.errors ?? []).map(
    (diagnostic) =>
      `${workspace}/tsconfig.json cannot be parsed: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")}`,
  );
}

export function findRootTypeScriptConfigurationErrors(tsconfig) {
  const errors = [];
  const compilerOptions = tsconfig.compilerOptions;
  if (
    compilerOptions?.strict !== true ||
    STRICT_COMPILER_OPTIONS.some((option) => compilerOptions[option] === false)
  )
    errors.push("tsconfig.base.json must enable strict TypeScript.");
  if (tsconfig.extends !== undefined)
    errors.push("tsconfig.base.json cannot extend another TypeScript configuration.");
  if (compilerOptions?.noCheck === true)
    errors.push("tsconfig.base.json cannot disable TypeScript type checking.");
  if (
    [tsconfig.files, tsconfig.include, tsconfig.exclude].some(
      (patterns) => Array.isArray(patterns) && patterns.length > 0,
    )
  )
    errors.push("tsconfig.base.json cannot restrict inherited workspace source coverage.");
  if (hasModuleAliases(compilerOptions))
    errors.push("tsconfig.base.json cannot configure module aliases inherited by packages/domain.");
  if (hasModuleResolutionRedirects(compilerOptions))
    errors.push(
      "tsconfig.base.json cannot configure module resolution redirects inherited by packages/domain.",
    );
  if (
    !Array.isArray(compilerOptions?.types) ||
    compilerOptions.types.length > 0 ||
    hasImplicitModuleImports(compilerOptions)
  )
    errors.push("tsconfig.base.json cannot configure implicit module imports inherited by packages/domain.");
  return errors;
}

function hasModuleAliases(compilerOptions) {
  return (
    typeof compilerOptions?.baseUrl === "string" ||
    (compilerOptions?.paths &&
      typeof compilerOptions.paths === "object" &&
      !Array.isArray(compilerOptions.paths) &&
      Object.keys(compilerOptions.paths).length > 0)
  );
}

function hasModuleResolutionRedirects(compilerOptions) {
  return (
    (Array.isArray(compilerOptions?.rootDirs) && compilerOptions.rootDirs.length > 0) ||
    compilerOptions?.moduleSuffixes !== undefined
  );
}

function hasImplicitModuleImports(compilerOptions) {
  return (
    (Array.isArray(compilerOptions?.types) && compilerOptions.types.length > 0) ||
    (Array.isArray(compilerOptions?.typeRoots) && compilerOptions.typeRoots.length > 0) ||
    compilerOptions?.jsx !== undefined ||
    compilerOptions?.jsxImportSource !== undefined
  );
}

function collectStringValues(value, values) {
  if (typeof value === "string") values.add(value);
  else if (Array.isArray(value)) {
    for (const item of value) collectStringValues(item, values);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectStringValues(item, values);
  }
}

export function findDomainManifestConfigurationErrors(
  manifest,
  manifestRoot = DOMAIN_ROOT,
  domainRoot = DOMAIN_ROOT,
  findSymbolicLink = findSymbolicLinkInPath,
) {
  const errors = [];
  const manifestRelativeDirectory = relative(domainRoot, manifestRoot);
  const manifestPath = ["packages/domain", manifestRelativeDirectory, "package.json"]
    .filter(Boolean)
    .join("/");
  if (
    manifest.imports &&
    typeof manifest.imports === "object" &&
    !Array.isArray(manifest.imports) &&
    Object.keys(manifest.imports).length > 0
  )
    errors.push(`${manifestPath} cannot configure import aliases.`);

  const targets = new Set();
  for (const field of ["main", "module", "types", "typings", "exports", "typesVersions", "browser"])
    collectStringValues(manifest[field], targets);

  const browserTargets = new Set();
  collectStringValues(manifest.browser, browserTargets);
  for (const target of browserTargets) {
    const normalized = target.replaceAll("\\", "/");
    if (!normalized.startsWith("."))
      errors.push(`${manifestPath} browser target must be a relative domain source path: ${target}`);
  }

  const sourceRoot = join(domainRoot, "src");
  for (const target of targets) {
    const normalized = target.replaceAll("\\", "/");
    if (browserTargets.has(target) && !normalized.startsWith(".")) continue;
    if (isAbsoluteModuleSpecifier(normalized)) {
      errors.push(
        `${manifestPath} package resolution target cannot leave packages/domain/src: ${target}`,
      );
      continue;
    }
    const resolvedTarget = resolve(manifestRoot, normalized);
    if (!isInside(sourceRoot, resolvedTarget))
      errors.push(
        `${manifestPath} package resolution target cannot leave packages/domain/src: ${target}`,
      );
    else if (
      modulePathCandidates(resolvedTarget).some((candidate) => findSymbolicLink(domainRoot, candidate))
    )
      errors.push(`${manifestPath} package resolution target cannot use symbolic links: ${target}`);
  }
  return errors;
}

export function collectDomainPackageManifestFiles(directory, readDirectory = readdirSync) {
  const manifests = [];
  for (const entry of readDirectory(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) manifests.push(...collectDomainPackageManifestFiles(path, readDirectory));
    else if (entry.name === "package.json") manifests.push(path);
  }
  return manifests;
}

function readJson(path, errors) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    errors.push(`${relative(ROOT, path)} is not valid JSON: ${error.message}`);
    return undefined;
  }
}

function isInside(parent, child) {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== "..");
}

export function checkWorkspaceBoundaries() {
  const errors = [];
  const rootPackage = readJson(join(ROOT, "package.json"), errors);
  const rootTypeScriptConfig = readJson(join(ROOT, "tsconfig.base.json"), errors);
  const workspaceGlobs = Array.isArray(rootPackage?.workspaces) ? rootPackage.workspaces : [];

  if (rootTypeScriptConfig)
    errors.push(...findRootTypeScriptConfigurationErrors(rootTypeScriptConfig));

  errors.push(...findWorkspaceGlobErrors(workspaceGlobs));
  errors.push(...findUnexpectedWorkspaceErrors(collectConfiguredWorkspacePaths()));

  const packageNames = new Set();
  for (const [workspace, expectedName] of EXPECTED_WORKSPACES) {
    const workspaceRoot = join(ROOT, workspace);
    const manifestPath = join(workspaceRoot, "package.json");
    const tsconfigPath = join(workspaceRoot, "tsconfig.json");
    for (const requiredPath of [manifestPath, tsconfigPath, join(workspaceRoot, "src/index.ts")])
      if (!existsSync(requiredPath)) errors.push(`Missing required workspace file: ${relative(ROOT, requiredPath)}`);

    if (!existsSync(manifestPath)) continue;
    const manifest = readJson(manifestPath, errors);
    if (!manifest) continue;
    const tsconfig = existsSync(tsconfigPath) ? readJson(tsconfigPath, errors) : undefined;
    if (manifest.name !== expectedName)
      errors.push(`${workspace}/package.json must use package name "${expectedName}".`);
    if (packageNames.has(manifest.name)) errors.push(`Duplicate workspace package name: ${manifest.name}`);
    packageNames.add(manifest.name);
    if (tsconfig) {
      errors.push(...findWorkspaceConfigurationErrors(workspace, manifest, tsconfig));
      errors.push(...findWorkspaceSourceCoverageErrors(workspace, tsconfig));
      const parsedConfig = ts.getParsedCommandLineOfConfigFile(tsconfigPath, {}, {
        ...ts.sys,
        onUnRecoverableConfigFileDiagnostic(diagnostic) {
          errors.push(
            `${workspace}/tsconfig.json cannot be parsed: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")}`,
          );
        },
      });
      if (parsedConfig) {
        errors.push(
          ...findParsedTypeScriptConfigurationErrors(workspace, parsedConfig),
          ...findEffectiveWorkspaceConfigurationErrors(workspace, workspaceRoot, parsedConfig.options),
          ...findUncheckedWorkspaceSourceFiles(
            workspace,
            workspaceRoot,
            collectWorkspaceSourceFiles(join(workspaceRoot, "src")),
            parsedConfig.fileNames,
          ),
        );
      }
    }
  }

  const domainManifest = readJson(join(DOMAIN_ROOT, "package.json"), errors);
  const allowedDomainPackages = new Set();
  if (domainManifest) {
    errors.push(...findDomainManifestConfigurationErrors(domainManifest));
    if (typeof domainManifest.name === "string") allowedDomainPackages.add(domainManifest.name);
    for (const section of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"])
      for (const dependency of Object.keys(domainManifest[section] ?? {}))
        allowedDomainPackages.add(dependency);
    for (const dependency of findForbiddenDomainDependencies(domainManifest))
      errors.push(`packages/domain/package.json declares forbidden dependency "${dependency}".`);
  }

  const domainSource = join(DOMAIN_ROOT, "src");
  if (existsSync(domainSource)) {
    for (const manifestPath of collectDomainPackageManifestFiles(domainSource)) {
      const manifest = readJson(manifestPath, errors);
      if (manifest)
        errors.push(
          ...findDomainManifestConfigurationErrors(manifest, dirname(manifestPath), DOMAIN_ROOT),
        );
    }
    for (const file of collectDomainSourceFiles(domainSource, errors)) {
      const source = readFileSync(file, "utf8");
      for (const violation of findDomainImportViolations(
        source,
        file,
        DOMAIN_ROOT,
        findSymbolicLinkInPath,
        allowedDomainPackages,
      ))
        errors.push(`${relative(ROOT, file)}:${violation.line}: ${violation.message}`);
    }
  }

  return errors;
}

if (import.meta.main) {
  const errors = checkWorkspaceBoundaries();
  if (errors.length > 0) {
    console.error(errors.map((error) => `- ${error}`).join("\n"));
    process.exitCode = 1;
  } else {
    console.log("Workspace boundaries passed.");
  }
}
