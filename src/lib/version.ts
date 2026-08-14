// UI-facing build identity, resolved from the compile-time globals injected by
// Vite (see shared/version.ts + the vite configs). The `typeof` guards keep this
// from throwing a ReferenceError if the app is ever loaded without the define
// pass (e.g. a bare unit test), falling back to dev placeholders.
export const VERSION = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.0.0'
export const COMMIT = typeof __GIT_COMMIT__ !== 'undefined' ? __GIT_COMMIT__ : 'dev'
export const BUILD_DATE = typeof __BUILD_DATE__ !== 'undefined' ? __BUILD_DATE__ : ''
