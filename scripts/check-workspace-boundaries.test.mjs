import assert from "node:assert/strict";

import * as boundaries from "./check-workspace-boundaries.mjs";

const { findDomainImportViolations, findForbiddenDomainDependencies, isForbiddenDomainModule } =
  boundaries;

const forbiddenSpecifiers = [
  "react",
  "React",
  "react-dom/client",
  "react\\jsx-runtime",
  "next/server",
  "@prisma/client",
  "socket.io-client",
  "@socket.io/admin-ui",
  "@types/react/index",
  "@types/next",
  "@types/prisma/client",
  "@types/socket.io-client",
];

for (const specifier of forbiddenSpecifiers) {
  assert.equal(isForbiddenDomainModule(specifier), true, specifier);
}

for (const specifier of ["reactive", "next-step", "prismatic", "socket-io-safe"])
  assert.equal(isForbiddenDomainModule(specifier), false, specifier);

const source = `
  import React from "react";
  export { headers } from "next/headers";
  import Prisma = require("@prisma/client");
  type Socket = import("socket.io").Socket;
  await import("react-dom/client");
  require("prisma/client");
  module.require("@socket.io/admin-ui");
  module["require"]("next/navigation");
  module.require.call(module, "react-dom/server");
`;

assert.deepEqual(
  findDomainImportViolations(source).map(({ specifier }) => specifier),
  [
    "react",
    "next/headers",
    "@prisma/client",
    "socket.io",
    "react-dom/client",
    "prisma/client",
    "@socket.io/admin-ui",
    "next/navigation",
    "react-dom/server",
  ],
);

assert.deepEqual(
  findDomainImportViolations(`
    // import React from "react";
    const documentation = 'next/server';
    import { value } from "@gamenight-bingo/contracts";
  `),
  [],
);

assert.match(
  findDomainImportViolations("await import(packageName);")[0]?.message ?? "",
  /non-literal dynamic import/i,
);
assert.match(
  findDomainImportViolations("require(packageName);")[0]?.message ?? "",
  /non-literal require/i,
);
assert.match(
  findDomainImportViolations('module["require"](packageName);')[0]?.message ?? "",
  /non-literal require/i,
);
assert.match(
  findDomainImportViolations("module.require.call(module, packageName);")[0]?.message ?? "",
  /non-literal require/i,
);

for (const parenthesizedLoad of [
  '(require)("react");',
  '(module.require)("next/server");',
  '(module["require"])("@prisma/client");',
  '(module.require).call(module, "socket.io");',
  '(module).require("react");',
  'module[("require")]("next/server");',
  '(require.call)(null, "@prisma/client");',
  '(module.require.call)(module, "socket.io");',
  'require["call"](null, "react");',
  'module.require["call"](module, "next/server");',
  'module["require"]["call"](module, "@prisma/client");',
  '(require as unknown as Function)("react");',
  '(module.require!)("next/server");',
  '(module["require" satisfies string])("@prisma/client");',
  '(require<string>)("react");',
  '(module.require<string>).call(module, "next/server");',
  '(module["require"]<string>).apply(module, ["@prisma/client"]);',
  '(0, require)("react");',
  '(0, module.require).call(module, "next/server");',
  '(0, module["require"]).apply(module, ["@prisma/client"]);',
  'require.apply(null, ["socket.io"]);',
  'module.require["apply"](module, ["react"]);',
  'require.bind(null)("react");',
  'module.require.bind(module)("next/server");',
]) {
  assert.equal(findDomainImportViolations(parenthesizedLoad).length, 1, parenthesizedLoad);
}

for (const composedLoad of [
  'require.bind(null).call(null, "react");',
  'module.require.bind(module).apply(null, ["next/server"]);',
  'require.call.bind(require)(null, "@prisma/client");',
  'module.require.apply.bind(module.require)(module, ["socket.io"]);',
  'require.bind.call(require, null, "react")();',
  'module.require.bind.apply(module.require, [module, "next/server"])();',
  'require.bind.call.call(require.bind, require, null, "@prisma/client")();',
  'module.require.bind.call.apply(module.require.bind, [module.require, module, "socket.io"])();',
  'require.bind.bind(require)(null, "react")();',
]) {
  assert.equal(
    findDomainImportViolations(composedLoad)[0]?.specifier,
    composedLoad.match(/"([^"]+)"/u)?.[1],
    composedLoad,
  );
}

