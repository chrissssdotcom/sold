import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Also runs the dependency-free Terraform plan tag checker that lives with the Terraform code.
    include: ['src/**/*.test.ts', '../../ops/terraform/scripts/*.test.ts'],
    // Git-fixture tests spawn real `git`; give them room on slow CI runners.
    testTimeout: 30_000,
  },
});
