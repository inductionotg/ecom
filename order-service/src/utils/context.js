import { AsyncLocalStorage } from 'node:async_hooks';

export const contextStorage = new AsyncLocalStorage();

export const getCorrelationId = () => {
  const store = contextStorage.getStore();
  return store?.correlationId || 'system-no-id';
};