for (const directLoaderValue of [
  'module["re" + "quire"]("react");',
  'Reflect.apply(require, null, ["next/server"]);',
  "Reflect.apply(require, null, packageNames);",
  'Function.prototype.call.call(require, null, "@prisma/client");',
  'Function.prototype.apply.call(module.require, module, ["socket.io"]);',
  'require("node:path", Reflect.apply(require, null, ["react"]));',
  'require.call(null, "node:path", Reflect.apply(require, null, ["react"]));',
  'require.apply(null, ["node:path", Reflect.apply(require, null, ["react"])]);',
  "const loader = require;",
]) {
  assert.ok(findDomainImportViolations(directLoaderValue).length > 0, directLoaderValue);
}

for (const constructedLoad of ['new require("react");', 'new (module.require)("next/server");']) {
  assert.equal(
    findDomainImportViolations(constructedLoad)[0]?.specifier,
    constructedLoad.match(/"([^"]+)"/u)?.[1],
    constructedLoad,
  );
}

for (const parenthesizedLoad of [
  "(require)(packageName);",
  "(module.require)(packageName);",
  '(module["require"])(packageName);',
  "(module.require).call(module, packageName);",
  "(module).require(packageName);",
  'module[("require")](packageName);',
  "(require.call)(null, packageName);",
  "(module.require.call)(module, packageName);",
  'require["call"](null, packageName);',
  'module.require["call"](module, packageName);',
  'module["require"]["call"](module, packageName);',
  "(require as unknown as Function)(packageName);",
  "(module.require!)(packageName);",
  '(module["require" satisfies string])(packageName);',
  "(require<string>)(packageName);",
  "(module.require<string>).call(module, packageName);",
  '(module["require"]<string>).apply(module, [packageName]);',
  "(0, require)(packageName);",
  "(0, module.require).call(module, packageName);",
  '(0, module["require"]).apply(module, [packageName]);',
  "require.apply(null, packageNames);",
  "module.require.apply(module, [packageName]);",
  "require.bind(null)(packageName);",
  "module.require.bind(module)(packageName);",
  "require.bind.call(require, null, packageName)();",
  "module.require.bind.apply(module.require, [module, packageName])();",
  "require.bind.call.call(require.bind, require, null, packageName)();",
  "module.require.bind.call.apply(module.require.bind, [module.require, module, packageName])();",
  "new require(packageName);",
  "new (module.require)(packageName);",
]) {
  assert.match(
    findDomainImportViolations(parenthesizedLoad)[0]?.message ?? "",
    /non-literal require/i,
    parenthesizedLoad,
  );
}

assert.deepEqual(
  findDomainImportViolations(`
    /// <reference types="react" />
    /** @type {import("next/server").NextRequest} */
    const request = {};
  `).map(({ specifier }) => specifier),
  ["react", "next/server"],
);

assert.deepEqual(
  findDomainImportViolations(`
    /** @import { PrismaClient } from "@prisma/client" */
    const client = {};
  `).map(({ specifier }) => specifier),
  ["@prisma/client"],
);

const domainRoot = "/repo/packages/domain";
const domainFile = `${domainRoot}/src/fixture.ts`;
for (const relativeLoad of [
  'import "../../database/src/index.ts";',
  'import "..\\\\..\\\\database\\\\src\\\\index.ts";',
  'await import("../../database/src/index.ts");',
  'require("../../database/src/index.ts");',
  '/// <reference path="../../database/src/index.ts" />',
  '/// <reference path="..\\\\..\\\\database\\\\src\\\\index.ts" />',
  '/// <reference path="inside/../../../database/src/index.ts" />',
  '/// <reference types="../../database/src/index.ts" />',
  'import "../bridge.ts";',
  '/// <reference path="../bridge.ts" />',
]) {
  assert.match(
    findDomainImportViolations(relativeLoad, domainFile, domainRoot)[0]?.message ?? "",
    /cannot leave packages\/domain/i,
  );
}

