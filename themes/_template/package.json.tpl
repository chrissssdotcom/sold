{
  "name": "@sold-theme/__NAME__",
  "version": "0.1.0",
  "description": "__TITLE__",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./index.ts"
  },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "lint": "eslint ."
  },
  "dependencies": {
    "@sold/storefront": "workspace:*"
  },
  "devDependencies": {
    "@sold/config": "workspace:*",
    "@types/react": "^19.3.0",
    "next": "^16.3.7",
    "react": "^19.3.0"
  }
}
