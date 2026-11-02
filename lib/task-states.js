// Estados de las tareas y subtareas (v1.15): Standby, En curso, Test y Finalizada.
// Las etapas (épicas) siguen con el flujo del proyecto (Backlog, Análisis, Desarrollo…). Cada tarea guarda su estado propio
// en issues.task_state y, además, un estado del flujo equivalente en issues.status_id: así el avance, el portfolio, el
// Finalizado automático, el cierre de ciclo con los tickets, los sprints y la API siguen funcionando igual que antes.

export const TASK_STATES = ['standby', 'in_progress', 'test', 'done'];
export const TASK_STATE_LABEL = { standby: 'Standby', in_progress: 'En curso', test: 'Test', done: 'Finalizada' };
/** Tipo de estado del flujo que le corresponde a cada estado de tarea. */
export const TASK_STATE_KIND = { standby: 'todo', in_progress: 'doing', test: 'doing', done: 'done' };

// Estados del flujo que equivalen a "Test" (Testing, En revisión, Pruebas…) y a "En curso" (En curso, Desarrollo…).
// Mantener alineado con TASK_STATE_FROM_STATUS_SQL.
const TEST_RE = /test|prueba|revisi/i;
const CURSO_RE = /curso|desarrollo|progreso/i;

/** Estado de tarea que corresponde a un estado del flujo ({ kind, name }). */
export function stateFromStatus(s) {
  if (!s) return 'standby';
  if (s.kind === 'done') return 'done';
  if (s.kind === 'doing') return TEST_RE.test(s.name || '') ? 'test' : 'in_progress';
  return 'standby';
}

/**
 * Estado del flujo para guardar junto con un estado de tarea. Si el actual ya le corresponde, se mantiene (no se pisa, por
 * ejemplo, Análisis por Desarrollo al pasar a En curso). Si el flujo no tiene un estado de ese tipo, queda el actual.
 */
export function statusForState(statuses, state, currentId = null) {
  const sorted = [...statuses].sort((a, b) => a.sort - b.sort || a.id - b.id);
  const cur = sorted.find((s) => s.id === currentId);
  if (cur && stateFromStatus(cur) === state) return cur.id;
  const same = sorted.filter((s) => s.kind === TASK_STATE_KIND[state]);
  if (!same.length) return currentId;
  if (state === 'test') return (same.find((s) => TEST_RE.test(s.name)) || same[same.length - 1]).id;
  if (state === 'in_progress') return (same.find((s) => CURSO_RE.test(s.name)) || same.find((s) => !TEST_RE.test(s.name)) || same[0]).id;
  return same[0].id;
}

/** SQL que calcula el estado de tarea a partir del estado del flujo (alias ps). Igual que stateFromStatus. */
export const TASK_STATE_FROM_STATUS_SQL = `case when ps.kind='done' then 'done'
  when ps.kind='doing' and ps.name ~* '(test|prueba|revisi)' then 'test'
  when ps.kind='doing' then 'in_progress' else 'standby' end`;