assert.deepEqual(findDomainImportViolations('import "./rules.ts";', domainFile, domainRoot), []);
assert.match(
  findDomainImportViolations(
    'import "./shared/rules.ts";',
    domainFile,
    domainRoot,
    (_root, target) =>
      target.includes("/shared") ? "/repo/packages/domain/src/shared" : undefined,
  )[0]?.message ?? "",
  /symbolic links are not allowed/i,
);
assert.match(
  findDomainImportViolations('import "./shared/rules";', domainFile, domainRoot, (_root, target) =>
    target.endsWith("/shared/rules.ts") ? target : undefined,
  )[0]?.message ?? "",
  /symbolic links are not allowed/i,
);
assert.match(
  findDomainImportViolations('import "./shared";', domainFile, domainRoot, (_root, target) =>
    target.endsWith("/shared/index.ts") ? target : undefined,
  )[0]?.message ?? "",
  /symbolic links are not allowed/i,
);
assert.match(
  findDomainImportViolations('import "./shared/rules";', domainFile, domainRoot, (_root, target) =>
    target.endsWith("/shared/rules.d.ts") ? target : undefined,
  )[0]?.message ?? "",
  /symbolic links are not allowed/i,
);
assert.match(
  findDomainImportViolations(
    'import "./shared/rules.js";',
    domainFile,
    domainRoot,
    (_root, target) => (target.endsWith("/shared/rules.ts") ? target : undefined),
  )[0]?.message ?? "",
  /symbolic links are not allowed/i,
);

assert.match(
  findDomainImportViolations(
    'import "./%2e%2e/%2e%2e/database/index.js";',
    domainFile,
    domainRoot,
  )[0]?.message ?? "",
  /cannot leave packages\/domain/i,
);
assert.match(
  findDomainImportViolations('import "./safe%2fescape.js";', domainFile, domainRoot)[0]?.message ??
    "",
  /unsafe encoded path/i,
);
assert.match(
  findDomainImportViolations('import "./rules.ts?raw";', domainFile, domainRoot)[0]?.message ?? "",
  /query strings and fragments are not allowed/i,
);
assert.deepEqual(
  findDomainImportViolations('require("./%2e%2e/rules.js");', domainFile, domainRoot),
  [],
);

assert.deepEqual(
  findDomainImportViolations('<Widget>value;\nimport "react";', domainFile, domainRoot).map(
    ({ specifier }) => specifier,
  ),
  ["react"],
);
assert.match(
  findDomainImportViolations("const broken = ;", domainFile, domainRoot)[0]?.message ?? "",
  /cannot parse domain source/i,
);

for (const unsupportedLoad of [
  'import "/outside/react";',
  'import "file:///outside/react";',
  'import "C:\\\\outside\\\\react";',
]) {
  assert.match(
    findDomainImportViolations(unsupportedLoad, domainFile, domainRoot)[0]?.message ?? "",
    /absolute paths and file URLs are not allowed/i,
  );
}

assert.deepEqual(
  findDomainImportViolations('/// <amd-dependency path="react" />', domainFile, domainRoot).map(
    ({ specifier }) => specifier,
  ),
  ["react"],
);
assert.match(
  findDomainImportViolations(
    '/// <amd-dependency path="../../database/src/index.ts" />',
    domainFile,
    domainRoot,
  )[0]?.message ?? "",
  /cannot leave packages\/domain/i,
);

for (const undeclaredDirective of [
  '/// <reference types="framework" />',
  '/// <amd-dependency path="framework" />',
]) {
  assert.match(
    findDomainImportViolations(undeclaredDirective, domainFile, domainRoot, undefined, new Set())[0]
      ?.message ?? "",
    /undeclared domain package import/i,
    undeclaredDirective,
  );
}

assert.match(
  findDomainImportViolations('// @ts-nocheck\nimport "./rules.ts";', domainFile, domainRoot)[0]
    ?.message ?? "",
  /ts-nocheck is not allowed/i,
);

assert.deepEqual(
  findForbiddenDomainDependencies({
    dependencies: {
      framework: "npm:react@19.0.0",
      "@prisma/client": "6.0.0",
      "@gamenight-bingo/contracts": "workspace:*",
    },
  }),
  ["@prisma/client", "framework"],
);

assert.match(
  findDomainImportViolations('import "framework";', domainFile, domainRoot, undefined, new Set())[0]
    ?.message ?? "",
  /undeclared domain package import/i,
);
assert.deepEqual(
  findDomainImportViolations(
    'import "@gamenight-bingo/contracts/schema"; import "node:crypto";',
    domainFile,
    domainRoot,
    undefined,
    new Set(["@gamenight-bingo/contracts"]),
  ),
  [],
);

