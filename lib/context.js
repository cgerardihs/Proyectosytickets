// Contexto por request (request id, usuario, transacción en curso) sin pasarlo por parámetro.
import { AsyncLocalStorage } from 'node:async_hooks';

export const als = new AsyncLocalStorage();
export const ctx = () => als.getStore() || {};
