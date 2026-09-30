# @sold/extension-sdk changelog

The SDK is a public, versioned API (SemVer). Deprecations warn for at least one minor version before removal; removals only
happen in a major version. Below 1.0.0, minor versions may make breaking changes, and each one is listed here.

## 0.1.0

Initial API: `defineExtension`, `defineBlock`, `defineJob`; observers, interceptors (with the hot-path contract), settings,
permissions, routes, pages, admin screens, blocks, slots, services, jobs and schedules, reporting views, lifecycle hooks;
re-exports of `zod` and Drizzle's Postgres helpers so extensions share Base's single instances.
Events: `cart.updated`, `order.placed`, `payment.captured`. Hooks: `cart.item.adding`, `checkout.placing`.
Services: `pricing.rounding`.