for (const traversingImport of [
  'import "@gamenight-bingo/domain/../../react";',
  'require("@gamenight-bingo/domain\\\\..\\\\..\\\\react");',
  'import "safe/../react";',
]) {
  assert.match(
    findDomainImportViolations(
      traversingImport,
      domainFile,
      domainRoot,
      undefined,
      new Set(["@gamenight-bingo/domain", "safe"]),
    )[0]?.message ?? "",
    /package import path traversal/i,
    traversingImport,
  );
}

for (const section of ["devDependencies", "peerDependencies", "optionalDependencies"]) {
  assert.deepEqual(
    findForbiddenDomainDependencies({ [section]: { framework: "npm:react@19.0.0" } }),
    ["framework"],
  );
}

assert.deepEqual(
  findForbiddenDomainDependencies({
    dependencies: {
      "@types/next": "1.0.0",
      "@types/socket.io": "3.0.0",
    },
  }),
  ["@types/next", "@types/socket.io"],
);

assert.equal(typeof boundaries.findWorkspaceConfigurationErrors, "function");
if (boundaries.findWorkspaceConfigurationErrors) {
  assert.deepEqual(
    boundaries.findWorkspaceConfigurationErrors(
      "apps/web",
      { scripts: {} },
      { extends: "../../tsconfig.base.json" },
    ),
    ["apps/web/package.json must define a typecheck script."],
  );
  assert.deepEqual(
    boundaries.findWorkspaceConfigurationErrors(
      "apps/web",
      { scripts: { typecheck: "tsc --project tsconfig.json --pretty false" } },
      {},
    ),
    ['apps/web/tsconfig.json must extend "../../tsconfig.base.json".'],
  );
  assert.deepEqual(
    boundaries.findWorkspaceConfigurationErrors(
      "apps/web",
      { scripts: { typecheck: "true" } },
      { extends: "../../tsconfig.base.json" },
    ),
    ["apps/web/package.json typecheck script must run TypeScript for its tsconfig."],
  );
  assert.deepEqual(
    boundaries.findWorkspaceConfigurationErrors(
      "apps/web",
      { scripts: { typecheck: "tsc --project tsconfig.json --pretty false" } },
      { extends: "../../tsconfig.base.json", compilerOptions: { strict: false } },
    ),
    ["apps/web/tsconfig.json cannot disable strict TypeScript options."],
  );
  assert.deepEqual(
    boundaries.findWorkspaceConfigurationErrors(
      "apps/web",
      { scripts: { typecheck: "tsc --project tsconfig.json --pretty false" } },
      { extends: "../../tsconfig.base.json", compilerOptions: { strictNullChecks: false } },
    ),
    ["apps/web/tsconfig.json cannot disable strict TypeScript options."],
  );
  assert.deepEqual(
    boundaries.findWorkspaceConfigurationErrors(
      "packages/domain",
      { scripts: { typecheck: "tsc --project tsconfig.json --pretty false" } },
      {
        extends: "../../tsconfig.base.json",
        compilerOptions: { baseUrl: ".", paths: { framework: ["../../node_modules/react"] } },
      },
    ),
    ["packages/domain/tsconfig.json cannot configure module aliases."],
  );
  assert.deepEqual(
    boundaries.findWorkspaceConfigurationErrors(
      "packages/domain",
      { scripts: { typecheck: "tsc --project tsconfig.json --pretty false" } },
      {
        extends: "../../tsconfig.base.json",
        compilerOptions: { rootDirs: ["src", "../database/src"] },
      },
    ),
    ["packages/domain/tsconfig.json cannot configure module resolution redirects."],
  );
  assert.deepEqual(
    boundaries.findWorkspaceConfigurationErrors(
      "packages/domain",
      { scripts: { typecheck: "tsc --project tsconfig.json --pretty false" } },
      {
        extends: "../../tsconfig.base.json",
        compilerOptions: { moduleSuffixes: [".native", ""] },
      },
    ),
    ["packages/domain/tsconfig.json cannot configure module resolution redirects."],
  );
  assert.deepEqual(
    boundaries.findWorkspaceConfigurationErrors(
      "packages/domain",
      { scripts: { typecheck: "tsc --project tsconfig.json --pretty false" } },
      {
        extends: "../../tsconfig.base.json",
        compilerOptions: { noCheck: true },
      },
    ),
    ["packages/domain/tsconfig.json cannot disable TypeScript type checking."],
  );
  assert.deepEqual(
    boundaries.findWorkspaceConfigurationErrors(
      "packages/domain",
      { scripts: { typecheck: "tsc --project tsconfig.json --pretty false" } },
      {
        extends: "../../tsconfig.base.json",
        compilerOptions: { jsx: "react-jsx", jsxImportSource: "react", types: ["react"] },
      },
    ),
    ["packages/domain/tsconfig.json cannot configure implicit module imports."],
  );
  assert.deepEqual(
    boundaries.findWorkspaceConfigurationErrors(
      "apps/web",
      { scripts: { typecheck: "tsc --project tsconfig.json --pretty false" } },
      { extends: "../../tsconfig.base.json", compilerOptions: { paths: { "@/*": ["./src/*"] } } },
    ),
    [],
  );
}

