// @ts-ignore resolved by the worker Rollup pipeline.
import asyncHooks from "node-core:async_hooks";

export const AsyncLocalStorage = asyncHooks.AsyncLocalStorage;
export const AsyncResource = asyncHooks.AsyncResource;
export const createHook = asyncHooks.createHook;
export const executionAsyncId = asyncHooks.executionAsyncId;
export const executionAsyncResource = asyncHooks.executionAsyncResource;
export const triggerAsyncId = asyncHooks.triggerAsyncId;

export default asyncHooks as typeof import("node:async_hooks");
