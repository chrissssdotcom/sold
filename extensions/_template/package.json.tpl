{
  "name": "@sold-ext/__NAME__",
  "version": "0.1.0",
  "description": "__TITLE__",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "lint": "eslint .",
    "test": "vitest run"
  },
  "dependencies": {
    "@sold/extension-sdk": "workspace:*"
  },
  "devDependencies": {
    "@sold/config": "workspace:*",
    "@types/react": "^19.3.0",
    "react": "^19.3.0",
    "vitest": "^5.0.3"
  },
  "sold": {
    "requires": {
      "base": "__BASE_RANGE__"
    }
  }
}