assert.equal(typeof boundaries.findWorkspaceSourceCoverageErrors, "function");
if (boundaries.findWorkspaceSourceCoverageErrors) {
  assert.deepEqual(
    boundaries.findWorkspaceSourceCoverageErrors("packages/domain", {
      include: ["src/**/*.ts", "src/**/*.tsx"],
    }),
    ['packages/domain/tsconfig.json must include all source files with "src/**/*".'],
  );
  assert.deepEqual(
    boundaries.findWorkspaceSourceCoverageErrors("packages/domain", {
      include: ["src/**/*"],
      files: ["src/index.ts"],
      exclude: ["src/private"],
    }),
    ["packages/domain/tsconfig.json cannot restrict source files with files or exclude."],
  );
  assert.deepEqual(
    boundaries.findWorkspaceSourceCoverageErrors("packages/domain", { include: ["src/**/*"] }),
    [],
  );
}

assert.equal(typeof boundaries.findEffectiveWorkspaceConfigurationErrors, "function");
if (boundaries.findEffectiveWorkspaceConfigurationErrors) {
  const workspaceRoot = "/repo/packages/domain";
  assert.deepEqual(
    boundaries.findEffectiveWorkspaceConfigurationErrors("packages/domain", workspaceRoot, {
      noEmit: false,
      outDir: "/repo/packages/domain/src/../src/generated",
      declarationDir: "/repo/packages/domain/src/types",
    }),
    [
      "packages/domain/tsconfig.json must enable noEmit after configuration inheritance.",
      "packages/domain/tsconfig.json cannot place effective outDir under src.",
      "packages/domain/tsconfig.json cannot place effective declarationDir under src.",
    ],
  );
  assert.deepEqual(
    boundaries.findEffectiveWorkspaceConfigurationErrors("packages/domain", workspaceRoot, {
      noEmit: true,
      outDir: "/repo/dist/domain",
      declarationDir: "/repo/types/domain",
    }),
    [],
  );
}

assert.equal(typeof boundaries.findUncheckedWorkspaceSourceFiles, "function");
if (boundaries.findUncheckedWorkspaceSourceFiles) {
  assert.deepEqual(
    boundaries.findUncheckedWorkspaceSourceFiles(
      "packages/domain",
      "/repo/packages/domain",
      [
        "/repo/packages/domain/src/index.ts",
        "/repo/packages/domain/src/.hidden/rules.ts",
        "/repo/packages/domain/src/node_modules/rules.ts",
      ],
      ["/repo/packages/domain/src/index.ts"],
    ),
    [
      "packages/domain/tsconfig.json does not typecheck source file: src/.hidden/rules.ts",
      "packages/domain/tsconfig.json does not typecheck source file: src/node_modules/rules.ts",
    ],
  );
}

assert.equal(typeof boundaries.findUnexpectedWorkspaceErrors, "function");
if (boundaries.findUnexpectedWorkspaceErrors) {
  assert.deepEqual(
    boundaries.findUnexpectedWorkspaceErrors([
      "apps/web",
      "apps/game-server",
      "packages/domain",
      "packages/extra",
    ]),
    ["Unexpected workspace matched by root configuration: packages/extra"],
  );
}

assert.equal(typeof boundaries.findWorkspaceGlobErrors, "function");
if (boundaries.findWorkspaceGlobErrors) {
  assert.deepEqual(boundaries.findWorkspaceGlobErrors(["apps/*", "packages/*"]), []);
  assert.deepEqual(boundaries.findWorkspaceGlobErrors(["apps/*", "packages/*", "tools/*"]), [
    'Root workspaces cannot include unsupported glob "tools/*".',
  ]);
}

