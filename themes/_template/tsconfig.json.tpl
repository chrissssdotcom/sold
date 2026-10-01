{
  "extends": "@sold/config/tsconfig.base.json",
  "compilerOptions": {
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "jsx": "preserve",
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["**/*.ts", "**/*.tsx", "**/*.d.ts"]
}
