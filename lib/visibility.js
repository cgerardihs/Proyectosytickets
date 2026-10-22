// Visibilidad de tickets. Desde la v1.9 no hay grupos: todos los agentes ven todos los tickets.
// Se mantienen estas funciones (siempre permiten) para no tocar cada consulta que las usa.

/** Todos los usuarios de la mesa ven todos los tickets. */
export const seesAllTickets = () => true;

/** Condición SQL de visibilidad: sin restricciones. */
export const visibleTicketsSql = () => 'true';

/** ¿El usuario puede ver este ticket? Siempre (no hay grupos privados). */
export async function canSeeTicket() {
  return true;
}
