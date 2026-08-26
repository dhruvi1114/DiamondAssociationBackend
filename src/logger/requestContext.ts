import { AsyncLocalStorage } from 'async_hooks';
import type { ActorType } from '@constant/audit.constant';

export interface RequestContext {
  requestId: string;
  actorType?: ActorType;
  actorId?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

/**
 * Carries the request id (and actor, once authentication has run) through every
 * async hop of a request so `logger.info('…')` deep inside a service still
 * lands on the right correlation id without threading a logger through every
 * function signature (observability.md §2).
 */
export const runWithRequestContext = <T>(context: RequestContext, callback: () => T): T =>
  storage.run(context, callback);

export const getRequestContext = (): RequestContext | undefined => storage.getStore();

/** Attach the actor to the in-flight context once authentication has resolved it. */
export const setContextActor = (actorType: ActorType, actorId?: string): void => {
  const context = storage.getStore();

  if (context) {
    context.actorType = actorType;
    context.actorId = actorId;
  }
};