assert.equal(typeof boundaries.findParsedTypeScriptConfigurationErrors, "function");
if (boundaries.findParsedTypeScriptConfigurationErrors) {
  assert.deepEqual(
    boundaries.findParsedTypeScriptConfigurationErrors("packages/domain", {
      errors: [{ messageText: "Unknown compiler option 'unsafeOption'." }],
    }),
    ["packages/domain/tsconfig.json cannot be parsed: Unknown compiler option 'unsafeOption'."],
  );
}

assert.equal(typeof boundaries.findRootTypeScriptConfigurationErrors, "function");
if (boundaries.findRootTypeScriptConfigurationErrors) {
  assert.deepEqual(boundaries.findRootTypeScriptConfigurationErrors({ compilerOptions: {} }), [
    "tsconfig.base.json must enable strict TypeScript.",
    "tsconfig.base.json cannot configure implicit module imports inherited by packages/domain.",
  ]);
  assert.deepEqual(
    boundaries.findRootTypeScriptConfigurationErrors({
      compilerOptions: { strict: true, types: [], paths: { framework: ["./node_modules/react"] } },
    }),
    ["tsconfig.base.json cannot configure module aliases inherited by packages/domain."],
  );
  assert.deepEqual(
    boundaries.findRootTypeScriptConfigurationErrors({
      compilerOptions: {
        strict: true,
        types: [],
        rootDirs: ["packages/domain/src", "packages/database/src"],
      },
    }),
    [
      "tsconfig.base.json cannot configure module resolution redirects inherited by packages/domain.",
    ],
  );
  assert.deepEqual(
    boundaries.findRootTypeScriptConfigurationErrors({
      compilerOptions: { strict: true, types: [], moduleSuffixes: [".native", ""] },
    }),
    [
      "tsconfig.base.json cannot configure module resolution redirects inherited by packages/domain.",
    ],
  );
  assert.deepEqual(
    boundaries.findRootTypeScriptConfigurationErrors({
      compilerOptions: { strict: true, types: [] },
      exclude: ["packages/domain/src/private"],
    }),
    ["tsconfig.base.json cannot restrict inherited workspace source coverage."],
  );
  assert.deepEqual(
    boundaries.findRootTypeScriptConfigurationErrors({
      extends: "./external.json",
      compilerOptions: { strict: true, types: [] },
    }),
    ["tsconfig.base.json cannot extend another TypeScript configuration."],
  );
  assert.deepEqual(
    boundaries.findRootTypeScriptConfigurationErrors({
      compilerOptions: { strict: true, noCheck: true, types: [] },
    }),
    ["tsconfig.base.json cannot disable TypeScript type checking."],
  );
  assert.deepEqual(
    boundaries.findRootTypeScriptConfigurationErrors({
      compilerOptions: { strict: true, types: ["react"], jsx: "react-jsx" },
    }),
    ["tsconfig.base.json cannot configure implicit module imports inherited by packages/domain."],
  );
}

assert.equal(typeof boundaries.findDomainManifestConfigurationErrors, "function");
if (boundaries.findDomainManifestConfigurationErrors) {
  assert.deepEqual(boundaries.findDomainManifestConfigurationErrors({}), []);
  assert.deepEqual(
    boundaries.findDomainManifestConfigurationErrors({ imports: { "#framework": "react" } }),
    ["packages/domain/package.json cannot configure import aliases."],
  );
  assert.deepEqual(
    boundaries.findDomainManifestConfigurationErrors(
      { exports: "../database/src/index.ts" },
      "/repo/packages/domain",
      "/repo/packages/domain",
    ),
    [
      "packages/domain/package.json package resolution target cannot leave packages/domain/src: ../database/src/index.ts",
    ],
  );
  assert.deepEqual(
    boundaries.findDomainManifestConfigurationErrors(
      { main: "../../../database/src/index.ts", types: "../../../contracts/src/index.ts" },
      "/repo/packages/domain/src/nested",
      "/repo/packages/domain",
    ),
    [
      "packages/domain/src/nested/package.json package resolution target cannot leave packages/domain/src: ../../../database/src/index.ts",
      "packages/domain/src/nested/package.json package resolution target cannot leave packages/domain/src: ../../../contracts/src/index.ts",
    ],
  );
  assert.deepEqual(
    boundaries.findDomainManifestConfigurationErrors(
      {
        main: "..\\\\..\\\\..\\\\database\\\\src\\\\index.ts",
        types: "C:\\\\outside\\\\index.ts",
        typings: "file:///outside/index.ts",
      },
      "/repo/packages/domain/src/nested",
      "/repo/packages/domain",
    ),
    [
      "packages/domain/src/nested/package.json package resolution target cannot leave packages/domain/src: ..\\\\..\\\\..\\\\database\\\\src\\\\index.ts",
      "packages/domain/src/nested/package.json package resolution target cannot leave packages/domain/src: C:\\\\outside\\\\index.ts",
      "packages/domain/src/nested/package.json package resolution target cannot leave packages/domain/src: file:///outside/index.ts",
    ],
  );
  assert.deepEqual(
    boundaries.findDomainManifestConfigurationErrors(
      { exports: "./src/index.ts", types: "./src/index.ts" },
      "/repo/packages/domain",
      "/repo/packages/domain",
    ),
    [],
  );
  assert.deepEqual(
    boundaries.findDomainManifestConfigurationErrors(
      { browser: { "./src/index.ts": "../../../database/src/index.ts" } },
      "/repo/packages/domain/src/nested",
      "/repo/packages/domain",
    ),
    [
      "packages/domain/src/nested/package.json package resolution target cannot leave packages/domain/src: ../../../database/src/index.ts",
    ],
  );
  assert.deepEqual(
    boundaries.findDomainManifestConfigurationErrors(
      { browser: { "./src/index.ts": "react" } },
      "/repo/packages/domain",
      "/repo/packages/domain",
    ),
    ["packages/domain/package.json browser target must be a relative domain source path: react"],
  );
}

assert.equal(typeof boundaries.collectDomainPackageManifestFiles, "function");
if (boundaries.collectDomainPackageManifestFiles) {
  const entries = new Map([
    [
      "/repo/packages/domain/src",
      [
        { name: "feature", isDirectory: () => true, isSymbolicLink: () => false },
        { name: "index.ts", isDirectory: () => false, isSymbolicLink: () => false },
      ],
    ],
    [
      "/repo/packages/domain/src/feature",
      [
        { name: "package.json", isDirectory: () => false, isSymbolicLink: () => false },
        { name: "rules.ts", isDirectory: () => false, isSymbolicLink: () => false },
      ],
    ],
  ]);
  assert.deepEqual(
    boundaries.collectDomainPackageManifestFiles(
      "/repo/packages/domain/src",
      (directory) => entries.get(directory) ?? [],
    ),
    ["/repo/packages/domain/src/feature/package.json"],
  );
}

assert.equal(typeof boundaries.collectDomainSourceFiles, "function");
if (boundaries.collectDomainSourceFiles) {
  const errors = [];
  const files = boundaries.collectDomainSourceFiles("/repo/packages/domain/src", errors, () => [
    {
      name: "linked.ts",
      isDirectory: () => false,
      isSymbolicLink: () => true,
    },
  ]);
  assert.deepEqual(files, []);
  assert.deepEqual(errors, ["Symbolic links are not allowed in packages/domain source: linked.ts"]);

  const rootErrors = [];
  const rootFiles = boundaries.collectDomainSourceFiles(
    "/repo/packages/domain/src",
    rootErrors,
    () => [],
    "/repo/packages/domain/src",
    () => true,
  );
  assert.deepEqual(rootFiles, []);
  assert.deepEqual(rootErrors, ["Symbolic links are not allowed in packages/domain source: ."]);

  const javascriptErrors = [];
  const javascriptFiles = boundaries.collectDomainSourceFiles(
    "/repo/packages/domain/src",
    javascriptErrors,
    () => [
      {
        name: "unchecked.js",
        isDirectory: () => false,
        isSymbolicLink: () => false,
      },
    ],
  );
  assert.deepEqual(javascriptFiles, ["/repo/packages/domain/src/unchecked.js"]);
  assert.deepEqual(javascriptErrors, [
    "JavaScript source is not allowed in packages/domain because it bypasses the strict TypeScript check: unchecked.js",
  ]);
}

console.log("Workspace boundary matcher tests passed.");
